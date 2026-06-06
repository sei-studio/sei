/**
 * Tests for useCreditsStore — Phase 13 Plan 16 credits-state store.
 *
 * RED phase: this file lands BEFORE useCreditsStore.ts exists. The implementation
 * lands in the GREEN-phase commit immediately after.
 *
 * Invariants under test (mirroring 13-PATTERNS §useCreditsStore + must_haves):
 *   1. init() is idempotent — calling twice → creditsGet called once.
 *   2. init() subscribes BEFORE awaiting the seed (push-seq race guard from
 *      useSyncStore.ts:77-91 — without this, a push that arrives during the
 *      await overwrites the seed with stale data).
 *   3. Push arriving DURING the initial-seed-await wins over the seed —
 *      pushSeq race guard enforces "push is newer than the snapshot we're
 *      awaiting".
 *   4. refresh() re-fetches creditsGet and replaces state.
 *   5. onCreditsStatusUpdate push handler mutates state.
 *   6. onCreditsHardStop push sets hardStopActive=true with the reason.
 *   7. acknowledgeHardStop() clears local UI state ONLY (does NOT touch server).
 *   8. openCheckout(kind) calls window.sei.creditsOpenCheckout(kind).
 *   9. cancelSubscription() calls window.sei.subscriptionCancel.
 *  10. reset() invokes the returned unsubscribe handles (cleanup).
 *
 * Mock strategy: stub `window.sei` via globalThis.window before importing the
 * store (mirrors useBrowseStore.test.ts pattern from Phase 12-09). The store
 * imports `sei` from `../ipcClient` which reads `window.sei` at module init,
 * so `vi.resetModules()` between tests is critical.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CreditsStatus, CreditsHardStopEvent } from '@shared/ipc';

// --- Test fixtures --------------------------------------------------------

function status(overrides: Partial<CreditsStatus> = {}): CreditsStatus {
  return {
    remaining_pct: 100,
    usage_pct: 0,
    plan: 'trial',
    renews_at: null,
    ends_at: null,
    trial_claimed: false,
    ai_backend_kind: 'cloud-proxy',
    ...overrides,
  };
}

type Unsubscribe = () => void;

let creditsGetMock: ReturnType<typeof vi.fn<() => Promise<CreditsStatus>>>;
let creditsOpenCheckoutMock: ReturnType<
  typeof vi.fn<(kind: 'pack' | 'subscription') => Promise<{ ok: true } | { ok: false; code: string }>>
>;
let subscriptionCancelMock: ReturnType<
  typeof vi.fn<() => Promise<{ ok: true; portalUrl: string } | { ok: false; code: string }>>
>;
let trialClaimMock: ReturnType<
  typeof vi.fn<
    (mc: string) => Promise<{ ok: true; credits_micro: number } | { ok: false; code: string }>
  >
>;
let getConfigMock: ReturnType<typeof vi.fn<() => Promise<{ mc_username: string | null }>>>;
let onCreditsStatusUpdateMock: ReturnType<
  typeof vi.fn<(cb: (status: CreditsStatus) => void) => Unsubscribe>
>;
let onCreditsHardStopMock: ReturnType<
  typeof vi.fn<(cb: (info: CreditsHardStopEvent) => void) => Unsubscribe>
>;
let statusUnsub: ReturnType<typeof vi.fn<() => void>>;
let hardStopUnsub: ReturnType<typeof vi.fn<() => void>>;

// Captured push handlers so tests can fire them at deterministic moments.
let statusHandler: ((s: CreditsStatus) => void) | null;
let hardStopHandler: ((info: CreditsHardStopEvent) => void) | null;

beforeEach(() => {
  vi.resetModules();
  creditsGetMock = vi.fn<() => Promise<CreditsStatus>>();
  creditsOpenCheckoutMock = vi.fn<
    (kind: 'pack' | 'subscription') => Promise<{ ok: true } | { ok: false; code: string }>
  >();
  subscriptionCancelMock = vi.fn<
    () => Promise<{ ok: true; portalUrl: string } | { ok: false; code: string }>
  >();
  trialClaimMock = vi.fn();
  getConfigMock = vi.fn(async () => ({ mc_username: 'SeiPlayer1' }));
  statusUnsub = vi.fn();
  hardStopUnsub = vi.fn();
  statusHandler = null;
  hardStopHandler = null;
  onCreditsStatusUpdateMock = vi.fn((cb: (s: CreditsStatus) => void) => {
    statusHandler = cb;
    return statusUnsub;
  });
  onCreditsHardStopMock = vi.fn((cb: (info: CreditsHardStopEvent) => void) => {
    hardStopHandler = cb;
    return hardStopUnsub;
  });

  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      creditsGet: creditsGetMock,
      creditsOpenCheckout: creditsOpenCheckoutMock,
      subscriptionCancel: subscriptionCancelMock,
      trialClaim: trialClaimMock,
      getConfig: getConfigMock,
      onCreditsStatusUpdate: onCreditsStatusUpdateMock,
      onCreditsHardStop: onCreditsHardStopMock,
    },
  };
});

// Helper — imports the store fresh after the window stub is in place + resets
// any leftover state so tests stay isolated.
async function loadStore() {
  const mod = await import('./useCreditsStore');
  // We do NOT call reset() here because it tears down subscriptions that
  // haven't been set up yet; each test starts from the create() initial state.
  return mod.useCreditsStore;
}

// --- Tests ----------------------------------------------------------------

describe('useCreditsStore', () => {
  it('Test 1: init() is idempotent — calling twice calls creditsGet once', async () => {
    creditsGetMock.mockResolvedValue(status({ remaining_pct: 80 }));
    const store = await loadStore();

    await store.getState().init();
    await store.getState().init();

    expect(creditsGetMock).toHaveBeenCalledTimes(1);
    expect(store.getState().initialized).toBe(true);
  });

  it('Test 2: init() subscribes to onCreditsStatusUpdate BEFORE awaiting the seed', async () => {
    // Deferred-promise pattern: capture the order — when does
    // onCreditsStatusUpdate fire relative to the await on creditsGet?
    let creditsGetResolved = false;
    let subscribedBeforeResolve = false;

    // Pause the seed indefinitely until we say so.
    let resolveSeed!: (s: CreditsStatus) => void;
    creditsGetMock.mockImplementation(
      () =>
        new Promise<CreditsStatus>((res) => {
          resolveSeed = (v) => {
            creditsGetResolved = true;
            res(v);
          };
        }),
    );

    // Spy on the subscribe so we know if it was called while creditsGet was still pending.
    onCreditsStatusUpdateMock.mockImplementation((cb) => {
      // At this point, the seed should NOT yet have resolved if we subscribed first.
      subscribedBeforeResolve = !creditsGetResolved;
      statusHandler = cb;
      return statusUnsub;
    });

    const store = await loadStore();
    const initPromise = store.getState().init();

    // The subscribe call must have happened by now.
    expect(onCreditsStatusUpdateMock).toHaveBeenCalled();
    expect(subscribedBeforeResolve).toBe(true);

    // Now let the seed resolve so init() can finish.
    resolveSeed(status({ remaining_pct: 80 }));
    await initPromise;
  });

  it('Test 3: push arriving DURING the initial-seed-await wins over the seed', async () => {
    // Hold the seed open, fire a push with remaining_pct=42 BEFORE resolving
    // the seed with remaining_pct=80. Final state must be 42 (push wins).
    let resolveSeed!: (s: CreditsStatus) => void;
    creditsGetMock.mockImplementation(
      () =>
        new Promise<CreditsStatus>((res) => {
          resolveSeed = res;
        }),
    );

    const store = await loadStore();
    const initPromise = store.getState().init();

    // Push fires during the await.
    expect(statusHandler).not.toBeNull();
    statusHandler!(status({ remaining_pct: 42 }));

    // Now resolve the seed (stale snapshot — must be skipped).
    resolveSeed(status({ remaining_pct: 80 }));
    await initPromise;

    expect(store.getState().remaining_pct).toBe(42);
    expect(store.getState().initialized).toBe(true);
  });

  it('Test 4: refresh() re-fetches creditsGet and replaces state', async () => {
    creditsGetMock
      .mockResolvedValueOnce(status({ remaining_pct: 80 }))
      .mockResolvedValueOnce(status({ remaining_pct: 30, plan: 'pack' }));
    const store = await loadStore();

    await store.getState().init();
    expect(store.getState().remaining_pct).toBe(80);

    await store.getState().refresh();
    expect(store.getState().remaining_pct).toBe(30);
    expect(store.getState().plan).toBe('pack');
    expect(creditsGetMock).toHaveBeenCalledTimes(2);
  });

  it('Test 5: onCreditsStatusUpdate push mutates state', async () => {
    creditsGetMock.mockResolvedValue(status({ remaining_pct: 100 }));
    const store = await loadStore();
    await store.getState().init();

    statusHandler!(status({ remaining_pct: 65, usage_pct: 35, plan: 'pack' }));

    expect(store.getState().remaining_pct).toBe(65);
    expect(store.getState().usage_pct).toBe(35);
    expect(store.getState().plan).toBe('pack');
  });

  it('Test 6: onCreditsHardStop push sets hardStopActive=true with reason', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();
    await store.getState().init();

    expect(store.getState().hardStopActive).toBe(false);

    hardStopHandler!({ reason: 'depleted' });

    expect(store.getState().hardStopActive).toBe(true);
    expect(store.getState().hardStopReason).toBe('depleted');
  });

  it('Test 6b: onCreditsHardStop with rate_limited sets rateLimitedUntil epoch', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();
    await store.getState().init();

    const before = Date.now();
    hardStopHandler!({ reason: 'rate_limited', retry_after_seconds: 30 });
    const after = Date.now();

    expect(store.getState().hardStopActive).toBe(true);
    expect(store.getState().hardStopReason).toBe('rate_limited');
    const until = store.getState().rateLimitedUntil!;
    // ms epoch ~ now + 30s
    expect(until).toBeGreaterThanOrEqual(before + 30_000);
    expect(until).toBeLessThanOrEqual(after + 30_000);
  });

  it('Test 7: acknowledgeHardStop() clears local UI state only (server NOT called)', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();
    await store.getState().init();

    hardStopHandler!({ reason: 'depleted' });
    expect(store.getState().hardStopActive).toBe(true);

    // Snapshot the call count of every server-touching mock before ack.
    const beforeGet = creditsGetMock.mock.calls.length;
    const beforeCheckout = creditsOpenCheckoutMock.mock.calls.length;
    const beforeCancel = subscriptionCancelMock.mock.calls.length;

    store.getState().acknowledgeHardStop();

    expect(store.getState().hardStopActive).toBe(false);
    expect(store.getState().hardStopReason).toBe(null);
    // No server-touching IPC calls fired.
    expect(creditsGetMock.mock.calls.length).toBe(beforeGet);
    expect(creditsOpenCheckoutMock.mock.calls.length).toBe(beforeCheckout);
    expect(subscriptionCancelMock.mock.calls.length).toBe(beforeCancel);
  });

  it("Test 8: openCheckout('pack') calls window.sei.creditsOpenCheckout('pack')", async () => {
    creditsOpenCheckoutMock.mockResolvedValue({ ok: true });
    const store = await loadStore();
    await store.getState().openCheckout('pack');
    expect(creditsOpenCheckoutMock).toHaveBeenCalledWith('pack');
  });

  it('Test 9: cancelSubscription() calls window.sei.subscriptionCancel', async () => {
    subscriptionCancelMock.mockResolvedValue({
      ok: true,
      portalUrl: 'https://polar.sh/my-org/portal',
    });
    const store = await loadStore();
    await store.getState().cancelSubscription();
    expect(subscriptionCancelMock).toHaveBeenCalledTimes(1);
  });

  it('Test 9b: claimTrial() success derives from refreshed trial_claimed, NOT the trialClaim delta', async () => {
    // Regression (260603): the balance-delta read inside proxyClient.trialClaim
    // can race the just-committed grant and report "already_claimed" even when
    // the claim actually succeeded. The store must trust the SERVER snapshot
    // (trial_claimed) after refresh — so a fresh claim still resolves ok:true
    // and the button flips to "Claimed".
    trialClaimMock.mockResolvedValue({ ok: false, code: 'already_claimed' });
    creditsGetMock.mockResolvedValue(status({ trial_claimed: true, remaining_tokens: 500000 }));
    const store = await loadStore();

    const res = await store.getState().claimTrial();

    // The trial is account-bound (20260603000000): claimTrial takes no
    // arguments — no mc_username is read or passed.
    expect(trialClaimMock).toHaveBeenCalledWith();
    expect(res).toEqual({ ok: true });
    expect(store.getState().trial_claimed).toBe(true);
    // The refreshed snapshot also lands the grant so the "~Xh left" estimate updates.
    expect(store.getState().remaining_tokens).toBe(500000);
  });

  it('Test 9c: claimTrial() surfaces device_claimed when the per-device gate blocked AND trial_claimed stays false', async () => {
    // 260605: the device-global anti-abuse gate refused the grant (this machine
    // already spent its one trial under another account). The account never gets
    // a kind='trial' row, so trial_claimed stays false after refresh and the
    // store passes the distinct 'device_claimed' code through — the card shows
    // "this device already used its free trial" + a disabled button, instead of
    // the misleading "already claimed" + re-clickable dead-end.
    trialClaimMock.mockResolvedValue({ ok: false, code: 'device_claimed' });
    creditsGetMock.mockResolvedValue(status({ trial_claimed: false }));
    const store = await loadStore();

    const res = await store.getState().claimTrial();

    expect(res).toEqual({ ok: false, code: 'device_claimed' });
    expect(store.getState().trial_claimed).toBe(false);
  });

  it('Test 10: reset() invokes the unsubscribe handles returned by the push subscriptions', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();
    await store.getState().init();

    expect(statusUnsub).not.toHaveBeenCalled();
    expect(hardStopUnsub).not.toHaveBeenCalled();

    store.getState().reset();

    expect(statusUnsub).toHaveBeenCalledTimes(1);
    expect(hardStopUnsub).toHaveBeenCalledTimes(1);
    expect(store.getState().initialized).toBe(false);
    expect(store.getState().hardStopActive).toBe(false);
  });

  it('Test 11: no dollar/micro field names in state shape (PROXY-05 type-level rule)', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();
    await store.getState().init();

    // ITEM 4 RELAXATION (tightened 260602-hbr): only `remaining_tokens` is
    // allowed — the playtime estimator (tokensRemainingToPlaytime) needs it to
    // render "~Xh left". `tokens_per_min` was dropped (flat multiplier now).
    // The PROXY-05 spirit of the rule — keep MONETARY units server-side —
    // remains intact: no dollar/micro/cent terms appear in the renderer state.
    // Token COUNTS (which the user never sees as numbers — only as playtime
    // strings) are the necessary intermediate; usage_pct is a percent (allowed).
    const ALLOWED_TOKEN_KEYS = new Set(['remaining_tokens']);
    const keys = Object.keys(store.getState());
    for (const k of keys) {
      const lower = k.toLowerCase();
      if (lower.includes('token') && !ALLOWED_TOKEN_KEYS.has(k)) {
        throw new Error(`unexpected token field in CreditsState: ${k}`);
      }
      expect(lower).not.toContain('dollar');
      // 'micro' is the µ$ ledger unit — banned from the renderer.
      expect(lower).not.toContain('micro');
    }
  });

  /* -------------------------------------------------------------------------
   * quick/260525-sbo Task 6 — ReceiptScreen auto-navigate transition guard.
   *
   * The store exposes a pure helper `shouldNavigateToReceipt(prev, next)` that
   * returns true when the plan transitions from any non-'unlimited' value to
   * 'unlimited' AND false otherwise (no-op pushes, unlimited→unlimited,
   * trial→trial, unlimited→cancelled, etc.).
   *
   * Tested at the function level (not via a React render) because the project
   * doesn't ship @testing-library/react. The lazy-import-of-useUiStore
   * navigation side-effect is exercised manually in dev smoke (operator
   * runbook step) and is a single one-liner that imports useUiStore and calls
   * navigate({kind:'receipt'}) — covered by the function-level guard test
   * here plus the source-grep verifier in the executor pipeline.
   * ----------------------------------------------------------------------- */

  it('Test 12: shouldNavigateToReceipt — trial → unlimited returns true (first-time subscription activation)', async () => {
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt('trial', 'unlimited')).toBe(true);
  });

  it('Test 13: shouldNavigateToReceipt — pack → unlimited returns true (pack user upgrades)', async () => {
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt('pack', 'unlimited')).toBe(true);
  });

  it('Test 14: shouldNavigateToReceipt — depleted → unlimited returns true (depleted user subscribes)', async () => {
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt('depleted', 'unlimited')).toBe(true);
  });

  it('Test 15: shouldNavigateToReceipt — unlimited → unlimited returns false (no re-navigation on repeat push)', async () => {
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt('unlimited', 'unlimited')).toBe(false);
  });

  it('Test 16: shouldNavigateToReceipt — null (cold-load) → unlimited returns false (first-push seed is not a transition)', async () => {
    // Cold-load case: prevPlan starts null when the store is fresh; the very
    // first status push must NOT be classified as a transition (otherwise an
    // already-subscribed user would see ReceiptScreen on every app start).
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt(null, 'unlimited')).toBe(false);
  });

  it('Test 17: shouldNavigateToReceipt — unlimited → trial returns false (cancellation does NOT navigate to receipt)', async () => {
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt('unlimited', 'trial')).toBe(false);
  });

  it('Test 18: shouldNavigateToReceipt — trial → trial returns false (same-plan idle pushes do not navigate)', async () => {
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt('trial', 'trial')).toBe(false);
  });

  /* -------------------------------------------------------------------------
   * quick/260525-sbo Task 8 — subscription_status_raw passthrough.
   *
   * The store mirrors the raw LS status from CreditsStatus so SettingsScreen
   * can render a contextual banner for past_due / paused without a separate
   * IPC round-trip.
   * ----------------------------------------------------------------------- */

  it('Test 19: seed populates subscription_status_raw from creditsGet', async () => {
    creditsGetMock.mockResolvedValue({
      ...status(),
      subscription_status_raw: 'past_due',
    });
    const store = await loadStore();
    await store.getState().init();
    expect(store.getState().subscription_status_raw).toBe('past_due');
  });

  it('Test 20: onCreditsStatusUpdate push updates subscription_status_raw', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();
    await store.getState().init();
    expect(store.getState().subscription_status_raw).toBe(null);

    statusHandler!({
      ...status({ plan: 'unlimited' }),
      subscription_status_raw: 'paused',
    });
    expect(store.getState().subscription_status_raw).toBe('paused');
  });

  it('Test 21: missing subscription_status_raw on push falls back to null', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();
    await store.getState().init();
    // Push WITHOUT subscription_status_raw — store should coerce to null
    // rather than undefined (preserves the discriminated null sentinel).
    statusHandler!(status({ plan: 'unlimited' }));
    expect(store.getState().subscription_status_raw).toBe(null);
  });

  it('Test 22: ends_at propagates through seed and push (cancel-scheduled → resumed)', async () => {
    creditsGetMock.mockResolvedValue(
      status({
        plan: 'unlimited',
        ends_at: '2099-01-01T00:00:00Z',
        subscription_status_raw: 'cancelled',
      }),
    );
    const store = await loadStore();
    await store.getState().init();
    // Seed: "to be cancelled" carries the end date.
    expect(store.getState().ends_at).toBe('2099-01-01T00:00:00Z');

    // Push: user resumed → status active, ends_at cleared.
    statusHandler!(status({ plan: 'unlimited', ends_at: null, subscription_status_raw: 'active' }));
    expect(store.getState().ends_at).toBe(null);
    expect(store.getState().subscription_status_raw).toBe('active');
  });
});

