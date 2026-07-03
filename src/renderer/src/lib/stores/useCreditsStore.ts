/**
 * useCreditsStore — Phase 13 Plan 16 renderer-side credits state.
 *
 * Single source of truth for the credits UI (% bar, pricing icon, hard-stop
 * modal, settings row). Mirrors `useSyncStore.ts` (the gold-standard template)
 * — `interface FooState + FooActions + idempotent init() + push-seq race guard`.
 *
 * Push-seq race guard (lines 64-83 of useSyncStore.ts in spirit):
 *   The renderer subscribes to `onCreditsStatusUpdate` BEFORE awaiting the
 *   initial `creditsGet()` seed. Without this, a push that arrives during the
 *   await would be overwritten by the older snapshot. `pushSeq` increments on
 *   every push; the seed only applies if `pushSeq === seqBefore`, i.e. no push
 *   fired during the await.
 *
 * State-shape invariants (must_haves):
 *   - NO token/dollar/micro fields — PROXY-05 bright-line. The proxy ships
 *     `X-Sei-Remaining-Pct` to the renderer; raw ledger units stay server-side.
 *   - `hardStopActive` is set ONLY by an explicit `onCreditsHardStop` push —
 *     never derived from `remaining_pct === 0` in render. Explicit semantics
 *     so a stale-but-zero seed doesn't spuriously trigger the modal.
 *   - `rateLimitedUntil` is a ms-epoch only; the banner component owns the
 *     1Hz `setInterval` for the countdown so the store doesn't re-render every
 *     second (T-13-16-04 disposition).
 *
 * Server-side semantics:
 *   - `acknowledgeHardStop()` clears LOCAL UI state only — it does NOT call
 *     the server. The server's view of the user's balance/rate-bucket is
 *     unchanged; this just dismisses the modal so the user can keep typing
 *     (their next call will either succeed or re-trigger the hard-stop push).
 *
 * Boot wiring: `App.tsx` calls `useCreditsStore.getState().init()` on mount
 * when `ai_backend_kind === 'cloud-proxy'`. Idempotent — safe to call
 * multiple times.
 *
 * Sources:
 *   - 13-16-PLAN.md (this plan)
 *   - 13-PATTERNS.md §useCreditsStore (gold-standard pointer)
 *   - src/renderer/src/lib/stores/useSyncStore.ts (template — push-seq guard)
 *   - src/shared/ipc.ts (CreditsStatus, CreditsHardStopEvent contract)
 */

import { create, type StoreApi } from 'zustand';
import type { CreditsStatus, CreditsHardStopEvent } from '@shared/ipc';
import { sei } from '../ipcClient';

type HardStopReason = CreditsHardStopEvent['reason'];

/**
 * quick/260525-sbo Task 6 — pure transition predicate for the ReceiptScreen
 * auto-navigate side-effect. Returns true iff `prev` is a non-'unlimited'
 * value (including null = cold-load was treated as "no prior plan") AND
 * `next` is 'unlimited'.
 *
 * Critically, `null → unlimited` returns FALSE: a cold-loaded user who is
 * already subscribed must NOT see the receipt on every app start. Only a
 * GENUINE transition (we observed them as non-unlimited, then they became
 * unlimited) qualifies as a subscription activation event worth surfacing.
 *
 * Exported so the unit test can exercise the predicate in isolation without
 * mocking useUiStore (and avoiding the lazy-import / circular-dep dance).
 */
export function shouldNavigateToReceipt(
  prev: CreditsStatus['plan'] | null,
  next: CreditsStatus['plan'],
): boolean {
  if (next !== 'unlimited') return false;
  if (prev === null) return false; // cold-load is not a transition
  if (prev === 'unlimited') return false; // already unlimited; idle re-push
  return true;
}

/**
 * Module-level previous-plan ref. Lives outside the store factory so it
 * persists across set() updates AND survives the lazy import done by the
 * navigate side-effect without becoming part of the React-subscribable
 * state shape. The shouldNavigateToReceipt() helper above is the pure data
 * function; this ref is the impure execution-context anchor.
 */
let prevPlanForReceipt: CreditsStatus['plan'] | null = null;

