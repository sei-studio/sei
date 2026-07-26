/**
 * useCreditsStore — renderer-side plan + weekly-usage state.
 *
 * Single source of truth for the plan UI (usage hero, extra-credits row, plan
 * cards, hard-stop modal, icon rail). Mirrors `useSyncStore.ts` (the
 * gold-standard template) — `interface FooState + FooActions + idempotent
 * init() + push-seq race guard`.
 *
 * Push-seq race guard (lines 64-83 of useSyncStore.ts in spirit):
 *   The renderer subscribes to `onCreditsStatusUpdate` BEFORE awaiting the
 *   initial `creditsGet()` seed. Without this, a push that arrives during the
 *   await would be overwritten by the older snapshot. `pushSeq` increments on
 *   every push; the seed only applies if `pushSeq === seqBefore`, i.e. no push
 *   fired during the await.
 *
 * State-shape invariants (must_haves):
 *   - NO token/dollar/micro fields. The store carries percentages, credit
 *     counts and dates; every monetary unit stays server-side (the only
 *     dollar figures in the app are the plan cards, the top up packages and
 *     the legally required purchase disclosures, all static copy).
 *   - `hardStopActive` is set ONLY by an explicit `onCreditsHardStop` push —
 *     never derived from `over_limit` in render. Explicit semantics so a
 *     stale-but-true seed doesn't spuriously trigger the modal.
 *   - `rateLimitedUntil` is a ms-epoch only; any countdown component owns its
 *     own 1Hz `setInterval` so the store doesn't re-render every second.
 *
 * Server-side semantics:
 *   - `acknowledgeHardStop()` clears LOCAL UI state only — it does NOT call
 *     the server. The server's view of the user's allowance is unchanged; this
 *     just dismisses the modal so the user can keep typing (their next call
 *     will either succeed or re-trigger the hard-stop push).
 *
 * Boot wiring: `App.tsx` calls `useCreditsStore.getState().init()` on mount
 * when `ai_backend_kind === 'cloud-proxy'`. Idempotent — safe to call
 * multiple times.
 *
 * Sources:
 *   - .planning/quick/260724-sub-weekly-subscription-model/SPEC.md (§4 contract)
 *   - src/renderer/src/lib/stores/useSyncStore.ts (template — push-seq guard)
 *   - src/shared/ipc.ts (CreditsStatus, CreditsHardStopEvent contract)
 */

import { create, type StoreApi } from 'zustand';
import type { CreditsStatus, CreditsHardStopEvent, PlanTier } from '@shared/ipc';
import { sei } from '../ipcClient';
import {
  PLANS,
  TOP_UPS,
  plansFromCatalog,
  topUpsFromCatalog,
  type PlanCard,
  type TopUpPackage,
} from '../planCatalog';

type HardStopReason = CreditsHardStopEvent['reason'];

/**
 * Which billing action a checkout watch is following: a paid tier
 * ('quest' / 'party'), 'resume' for un-cancelling a scheduled cancellation,
 * or any top up SKU id from the server pricing catalog (e.g. 'topup_small').
 * 260725: an open string rather than a closed union — top up packages are
 * server catalog rows, so a package added after this client shipped must
 * still flow through. Anything that is not a paid tier or 'resume' is
 * treated as a top up.
 */
export type CheckoutKind = string;

/** The paid subscription tiers — the checkout kinds that are NOT top ups. */
const PAID_TIERS: readonly string[] = ['quest', 'party'];

/** Ordered tiers. Index = rank; `free` is rank 0. */
const TIER_RANK: Record<PlanTier, number> = { free: 0, quest: 1, party: 2 };

/** True when the tier is a paid subscription. */
export function isPaidTier(tier: PlanTier): boolean {
  return tier !== 'free';
}