/* ===========================================================================
 * Checkout watch — high-freq polling while the "complete your purchase" modal
 * is open, with a wall-clock timeout, plus the pure detection predicate.
 * =========================================================================== */

describe('isPurchaseConfirmed', () => {
  const base = {
    remaining_tokens: 100,
    plan: 'depleted' as const,
    subscription_status_raw: null,
  };

  it('pack: true when remaining_tokens increased', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed('pack', base, {
        remaining_tokens: 200,
        plan: 'pack',
        subscription_status_raw: null,
      }),
    ).toBe(true);
  });

  it('pack: false when remaining_tokens unchanged', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed('pack', base, {
        remaining_tokens: 100,
        plan: 'depleted',
        subscription_status_raw: null,
      }),
    ).toBe(false);
  });

  it('subscription: true on plan→unlimited even with no token change', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed('subscription', base, {
        remaining_tokens: 100,
        plan: 'unlimited',
        subscription_status_raw: null,
      }),
    ).toBe(true);
  });

  it('subscription: true on status→active', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed('subscription', base, {
        remaining_tokens: 100,
        plan: 'depleted',
        subscription_status_raw: 'active',
      }),
    ).toBe(true);
  });

  it('resume: true when the sub flips off cancelled (cancelled→active)', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed(
        'resume',
        { remaining_tokens: 100, plan: 'unlimited', subscription_status_raw: 'cancelled' },
        { remaining_tokens: 100, plan: 'unlimited', subscription_status_raw: 'active' },
      ),
    ).toBe(true);
  });

  it('resume: false while still cancelled', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed(
        'resume',
        { remaining_tokens: 100, plan: 'unlimited', subscription_status_raw: 'cancelled' },
        { remaining_tokens: 100, plan: 'unlimited', subscription_status_raw: 'cancelled' },
      ),
    ).toBe(false);
  });
});