/**
 * Checkout-watch tuning. After the user is sent to the hosted checkout in their
 * system browser, the credits screen shows a "complete your purchase" modal and
 * polls `creditsGet` at a high frequency until the webhook-driven grant lands —
 * the standard "waiting for an out-of-band payment" pattern. The poll is capped
 * by a wall-clock timeout so it never runs forever; after that, the
 * focus-refetch backstop (init()) and the in-game push channel still catch a
 * late completion. Exported for the unit tests.
 */
export const CHECKOUT_POLL_INTERVAL_MS = 2_500;
export const CHECKOUT_MAX_WAIT_MS = 180_000; // 3 minutes
/**
 * After a checkout is initiated, re-read credits whenever the app window regains
 * focus for this long — the edge case where the user dismisses the modal, pays
 * in the browser anyway, then tabs back to the app.
 */
export const CHECKOUT_FOCUS_REFETCH_WINDOW_MS = 30 * 60_000; // 30 minutes

/** Pre-checkout snapshot used to detect that a purchase landed. */
type CheckoutBaseline = {
  remaining_tokens: number;
  plan: CreditsStatus['plan'];
  subscription_status_raw: CreditsStatus['subscription_status_raw'];
};

// Module-level timer/baseline refs — kept OUT of the React-subscribable state
// (like prevPlanForReceipt) so they survive set() and are never render inputs.
let checkoutPollTimer: ReturnType<typeof setInterval> | null = null;
let checkoutMaxTimer: ReturnType<typeof setTimeout> | null = null;
let checkoutBaseline: CheckoutBaseline | null = null;
let lastBillingActionAt = 0;

// Monotonic load epoch. Bumped on every reset() — i.e. on every auth/scope
// transition that re-points which profile the store reflects. init()/refresh()
// capture the epoch BEFORE their async creditsGet() and discard the result if
// the epoch advanced while the read was in flight. Without this, the credits
// init() fired by the SYNCHRONOUS signed_in push (which reads the OLD scope's
// ai_backend_kind, before the async profile-scope switch has written the
// cloud-proxy billing default) can resolve AFTER the scope-changed refresh and
// clobber it back to a stale 'local' — landing a freshly signed-in user on
// local mode. The epoch makes the LAST-initiated read authoritative regardless
// of which creditsGet() resolves first.
let loadEpoch = 0;

/**
 * 260703: read `ai_backend_kind` straight from the persisted UserConfig. The
 * credits snapshot (creditsGet) can fail transiently (offline ledger read,
 * IPC hiccup) — but the backend kind is a LOCAL config fact, and it gates the
 * Settings ACCOUNT MODE surface + the credits UI. If a failed seed left the
 * INITIAL 'local' in place while the actual calls ran cloud-proxy, the UI
 * claimed BYOK while spending cloud credits. Null on failure → caller keeps
 * the current value.
 */
async function readBackendKindFromConfig(): Promise<CreditsStatus['ai_backend_kind'] | null> {
  try {
    const cfg = await sei.getConfig();
    return cfg?.ai_backend_kind === 'cloud-proxy' ? 'cloud-proxy' : 'local';
  } catch {
    return null;
  }
}

function clearCheckoutTimers(): void {
  if (checkoutPollTimer !== null) {
    clearInterval(checkoutPollTimer);
    checkoutPollTimer = null;
  }
  if (checkoutMaxTimer !== null) {
    clearTimeout(checkoutMaxTimer);
    checkoutMaxTimer = null;
  }
}

/**
 * Pure predicate: did a purchase of `kind` land, comparing the pre-checkout
 * `baseline` snapshot to the latest `current` one?
 *
 *   - 'resume': the cancel-scheduled sub is no longer set to cancel — its status
 *     flips off 'cancelled' (back to 'active'). No new credits land, so the
 *     token/plan checks below don't apply.
 *   - A credit top-up (pack OR subscription grant) raises the remaining-tokens
 *     estimate, so a strictly-higher `remaining_tokens` confirms ANY purchase.
 *   - A subscription additionally flips plan→'unlimited' / status→'active',
 *     a faster, clearer signal for Party even before the grant total re-sums.
 *
 * Exported so the unit test can exercise it in isolation.
 */