/**
 * Pure transition predicate for the ReceiptScreen auto-navigate side-effect.
 * Returns true iff `prev` is a KNOWN lower-ranked tier and `next` is a paid
 * tier — i.e. we watched the user move up into a paid plan and owe them the
 * FTC 16 CFR §425.5 in-app charge acknowledgement.
 *
 * Critically, `null → party` returns FALSE: a cold-loaded user who is already
 * subscribed must NOT see the receipt on every app start. Only a GENUINE
 * transition qualifies as a subscription activation event.
 *
 * Exported so the unit test can exercise the predicate in isolation without
 * mocking useUiStore (and avoiding the lazy-import / circular-dep dance).
 */
export function shouldNavigateToReceipt(prev: PlanTier | null, next: PlanTier): boolean {
  if (!isPaidTier(next)) return false;
  if (prev === null) return false; // cold-load is not a transition
  return TIER_RANK[next] > TIER_RANK[prev];
}

/**
 * Module-level previous-plan ref. Lives outside the store factory so it
 * persists across set() updates AND survives the lazy import done by the
 * navigate side-effect without becoming part of the React-subscribable
 * state shape. The shouldNavigateToReceipt() helper above is the pure data
 * function; this ref is the impure execution-context anchor.
 */
let prevPlanForReceipt: PlanTier | null = null;

/**
 * Checkout-watch tuning. After the user is sent to the hosted checkout in their
 * system browser, the plan screen shows a "complete your purchase" modal and
 * polls `creditsGet` at a high frequency until the webhook-driven change lands —
 * the standard "waiting for an out-of-band payment" pattern. The poll is capped
 * by a wall-clock timeout so it never runs forever; after that, the
 * focus-refetch backstop (init()) and the in-game push channel still catch a
 * late completion. Exported for the unit tests.
 */
export const CHECKOUT_POLL_INTERVAL_MS = 2_500;
export const CHECKOUT_MAX_WAIT_MS = 180_000; // 3 minutes
/**
 * After a checkout is initiated, re-read the plan whenever the app window
 * regains focus for this long — the edge case where the user dismisses the
 * modal, pays in the browser anyway, then tabs back to the app.
 */
export const CHECKOUT_FOCUS_REFETCH_WINDOW_MS = 30 * 60_000; // 30 minutes