describe('checkout watch (beginPurchase / dismissCheckout)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('beginPurchase(pack): opens checkout, polls, confirms on a credit increase', async () => {
    creditsOpenCheckoutMock.mockResolvedValue({ ok: true });
    // The poll's refresh() reads the topped-up balance.
    creditsGetMock.mockResolvedValue(status({ remaining_tokens: 500_000, usage_pct: 10 }));
    const mod = await import('./useCreditsStore');
    const store = mod.useCreditsStore;

    await store.getState().beginPurchase('pack');
    expect(store.getState().checkoutStatus).toBe('waiting');
    expect(creditsOpenCheckoutMock).toHaveBeenCalledWith('pack');

    // One poll interval → refresh → remaining_tokens 500k > baseline 0 → confirmed.
    await vi.advanceTimersByTimeAsync(mod.CHECKOUT_POLL_INTERVAL_MS);
    expect(store.getState().checkoutStatus).toBe('confirmed');
    expect(store.getState().remaining_tokens).toBe(500_000);
  });

  it('beginPurchase(subscription, alreadyOpened): does NOT reopen checkout; confirms on plan→unlimited', async () => {
    creditsGetMock.mockResolvedValue(
      status({ plan: 'unlimited', subscription_status_raw: 'active' }),
    );
    const mod = await import('./useCreditsStore');
    const store = mod.useCreditsStore;

    await store.getState().beginPurchase('subscription', { alreadyOpened: true });
    expect(creditsOpenCheckoutMock).not.toHaveBeenCalled();
    expect(store.getState().checkoutStatus).toBe('waiting');

    await vi.advanceTimersByTimeAsync(mod.CHECKOUT_POLL_INTERVAL_MS);
    expect(store.getState().checkoutStatus).toBe('confirmed');
  });

  it('beginPurchase: transitions to timeout after the wall-clock cap with no change', async () => {
    creditsOpenCheckoutMock.mockResolvedValue({ ok: true });
    creditsGetMock.mockResolvedValue(status({ remaining_tokens: 0 })); // no change vs baseline 0
    const mod = await import('./useCreditsStore');
    const store = mod.useCreditsStore;

    await store.getState().beginPurchase('pack');
    await vi.advanceTimersByTimeAsync(mod.CHECKOUT_MAX_WAIT_MS);
    expect(store.getState().checkoutStatus).toBe('timeout');
  });

  it('dismissCheckout(): resets to idle and stops polling', async () => {
    creditsOpenCheckoutMock.mockResolvedValue({ ok: true });
    creditsGetMock.mockResolvedValue(status({ remaining_tokens: 0 }));
    const mod = await import('./useCreditsStore');
    const store = mod.useCreditsStore;

    await store.getState().beginPurchase('pack');
    store.getState().dismissCheckout();
    expect(store.getState().checkoutStatus).toBe('idle');
    expect(store.getState().checkoutKind).toBe(null);

    creditsGetMock.mockClear();
    await vi.advanceTimersByTimeAsync(mod.CHECKOUT_POLL_INTERVAL_MS * 3);
    expect(creditsGetMock).not.toHaveBeenCalled();
  });

  it('beginResume(): opens the billing portal (not checkout), polls, confirms when sub flips off cancelled', async () => {
    subscriptionCancelMock.mockResolvedValue({ ok: true, portalUrl: 'https://portal.example' });
    // After the user resumes in the portal, creditsGet reports active again.
    creditsGetMock.mockResolvedValue(
      status({ plan: 'unlimited', subscription_status_raw: 'active', ends_at: null }),
    );
    const mod = await import('./useCreditsStore');
    const store = mod.useCreditsStore;
    // Start from the "to be cancelled" state so the baseline is 'cancelled'.
    store.setState({
      plan: 'unlimited',
      subscription_status_raw: 'cancelled',
      ends_at: '2099-01-01T00:00:00Z',
    });

    await store.getState().beginResume();
    expect(subscriptionCancelMock).toHaveBeenCalledTimes(1); // portal opened…
    expect(creditsOpenCheckoutMock).not.toHaveBeenCalled(); // …NOT a new checkout
    expect(store.getState().checkoutStatus).toBe('waiting');
    expect(store.getState().checkoutKind).toBe('resume');

    await vi.advanceTimersByTimeAsync(mod.CHECKOUT_POLL_INTERVAL_MS);
    expect(store.getState().checkoutStatus).toBe('confirmed');
  });
});