export function isPurchaseConfirmed(
  kind: 'pack' | 'subscription' | 'resume',
  baseline: CheckoutBaseline,
  current: {
    remaining_tokens?: number;
    plan: CreditsStatus['plan'];
    subscription_status_raw: CreditsStatus['subscription_status_raw'];
  },
): boolean {
  if (kind === 'resume') {
    return (
      baseline.subscription_status_raw === 'cancelled' &&
      current.subscription_status_raw !== 'cancelled'
    );
  }
  if (kind === 'subscription') {
    if (current.plan === 'unlimited' && baseline.plan !== 'unlimited') return true;
    if (
      current.subscription_status_raw === 'active' &&
      baseline.subscription_status_raw !== 'active'
    ) {
      return true;
    }
  }
  return (current.remaining_tokens ?? 0) > baseline.remaining_tokens;
}

/**
 * Shared poll + wall-clock-timeout for the checkout / resume watch. The caller
 * has already captured `checkoutBaseline`, set checkoutStatus='waiting', and
 * opened the relevant browser surface (hosted checkout or customer portal).
 * Polls creditsGet until isPurchaseConfirmed(kind,…) fires or the cap elapses.
 */
function startCheckoutWatch(
  kind: 'pack' | 'subscription' | 'resume',
  get: StoreApi<CreditsState & CreditsActions>['getState'],
  set: StoreApi<CreditsState & CreditsActions>['setState'],
): void {
  checkoutPollTimer = setInterval(() => {
    void (async () => {
      await get().refresh();
      if (checkoutBaseline && isPurchaseConfirmed(kind, checkoutBaseline, get())) {
        clearCheckoutTimers();
        set({ checkoutStatus: 'confirmed' });
      }
    })();
  }, CHECKOUT_POLL_INTERVAL_MS);

  // Wall-clock cap so polling never runs forever. After this the focus-refetch
  // backstop + the in-game push channel still catch a late completion.
  checkoutMaxTimer = setTimeout(() => {
    if (checkoutPollTimer !== null) {
      clearInterval(checkoutPollTimer);
      checkoutPollTimer = null;
    }
    checkoutMaxTimer = null;
    if (get().checkoutStatus === 'waiting') set({ checkoutStatus: 'timeout' });
  }, CHECKOUT_MAX_WAIT_MS);
}

interface CreditsState {
  /**
   * 0..100, rounded to REMAINING_PCT_ROUND_STEP server-side. This is balance
   * vs the DAILY cap — kept for HardStopModal's auto-dismiss gate and the
   * IconRail PricingIcon arc. The primary usage display uses `usage_pct`.
   */
  remaining_pct: number;
  /**
   * 260602-hbr: usage as a percent of total available credits (used/available),
   * 0% on a fresh grant, growing to 100% as credits are spent. Drives the
   * UsageBar progress fill. PROXY-05: percent only — no token/dollar units.
   */
  usage_pct: number;
  /** ITEM 4: server-supplied remaining-tokens count (undefined during rollout / cold-load). */
  remaining_tokens?: number;
  /**
   * Lifetime spend / total granted in USD (dollar form of usage_pct). main
   * computes these from ledger micros. Deliberately past the PROXY-05 percent-
   * only line at the owner's request; drives the UsageBar tooltip "$used/$total".
   * undefined for local/BYOK or before the first seed.
   */
  used_usd?: number;
  total_usd?: number;
  plan: CreditsStatus['plan'];
  renews_at: string | null;
  /**
   * ISO end date when the subscription is cancel-scheduled ("to be cancelled")
   * but still active. Drives the "Subscription will end {date}" line + Resume
   * CTA. null for auto-renewing subscribers and non-subscribers.
   */
  ends_at: string | null;
  trial_claimed: boolean;
  ai_backend_kind: CreditsStatus['ai_backend_kind'];
  /**
   * quick/260525-sbo Task 8 — raw LS subscription status passthrough.
   * SettingsScreen renders contextual banners (past-due, paused) by reading
   * this directly. null on no-session / never-subscribed / cold-load before
   * the seed lands.
   */
  subscription_status_raw: CreditsStatus['subscription_status_raw'];
  /**
   * Set ONLY by an explicit `onCreditsHardStop` push — never computed from
   * `remaining_pct === 0`. Drives HardStopModal mounting in App.tsx.
   */
  hardStopActive: boolean;
  hardStopReason: HardStopReason | null;
  /**
   * ms-epoch when the rate-limit window ends; banner component reads this and
   * runs its own setInterval(1000) for the countdown. Store never holds the
   * countdown value itself (would trigger 1Hz re-renders).
   */
  rateLimitedUntil: number | null;
  /**
   * Checkout-watch state for the "complete your purchase in your browser" modal.
   *   - 'idle'      → no modal
   *   - 'waiting'   → browser checkout open; polling creditsGet for the grant
   *   - 'confirmed' → the grant landed (credits updated)
   *   - 'timeout'   → polling gave up; the focus-refetch backstop takes over
   */
  checkoutStatus: 'idle' | 'waiting' | 'confirmed' | 'timeout';
  /** Which billing action the in-flight watch is for (drives modal copy). */
  checkoutKind: 'pack' | 'subscription' | 'resume' | null;
  initialized: boolean;
  loading: boolean;
  /**
   * Push-seq race guard counter. Bumped on every onCreditsStatusUpdate push.
   * `init()` captures the pre-await value; if any push lands during the
   * await, the seed's `set()` is skipped (push state is strictly newer).
   * Mirrors useSyncStore.ts:77-91.
   */
  pushSeq: number;
  /** Returned by onCreditsStatusUpdate(cb) — invoked in reset(). */
  unsubStatus?: () => void;
  /** Returned by onCreditsHardStop(cb) — invoked in reset(). */
  unsubHardStop?: () => void;
  /** Removes the window-focus refetch backstop listener — invoked in reset(). */
  unsubFocus?: () => void;
}