/** Pre-checkout snapshot used to detect that a purchase landed. */
type CheckoutBaseline = {
  plan: PlanTier;
  extra_credits_total: number;
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
 * plan snapshot (creditsGet) can fail transiently (offline read, IPC hiccup) —
 * but the backend kind is a LOCAL config fact, and it gates the Settings
 * ACCOUNT MODE surface + the plan UI. If a failed seed left the INITIAL 'local'
 * in place while the actual calls ran cloud-proxy, the UI claimed BYOK while
 * spending cloud credits. Null on failure → caller keeps the current value.
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
 *     flips off 'cancelled'. Nothing is granted, so the other checks don't apply.
 *   - A subscription ('quest' / 'party') flips `plan` to the purchased tier, or
 *     the status to 'active' — whichever webhook lands first.
 *   - Any other kind is a top up SKU (260725: server catalog rows, open set):
 *     it raises `extra_credits_total` (the bucket is non-expiring, so the
 *     total only ever grows).
 *
 * Exported so the unit test can exercise it in isolation.
 */
export function isPurchaseConfirmed(
  kind: CheckoutKind,
  baseline: CheckoutBaseline,
  current: {
    plan: PlanTier;
    extra_credits_total: number;
    subscription_status_raw: CreditsStatus['subscription_status_raw'];
  },
): boolean {
  if (kind === 'resume') {
    return (
      baseline.subscription_status_raw === 'cancelled' &&
      current.subscription_status_raw !== 'cancelled'
    );
  }
  if (PAID_TIERS.includes(kind)) {
    // A new subscription: the tier landed, or the status went active.
    if (current.plan === kind && baseline.plan !== kind) return true;
    return (
      current.subscription_status_raw === 'active' &&
      baseline.subscription_status_raw !== 'active'
    );
  }
  // Everything else is a top up SKU.
  return current.extra_credits_total > baseline.extra_credits_total;
}

/**
 * Shared poll + wall-clock-timeout for the checkout / resume watch. The caller
 * has already captured `checkoutBaseline`, set checkoutStatus='waiting', and
 * opened the relevant browser surface (hosted checkout or customer portal).
 * Polls creditsGet until isPurchaseConfirmed(kind,…) fires or the cap elapses.
 */
function startCheckoutWatch(
  kind: CheckoutKind,
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
  /** Current subscription tier. Every account is 'free' unless a sub says otherwise. */
  plan: PlanTier;
  /**
   * Weekly ALLOWANCE consumption, 0..100, clamped server-side. Drives the hero
   * number and the main bar; 100 renders red.
   */
  usage_pct: number;
  /** Allowance exhausted AND no extra credits left. Gates the hard stop. */
  over_limit: boolean;
  /** ISO timestamp the weekly allowance rolls over. Empty before the first seed. */
  resets_at: string;
  /** The non-expiring top up bucket, in credits. Both 0 when never topped up. */
  extra_credits_used: number;
  extra_credits_total: number;
  renews_at: string | null;
  /**
   * ISO end date when the subscription is cancel-scheduled ("to be cancelled")
   * but still active. Drives the "Plan ends {date}" line + Resume CTA. null for
   * auto-renewing subscribers and non-subscribers.
   */
  ends_at: string | null;
  /**
   * The mode the UI displays. 260725: `null` = UNKNOWN — main has not yet
   * reported a kind for the current auth scope. The UI must render neither
   * the BYOK nor the cloud surfaces while unknown. This field is only ever
   * set from main's reports (creditsGet, the config fallback, or the
   * proxy:kind-changed push); it must NEVER default to a guessed mode — a
   * guessed 'local' painted a BYOK UI over live cloud billing (recurring
   * incident, last 260725).
   */
  ai_backend_kind: CreditsStatus['ai_backend_kind'] | null;
  /**
   * Raw subscription status passthrough. SettingsScreen and the plan cards
   * render contextual copy (past due, cancel-scheduled) by reading this
   * directly. null on no-session / never-subscribed / cold-load.
   */
  subscription_status_raw: CreditsStatus['subscription_status_raw'];
  /**
   * Set ONLY by an explicit `onCreditsHardStop` push — never computed from
   * `over_limit` in render. Drives HardStopModal mounting in App.tsx.
   */
  hardStopActive: boolean;
  hardStopReason: HardStopReason | null;
  /**
   * ms-epoch when a rate-limit window ends, when the proxy sent one. Consumers
   * run their own setInterval for any countdown so the store never re-renders
   * at 1Hz.
   */
  rateLimitedUntil: number | null;
  /**
   * Checkout-watch state for the "complete your purchase in your browser" modal.
   *   - 'idle'      → no modal
   *   - 'waiting'   → browser checkout open; polling creditsGet for the change
   *   - 'confirmed' → the change landed
   *   - 'timeout'   → polling gave up; the focus-refetch backstop takes over
   */
  checkoutStatus: 'idle' | 'waiting' | 'confirmed' | 'timeout';
  /** Which billing action the in-flight watch is for (drives modal copy). */
  checkoutKind: CheckoutKind | null;
  /**
   * The user asked for the top up packages from somewhere other than the plan
   * screen (the hard-stop popup). The plan screen consumes this on mount and
   * opens TopUpModal, so the purchase runs where the checkout watcher lives.
   */
  topUpRequested: boolean;
  /**
   * 260725 — the pricing catalog every money surface reads (plan cards,
   * TopUpModal, the consent modal + disclosures, ReceiptScreen). Seeded with
   * the bundled launch copy and overlaid by `loadCatalog()` with the
   * server-driven catalog, so a server-side pricing retune repaints the app
   * without a release.
   */
  planCards: PlanCard[];
  topUpPackages: TopUpPackage[];
  initialized: boolean;
  loading: boolean;
  /**
   * True when the last snapshot attempt (seed or refresh) failed and no push
   * has replaced it: the numbers in the store are the INITIAL zeros, not
   * account truth. Plan surfaces must render a "couldn't check, try again"
   * state instead of presenting 0% as fact. Cleared by any successful seed,
   * refresh, or status push.
   */
  snapshotFailed: boolean;
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
  /** Returned by onAiBackendKindChanged(cb) — invoked in reset(). */
  unsubKind?: () => void;
  /** Removes the window-focus refetch backstop listener — invoked in reset(). */
  unsubFocus?: () => void;
}

interface CreditsActions {
  /** Idempotent boot wiring. Subscribes FIRST, then seeds via creditsGet. */
  init: () => Promise<void>;
  /** Re-fetch the snapshot and replace state. */
  refresh: () => Promise<void>;
  /**
   * 260725 — overlay the server pricing catalog onto planCards /
   * topUpPackages. Failure keeps the current (bundled or last-good) copy;
   * main caches the read, so calling alongside every refresh is cheap.
   */
  loadCatalog: () => Promise<void>;
  /** Open the Polar checkout for a new subscription or a top up package. */
  openCheckout: (kind: Exclude<CheckoutKind, 'resume'>) => Promise<void>;
  /**
   * Change the tier of an EXISTING subscription (Polar subscription update, not
   * a fresh checkout). Refreshes afterwards so the cards re-paint as soon as the
   * proxy has applied it; the webhook push is the authoritative follow-up.
   */
  changePlan: (tier: PlanTier) => Promise<{ ok: true } | { ok: false; code: string }>;
  /**
   * Open the hosted checkout for `kind` AND watch for the webhook-driven change:
   * shows the "complete your purchase" modal and polls creditsGet at high
   * frequency (capped by CHECKOUT_MAX_WAIT_MS) until it lands. Pass
   * `{ alreadyOpened: true }` when an earlier step (the consent modal) already
   * launched the browser, so checkout isn't opened twice.
   */
  beginPurchase: (
    kind: Exclude<CheckoutKind, 'resume'>,
    opts?: { alreadyOpened?: boolean },
  ) => Promise<void>;
  /**
   * Resume a to-be-cancelled subscription: opens the Polar customer portal
   * (where Polar's uncancel lives) AND watches — same modal + polling as
   * beginPurchase, but completion = the subscription flips off 'cancelled',
   * and it never starts a new checkout.
   */
  beginResume: () => Promise<void>;
  /** Dismiss the checkout modal and stop polling (the browser action continues). */
  dismissCheckout: () => void;
  /** Ask the plan screen to open the top up packages (see `topUpRequested`). */
  requestTopUp: () => void;
  /** The plan screen has opened the packages; clear the request. */
  clearTopUpRequest: () => void;
  /**
   * Open the customer-portal URL so the user can manage or cancel their
   * subscription. Returns the typed result so callers can surface a fallback
   * message if the proxy can't find a portal URL.
   */
  cancelSubscription: () => Promise<{ ok: true; portalUrl: string } | { ok: false; code: string }>;
  /**
   * Clears the hard-stop modal locally. Does NOT call the server — the
   * server's view of the allowance is unchanged; the next proxied call
   * will either succeed or re-trigger the push.
   */
  acknowledgeHardStop: () => void;
  /** Tears down subscriptions and returns to the initial state. */
  reset: () => void;
}

const INITIAL: Omit<CreditsState, 'unsubStatus' | 'unsubHardStop' | 'unsubFocus'> = {
  plan: 'free',
  usage_pct: 0,
  over_limit: false,
  resets_at: '',
  extra_credits_used: 0,
  extra_credits_total: 0,
  renews_at: null,
  ends_at: null,
  // UNKNOWN until main reports a kind (see the CreditsState field docs).
  ai_backend_kind: null,
  subscription_status_raw: null,
  hardStopActive: false,
  hardStopReason: null,
  rateLimitedUntil: null,
  snapshotFailed: false,
  checkoutStatus: 'idle',
  checkoutKind: null,
  topUpRequested: false,
  planCards: [...PLANS],
  topUpPackages: [...TOP_UPS],
  initialized: false,
  loading: false,
  pushSeq: 0,
};

/** Project a CreditsStatus snapshot onto the store's data slice. */
function fromStatus(status: CreditsStatus): Partial<CreditsState> {
  return {
    plan: status.plan,
    usage_pct: status.usage_pct,
    over_limit: status.over_limit,
    resets_at: status.resets_at,
    extra_credits_used: status.extra_credits_used,
    extra_credits_total: status.extra_credits_total,
    renews_at: status.renews_at,
    ends_at: status.ends_at,
    subscription_status_raw: status.subscription_status_raw ?? null,
    ai_backend_kind: status.ai_backend_kind,
    snapshotFailed: false,
  };
}

export const useCreditsStore = create<CreditsState & CreditsActions>((set, get) => ({
  ...INITIAL,

  init: async (): Promise<void> => {
    if (get().initialized) return;

    // 1. Subscribe FIRST (useSyncStore race-guard pattern: lines 77-91).
    const unsubStatus = sei.onCreditsStatusUpdate((status) => {
      set((s) => ({ ...s, ...fromStatus(status), pushSeq: s.pushSeq + 1 }));
      // Detect an upgrade into a paid tier and navigate to ReceiptScreen exactly
      // once (FTC 16 CFR §425.5 in-app receipt surface). prevPlanForReceipt is a
      // module-level ref that persists across pushes; shouldNavigateToReceipt is
      // the pure transition predicate.
      if (shouldNavigateToReceipt(prevPlanForReceipt, status.plan)) {
        // Lazy import to avoid a circular dep on useUiStore.
        void import('./useUiStore').then(({ useUiStore }) => {
          useUiStore.getState().navigate({ kind: 'receipt' });
        });
      }
      prevPlanForReceipt = status.plan;
    });
    // 260725: main's live kind feed. Applied UNCONDITIONALLY (no epoch/seq
    // guard): every emit is main's current truth at emit time, and main
    // re-emits on every scope switch, so last-write-wins is correct. This is
    // what makes the mode display converge even when the snapshot reads race
    // or fail — the display can lag by one event, never lie steady-state.
    const unsubKind = sei.onAiBackendKindChanged(({ kind }) => {
      set({ ai_backend_kind: kind });
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
    // tabbed back" edge case: re-read the plan when the window regains focus,
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

    set({ unsubStatus, unsubHardStop, unsubKind, unsubFocus });

    // Overlay the server pricing catalog (260725). Fire-and-forget: the
    // bundled copy renders meanwhile, and a failure just keeps it.
    void get().loadCatalog();

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
        set({ ...fromStatus(status), initialized: true, loading: false });
        // Seed prevPlanForReceipt so the FIRST push after a cold-load isn't
        // treated as a transition. Without this, an already-subscribed user
        // would see ReceiptScreen on every app start. The seed plan IS the
        // prior plan from the store's perspective — the next push is the first
        // that could be a real transition.
        prevPlanForReceipt = status.plan;
      } else {
        // Push won — keep its values, just flip flags. The push handler already
        // updated prevPlanForReceipt as a side-effect.
        set({ initialized: true, loading: false });
      }
    } catch {
      // Transient IPC failure: leave the store at defaults, mark initialized
      // so we don't busy-retry. The next push (or a manual refresh) will
      // re-populate. 260703: EXCEPT ai_backend_kind — the INITIAL 'local'
      // must not stand in for a cloud-proxy profile (the UI would claim BYOK
      // while every LLM call reads config.json and spends cloud credits), so
      // seed it from the local config, which doesn't need the server.
      const kind = await readBackendKindFromConfig();
      if (loadEpoch !== epochBefore) return; // superseded by a newer scope
      set((s) => ({
        initialized: true,
        loading: false,
        // The zeros in the store are placeholders, not account truth. Only a
        // push that already landed (pushSeq moved) makes them real data.
        snapshotFailed: s.pushSeq === seqBefore,
        ...(kind !== null ? { ai_backend_kind: kind } : {}),
      }));
    }
  },

  loadCatalog: async (): Promise<void> => {
    const epochBefore = loadEpoch;
    try {
      const catalog = await sei.creditsCatalog();
      if (!catalog || loadEpoch !== epochBefore) return;
      set({
        planCards: plansFromCatalog(catalog),
        topUpPackages: topUpsFromCatalog(catalog),
      });
    } catch {
      // Keep the current (bundled or last-good) copy.
    }
  },

  refresh: async (): Promise<void> => {
    // Piggyback a catalog re-read (main's TTL cache makes the repeat cheap)
    // so a server-side pricing retune lands with the next visible refresh.
    void get().loadCatalog();
    const epochBefore = loadEpoch;
    set({ loading: true });
    try {
      const status = await sei.creditsGet();
      if (loadEpoch !== epochBefore) return; // superseded by a scope transition
      set({ ...fromStatus(status), loading: false });
    } catch {
      // 260703: same backend-kind backstop as init() — a failed snapshot must
      // not leave a stale/incorrect mode on the ACCOUNT MODE surface.
      const kind = await readBackendKindFromConfig();
      if (loadEpoch !== epochBefore) return; // superseded by a scope transition
      set({
        loading: false,
        snapshotFailed: true,
        ...(kind !== null ? { ai_backend_kind: kind } : {}),
      });
    }
  },

  openCheckout: async (kind): Promise<void> => {
    await sei.creditsOpenCheckout(kind);
  },

  changePlan: async (tier): Promise<{ ok: true } | { ok: false; code: string }> => {
    lastBillingActionAt = Date.now();
    const res = await sei.creditsChangePlan(tier);
    // Re-read either way: on success the tier may already be applied, and on
    // failure the refresh confirms nothing moved.
    await get().refresh();
    return res;
  },

  beginPurchase: async (kind, opts): Promise<void> => {
    // Restart cleanly if a previous watch is somehow still live.
    clearCheckoutTimers();
    const s = get();
    checkoutBaseline = {
      plan: s.plan,
      extra_credits_total: s.extra_credits_total,
      subscription_status_raw: s.subscription_status_raw,
    };
    lastBillingActionAt = Date.now();
    set({ checkoutStatus: 'waiting', checkoutKind: kind });

    // Open the hosted checkout in the system browser unless an earlier step
    // (the consent modal) already launched it.
    if (!opts?.alreadyOpened) {
      await get().openCheckout(kind);
    }
    startCheckoutWatch(kind, get, set);
  },

  beginResume: async (): Promise<void> => {
    clearCheckoutTimers();
    const s = get();
    checkoutBaseline = {
      plan: s.plan,
      extra_credits_total: s.extra_credits_total,
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

  requestTopUp: (): void => {
    set({ topUpRequested: true });
  },

  clearTopUpRequest: (): void => {
    set({ topUpRequested: false });
  },

  cancelSubscription: async (): Promise<{ ok: true; portalUrl: string } | { ok: false; code: string }> => {
    // Opens the Polar customer portal (manage / cancel / RESUME a to-be-cancelled
    // sub). Arm the focus-refetch so that when the user finishes in the portal
    // and tabs back, the plan screen re-reads and reflects the new state.
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
    const { unsubStatus, unsubHardStop, unsubKind, unsubFocus } = get();
    unsubStatus?.();
    unsubHardStop?.();
    unsubKind?.();
    unsubFocus?.();
    clearCheckoutTimers();
    checkoutBaseline = null;
    lastBillingActionAt = 0;
    set({
      ...INITIAL,
      unsubStatus: undefined,
      unsubHardStop: undefined,
      unsubKind: undefined,
      unsubFocus: undefined,
    });
    // Clear the module-level prev-plan ref so a subsequent sign-in + re-init
    // treats the next push as a cold-load rather than a transition (otherwise a
    // sign-out from 'party' followed by sign-in as a free user could spuriously
    // fire the receipt navigate later in the same app session).
    prevPlanForReceipt = null;
  },
}));