interface CreditsActions {
  /** Idempotent boot wiring. Subscribes FIRST, then seeds via creditsGet. */
  init: () => Promise<void>;
  /** Re-fetch the snapshot and replace state. */
  refresh: () => Promise<void>;
  /**
   * Claim the one-time free trial (CreditsScreen Trial card "Claim" button).
   *
   * SECURITY: this performs NO client-side grant. It calls the Supabase
   * `trial-claim` Edge Function (via sei.trialClaim), which is the sole grant
   * authority — `ledger_grants` has no INSERT RLS policy (service_role writes
   * only), the grant is JWT-identified (never body-supplied), and a partial
   * UNIQUE index caps it at one trial per user. A user poking this from the
   * dev console can at most re-trigger an idempotent no-op. After the call we
   * refresh() so `trial_claimed` / the balance reflect the server's truth.
   *
   * The trial is bound to the account UUID (derived server-side from the
   * session JWT) — no arguments. Returns a typed result so the card can surface
   * a transient state without inventing client-trusted claim status.
   */
  claimTrial: () => Promise<{ ok: true } | { ok: false; code: string }>;
  /** Open the Polar checkout for the given product (proxy-minted session). */
  openCheckout: (kind: 'pack' | 'subscription') => Promise<void>;
  /**
   * Open the hosted checkout for `kind` AND watch for the webhook-driven grant:
   * shows the "complete your purchase" modal and polls creditsGet at high
   * frequency (capped by CHECKOUT_MAX_WAIT_MS) until the credits land. Pass
   * `{ alreadyOpened: true }` when an earlier step (the Party consent modal)
   * already launched the browser, so checkout isn't opened twice.
   */
  beginPurchase: (
    kind: 'pack' | 'subscription',
    opts?: { alreadyOpened?: boolean },
  ) => Promise<void>;
  /**
   * Resume a to-be-cancelled subscription: opens the Polar customer portal
   * (where Polar's uncancel lives) AND watches — same modal + polling as
   * beginPurchase, but completion = the subscription flips off 'cancelled'
   * (no new credits), and it never starts a new checkout.
   */
  beginResume: () => Promise<void>;
  /** Dismiss the checkout modal and stop polling (the browser action continues). */
  dismissCheckout: () => void;
  /**
   * Open the customer-portal URL so the user can cancel their subscription.
   * ITEM 8 (quick/260523-t8d): returns the typed result so callers can
   * surface a fallback toast if the proxy can't find a portal URL.
   */
  cancelSubscription: () => Promise<{ ok: true; portalUrl: string } | { ok: false; code: string }>;
  /**
   * Clears the hard-stop modal locally. Does NOT call the server — the
   * server's balance/rate-bucket view is unchanged; the next proxied call
   * will either succeed or re-trigger the push.
   */
  acknowledgeHardStop: () => void;
  /** Tears down subscriptions and returns to the initial state. */
  reset: () => void;
}

const INITIAL: Omit<CreditsState, 'unsubStatus' | 'unsubHardStop' | 'unsubFocus'> = {
  remaining_pct: 0,
  usage_pct: 0,
  remaining_tokens: undefined,
  used_usd: undefined,
  total_usd: undefined,
  plan: 'depleted',
  renews_at: null,
  ends_at: null,
  trial_claimed: false,
  ai_backend_kind: 'local',
  subscription_status_raw: null,
  hardStopActive: false,
  hardStopReason: null,
  rateLimitedUntil: null,
  checkoutStatus: 'idle',
  checkoutKind: null,
  initialized: false,
  loading: false,
  pushSeq: 0,
};

// 260617: once a subscription goes active, proactively clear any persisted
// daily-play-limit block (UserConfig.daily_limited_until) so a user who just
// upgraded past the trial cap is not still blocked at the summon gate. Writes
// only when the flag is set, and at most once per app session.
let clearedDailyForActive = false;
async function clearDailyLimitOnSubscription(): Promise<void> {
  if (clearedDailyForActive) return;
  clearedDailyForActive = true;
  try {
    const cfg = await sei.getConfig();
    if (cfg?.daily_limited_until) {
      await sei.saveConfig({ ...cfg, daily_limited_until: null });
    }
  } catch {
    clearedDailyForActive = false; // transient IPC failure — allow a later retry
  }
}

export const useCreditsStore = create<CreditsState & CreditsActions>((set, get) => ({
  ...INITIAL,

  init: async (): Promise<void> => {
    if (get().initialized) return;

    // 1. Subscribe FIRST (useSyncStore race-guard pattern: lines 77-91).
    const unsubStatus = sei.onCreditsStatusUpdate((status) => {
      set((s) => ({
        ...s,
        remaining_pct: status.remaining_pct,
        usage_pct: status.usage_pct ?? 0,
        remaining_tokens: status.remaining_tokens,
        used_usd: status.used_usd,
        total_usd: status.total_usd,
        plan: status.plan,
        renews_at: status.renews_at,
        ends_at: status.ends_at,
        trial_claimed: status.trial_claimed,
        ai_backend_kind: status.ai_backend_kind,
        // quick/260525-sbo Task 8: pass through raw LS status for the
        // SettingsScreen contextual banner.
        subscription_status_raw: status.subscription_status_raw ?? null,
        pushSeq: s.pushSeq + 1,
      }));
      // quick/260525-sbo Task 6: detect non-unlimited → unlimited transition
      // and navigate to ReceiptScreen exactly once (FTC 16 CFR §425.5
      // in-app receipt surface). prevPlanForReceipt is a module-level ref
      // that persists across pushes; shouldNavigateToReceipt is the pure
      // transition predicate.
      if (shouldNavigateToReceipt(prevPlanForReceipt, status.plan)) {
        // Lazy import to avoid a circular dep on useUiStore.
        void import('./useUiStore').then(({ useUiStore }) => {
          useUiStore.getState().navigate({ kind: 'receipt' });
        });
      }
      prevPlanForReceipt = status.plan;
      // Clear a stale daily-limit block once the account is a subscriber.
      if (status.subscription_status_raw === 'active') {
        void clearDailyLimitOnSubscription();
      }
    });
    const unsubHardStop = sei.onCreditsHardStop((info) => {
      set({
        hardStopActive: true,
        hardStopReason: info.reason,
        rateLimitedUntil:
          info.reason === 'rate_limited' && info.retry_after_seconds
            ? Date.now() + info.retry_after_seconds * 1000
            : null,
      });
    });

    // Focus backstop for the "dismissed the modal, paid in the browser anyway,
    // tabbed back" edge case: re-read credits when the window regains focus,
    // but only within a window after a checkout was initiated (so we don't
    // refetch on every unrelated focus). The in-modal poll handles the common
    // case where the purchase completes while the modal is still open.
    const onWindowFocus = (): void => {
      if (Date.now() - lastBillingActionAt < CHECKOUT_FOCUS_REFETCH_WINDOW_MS) {
        void get().refresh();
      }
    };
    const canListen =
      typeof window !== 'undefined' && typeof window.addEventListener === 'function';
    if (canListen) {
      window.addEventListener('focus', onWindowFocus);
    }
    const unsubFocus = (): void => {
      if (canListen) window.removeEventListener('focus', onWindowFocus);
    };

    set({ unsubStatus, unsubHardStop, unsubFocus });

    // 2. Seed; skip applying if a push arrived during the await, OR if a
    //    reset() (auth/scope transition) superseded this load while it was in
    //    flight (loadEpoch — see its declaration).
    const seqBefore = get().pushSeq;
    const epochBefore = loadEpoch;
    set({ loading: true });
    try {
      const status = await sei.creditsGet();
      if (loadEpoch !== epochBefore) return; // superseded by a newer scope
      if (get().pushSeq === seqBefore) {
        set({
          remaining_pct: status.remaining_pct,
          usage_pct: status.usage_pct ?? 0,
          remaining_tokens: status.remaining_tokens,
        used_usd: status.used_usd,
        total_usd: status.total_usd,
          plan: status.plan,
          renews_at: status.renews_at,
          ends_at: status.ends_at,
          trial_claimed: status.trial_claimed,
          ai_backend_kind: status.ai_backend_kind,
          subscription_status_raw: status.subscription_status_raw ?? null,
          initialized: true,
          loading: false,
        });
        // quick/260525-sbo Task 6: seed prevPlanForReceipt so the FIRST
        // push after a cold-load isn't treated as a transition. Without
        // this, an already-subscribed user would see ReceiptScreen on
        // every app start (prev=null + first push reports 'unlimited'
        // would be classified as a transition by the predicate if we
        // didn't pre-set it here). The seed plan IS the prior plan from
        // the store's perspective — the next push is the first that
        // could be a real transition.
        prevPlanForReceipt = status.plan;
      } else {
        // Push won — keep its values, just flip flags.
        set({ initialized: true, loading: false });
        // The push handler already updated prevPlanForReceipt as a
        // side-effect — nothing to do here.
      }
    } catch {
      // Transient IPC failure: leave the store at defaults, mark initialized
      // so we don't busy-retry. The next push (or a manual refresh) will
      // re-populate. 260703: EXCEPT ai_backend_kind — the INITIAL 'local'
      // must not stand in for a cloud-proxy profile (the UI would claim BYOK
      // while every LLM call reads config.json and spends cloud credits), so
      // seed it from the local config, which doesn't need the ledger.
      const kind = await readBackendKindFromConfig();
      if (loadEpoch !== epochBefore) return; // superseded by a newer scope
      set({
        initialized: true,
        loading: false,
        ...(kind !== null ? { ai_backend_kind: kind } : {}),
      });
    }
  },

  refresh: async (): Promise<void> => {
    const epochBefore = loadEpoch;
    set({ loading: true });
    try {
      const status = await sei.creditsGet();
      if (loadEpoch !== epochBefore) return; // superseded by a scope transition
      set({
        remaining_pct: status.remaining_pct,
        usage_pct: status.usage_pct ?? 0,
        remaining_tokens: status.remaining_tokens,
        used_usd: status.used_usd,
        total_usd: status.total_usd,
        plan: status.plan,
        renews_at: status.renews_at,
        ends_at: status.ends_at,
        trial_claimed: status.trial_claimed,
        ai_backend_kind: status.ai_backend_kind,
        subscription_status_raw: status.subscription_status_raw ?? null,
        loading: false,
      });
    } catch {
      // 260703: same backend-kind backstop as init() — a failed snapshot must
      // not leave a stale/incorrect mode on the ACCOUNT MODE surface.
      const kind = await readBackendKindFromConfig();
      if (loadEpoch !== epochBefore) return; // superseded by a scope transition
      set({ loading: false, ...(kind !== null ? { ai_backend_kind: kind } : {}) });
    }
  },

  claimTrial: async (): Promise<{ ok: true } | { ok: false; code: string }> => {
    // The trial is bound to the account UUID (derived server-side from the
    // session JWT) — no username is needed. The Edge Function enforces the
    // one-trial-per-account cap via the ledger_grants partial UNIQUE index.
    const res = await sei.trialClaim();

    // Success + the "Claimed" button state are derived from the SERVER snapshot
    // (a kind='trial' ledger_grants row → `trial_claimed`), NOT from
    // trialClaim's balance-delta heuristic. The delta read can race the
    // just-committed grant (read-after-
    // write lag) and report a real claim as "already claimed", which previously
    // left the button stuck on "Claim" and the gauge stale. Refresh and trust
    // `trial_claimed`; retry once after a short delay to absorb that lag so the
    // grant (balance → "~Xh left") and the flag both land.
    await get().refresh();
    if (get().trial_claimed) return { ok: true };
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    await get().refresh();
    if (get().trial_claimed) return { ok: true };

    // Still not reflected: surface trialClaim's code (already_claimed / network)
    // so the card can show an honest note. A 2xx-but-not-visible falls through
    // as 'network' (transient) rather than a misleading "already claimed".
    return { ok: false, code: res.ok ? 'network' : res.code };
  },

  openCheckout: async (kind): Promise<void> => {
    await sei.creditsOpenCheckout(kind);
  },

  beginPurchase: async (kind, opts): Promise<void> => {
    // Restart cleanly if a previous watch is somehow still live.
    clearCheckoutTimers();
    const s = get();
    checkoutBaseline = {
      remaining_tokens: s.remaining_tokens ?? 0,
      plan: s.plan,
      subscription_status_raw: s.subscription_status_raw,
    };
    lastBillingActionAt = Date.now();
    set({ checkoutStatus: 'waiting', checkoutKind: kind });

    // Open the hosted checkout in the system browser unless an earlier step
    // (the Party consent modal) already launched it.
    if (!opts?.alreadyOpened) {
      await get().openCheckout(kind);
    }
    startCheckoutWatch(kind, get, set);
  },

  beginResume: async (): Promise<void> => {
    clearCheckoutTimers();
    const s = get();
    checkoutBaseline = {
      remaining_tokens: s.remaining_tokens ?? 0,
      plan: s.plan,
      subscription_status_raw: s.subscription_status_raw,
    };
    lastBillingActionAt = Date.now();
    set({ checkoutStatus: 'waiting', checkoutKind: 'resume' });

    // Open the Polar customer portal (Polar's uncancel/resume surface). Reuses
    // cancelSubscription, which is the portal opener (manage / cancel / resume).
    await get().cancelSubscription();
    startCheckoutWatch('resume', get, set);
  },

  dismissCheckout: (): void => {
    clearCheckoutTimers();
    set({ checkoutStatus: 'idle', checkoutKind: null });
  },

  cancelSubscription: async (): Promise<{ ok: true; portalUrl: string } | { ok: false; code: string }> => {
    // Opens the Polar customer portal (manage / cancel / RESUME a to-be-cancelled
    // sub). Arm the focus-refetch so that when the user finishes in the portal
    // and tabs back, the credits screen re-reads and reflects the new state
    // (e.g. resume → status flips back to active, the "will end" line reverts to
    // the renewal line).
    lastBillingActionAt = Date.now();
    return await sei.subscriptionCancel();
  },

  acknowledgeHardStop: (): void => {
    // Local UI state only — server is NOT called.
    set({ hardStopActive: false, hardStopReason: null });
  },

  reset: (): void => {
    // Invalidate any creditsGet() still in flight from a prior scope (see
    // loadEpoch docs) so its late resolution can't repopulate this freshly
    // reset store with the previous profile's values.
    loadEpoch += 1;
    const { unsubStatus, unsubHardStop, unsubFocus } = get();
    unsubStatus?.();
    unsubHardStop?.();
    unsubFocus?.();
    clearCheckoutTimers();
    checkoutBaseline = null;
    lastBillingActionAt = 0;
    set({ ...INITIAL, unsubStatus: undefined, unsubHardStop: undefined, unsubFocus: undefined });
    // quick/260525-sbo Task 6: clear the module-level prev-plan ref so a
    // subsequent sign-in + re-init treats the next push as a cold-load
    // rather than a transition (otherwise a sign-out from 'unlimited'
    // followed by sign-in as a 'trial' user would spuriously fire the
    // receipt navigate on the next status push if that user later
    // subscribed within the same app session — the prev value from the
    // previous account would still be in the ref).
    prevPlanForReceipt = null;
  },
}));
