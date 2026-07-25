/**
 * Tests for useCreditsStore — renderer-side plan + weekly-usage store.
 *
 * Invariants under test:
 *   1. init() is idempotent — calling twice → creditsGet called once.
 *   2. init() subscribes BEFORE awaiting the seed (push-seq race guard from
 *      useSyncStore.ts:77-91 — without this, a push that arrives during the
 *      await overwrites the seed with stale data).
 *   3. Push arriving DURING the initial-seed-await wins over the seed.
 *   4. refresh() re-fetches creditsGet and replaces state.
 *   5. onCreditsStatusUpdate push handler mutates state.
 *   6. onCreditsHardStop push sets hardStopActive=true with the reason.
 *   7. acknowledgeHardStop() clears local UI state ONLY (does NOT touch server).
 *   8. openCheckout(kind) calls window.sei.creditsOpenCheckout(kind).
 *   9. changePlan(tier) calls window.sei.creditsChangePlan(tier).
 *  10. cancelSubscription() calls window.sei.subscriptionCancel.
 *  11. reset() invokes the returned unsubscribe handles (cleanup).
 *
 * Mock strategy: stub `window.sei` via globalThis.window before importing the
 * store (mirrors useBrowseStore.test.ts). The store imports `sei` from
 * `../ipcClient` which reads `window.sei` at module init, so `vi.resetModules()`
 * between tests is critical.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CreditsStatus, CreditsHardStopEvent, PlanTier } from '@shared/ipc';

// --- Test fixtures --------------------------------------------------------

function status(overrides: Partial<CreditsStatus> = {}): CreditsStatus {
  return {
    plan: 'free',
    usage_pct: 0,
    over_limit: false,
    resets_at: '2026-08-01T00:00:00Z',
    extra_credits_used: 0,
    extra_credits_total: 0,
    renews_at: null,
    ends_at: null,
    subscription_status_raw: null,
    ai_backend_kind: 'cloud-proxy',
    ...overrides,
  };
}

type Unsubscribe = () => void;
type CheckoutProduct = 'quest' | 'party' | 'topup_small' | 'topup_large';

let creditsGetMock: ReturnType<typeof vi.fn<() => Promise<CreditsStatus>>>;
let creditsOpenCheckoutMock: ReturnType<
  typeof vi.fn<(kind: CheckoutProduct) => Promise<{ ok: true } | { ok: false; code: string }>>
>;
let creditsChangePlanMock: ReturnType<
  typeof vi.fn<(tier: PlanTier) => Promise<{ ok: true } | { ok: false; code: string }>>
>;
let subscriptionCancelMock: ReturnType<
  typeof vi.fn<() => Promise<{ ok: true; portalUrl: string } | { ok: false; code: string }>>
>;
let getConfigMock: ReturnType<typeof vi.fn<() => Promise<{ ai_backend_kind: string }>>>;
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
    (kind: CheckoutProduct) => Promise<{ ok: true } | { ok: false; code: string }>
  >();
  creditsChangePlanMock = vi.fn<
    (tier: PlanTier) => Promise<{ ok: true } | { ok: false; code: string }>
  >();
  subscriptionCancelMock = vi.fn<
    () => Promise<{ ok: true; portalUrl: string } | { ok: false; code: string }>
  >();
  getConfigMock = vi.fn(async () => ({ ai_backend_kind: 'cloud-proxy' }));
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
      creditsChangePlan: creditsChangePlanMock,
      subscriptionCancel: subscriptionCancelMock,
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
    creditsGetMock.mockResolvedValue(status({ usage_pct: 20 }));
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
      subscribedBeforeResolve = !creditsGetResolved;
      statusHandler = cb;
      return statusUnsub;
    });

    const store = await loadStore();
    const initPromise = store.getState().init();

    expect(onCreditsStatusUpdateMock).toHaveBeenCalled();
    expect(subscribedBeforeResolve).toBe(true);

    resolveSeed(status({ usage_pct: 20 }));
    await initPromise;
  });

  it('Test 3: push arriving DURING the initial-seed-await wins over the seed', async () => {
    // Hold the seed open, fire a push with usage_pct=42 BEFORE resolving the
    // seed with usage_pct=80. Final state must be 42 (push wins).
    let resolveSeed!: (s: CreditsStatus) => void;
    creditsGetMock.mockImplementation(
      () =>
        new Promise<CreditsStatus>((res) => {
          resolveSeed = res;
        }),
    );

    const store = await loadStore();
    const initPromise = store.getState().init();

    expect(statusHandler).not.toBeNull();
    statusHandler!(status({ usage_pct: 42 }));

    resolveSeed(status({ usage_pct: 80 }));
    await initPromise;

    expect(store.getState().usage_pct).toBe(42);
    expect(store.getState().initialized).toBe(true);
  });

  it('Test 4: refresh() re-fetches creditsGet and replaces state', async () => {
    creditsGetMock
      .mockResolvedValueOnce(status({ usage_pct: 20 }))
      .mockResolvedValueOnce(status({ usage_pct: 70, plan: 'quest' }));
    const store = await loadStore();

    await store.getState().init();
    expect(store.getState().usage_pct).toBe(20);

    await store.getState().refresh();
    expect(store.getState().usage_pct).toBe(70);
    expect(store.getState().plan).toBe('quest');
    expect(creditsGetMock).toHaveBeenCalledTimes(2);
  });

  it('Test 4b: a creditsGet() in flight across a reset() (scope switch) does NOT clobber the new scope', async () => {
    // The sign-in race that landed freshly signed-in users on local mode: the
    // FIRST init() reads the OLD scope (ai_backend_kind: local) and is slow; a
    // reset()+init() for the NEW scope (cloud-proxy) supersedes it. When the
    // stale read finally resolves it must be discarded by the loadEpoch guard.
    const resolvers: Array<(s: CreditsStatus) => void> = [];
    creditsGetMock.mockImplementation(
      () => new Promise<CreditsStatus>((res) => { resolvers.push(res); }),
    );
    const store = await loadStore();

    const stalePromise = store.getState().init();
    expect(resolvers.length).toBe(1);

    store.getState().reset();
    const freshPromise = store.getState().init();
    expect(resolvers.length).toBe(2);

    resolvers[1](status({ ai_backend_kind: 'cloud-proxy', usage_pct: 50 }));
    await freshPromise;
    expect(store.getState().ai_backend_kind).toBe('cloud-proxy');

    resolvers[0](status({ ai_backend_kind: 'local', usage_pct: 0 }));
    await stalePromise;
    expect(store.getState().ai_backend_kind).toBe('cloud-proxy');
    expect(store.getState().usage_pct).toBe(50);
  });

  it('Test 5: onCreditsStatusUpdate push mutates the whole section-4 slice', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();
    await store.getState().init();

    statusHandler!(
      status({
        plan: 'party',
        usage_pct: 65,
        over_limit: false,
        resets_at: '2026-09-01T00:00:00Z',
        extra_credits_used: 100,
        extra_credits_total: 800,
      }),
    );

    const s = store.getState();
    expect(s.plan).toBe('party');
    expect(s.usage_pct).toBe(65);
    expect(s.resets_at).toBe('2026-09-01T00:00:00Z');
    expect(s.extra_credits_used).toBe(100);
    expect(s.extra_credits_total).toBe(800);
  });

  it('Test 5b: over_limit propagates through seed and push', async () => {
    creditsGetMock.mockResolvedValue(status({ usage_pct: 100, over_limit: true }));
    const store = await loadStore();
    await store.getState().init();
    expect(store.getState().over_limit).toBe(true);

    // A top up clears it without changing the weekly usage number.
    statusHandler!(status({ usage_pct: 100, over_limit: false, extra_credits_total: 800 }));
    expect(store.getState().over_limit).toBe(false);
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
    const until = store.getState().rateLimitedUntil!;
    expect(until).toBeGreaterThanOrEqual(before + 30_000);
    expect(until).toBeLessThanOrEqual(after + 30_000);
  });

  it('Test 7: acknowledgeHardStop() clears local UI state only (server NOT called)', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();
    await store.getState().init();

    hardStopHandler!({ reason: 'depleted' });
    expect(store.getState().hardStopActive).toBe(true);

    const beforeGet = creditsGetMock.mock.calls.length;
    const beforeCheckout = creditsOpenCheckoutMock.mock.calls.length;
    const beforeCancel = subscriptionCancelMock.mock.calls.length;

    store.getState().acknowledgeHardStop();

    expect(store.getState().hardStopActive).toBe(false);
    expect(store.getState().hardStopReason).toBe(null);
    expect(creditsGetMock.mock.calls.length).toBe(beforeGet);
    expect(creditsOpenCheckoutMock.mock.calls.length).toBe(beforeCheckout);
    expect(subscriptionCancelMock.mock.calls.length).toBe(beforeCancel);
  });

  it("Test 8: openCheckout('topup_small') calls window.sei.creditsOpenCheckout", async () => {
    creditsOpenCheckoutMock.mockResolvedValue({ ok: true });
    const store = await loadStore();
    await store.getState().openCheckout('topup_small');
    expect(creditsOpenCheckoutMock).toHaveBeenCalledWith('topup_small');
  });

  it('Test 9: changePlan(tier) calls creditsChangePlan and re-reads the snapshot', async () => {
    creditsChangePlanMock.mockResolvedValue({ ok: true });
    creditsGetMock.mockResolvedValue(status({ plan: 'party' }));
    const store = await loadStore();

    const res = await store.getState().changePlan('party');

    expect(creditsChangePlanMock).toHaveBeenCalledWith('party');
    expect(res).toEqual({ ok: true });
    // The refresh confirms the new tier without waiting for a push.
    expect(store.getState().plan).toBe('party');
  });

  it('Test 9b: changePlan surfaces a failure code and still re-reads', async () => {
    creditsChangePlanMock.mockResolvedValue({ ok: false, code: 'PROXY_NETWORK' });
    creditsGetMock.mockResolvedValue(status({ plan: 'quest' }));
    const store = await loadStore();

    const res = await store.getState().changePlan('party');

    expect(res).toEqual({ ok: false, code: 'PROXY_NETWORK' });
    expect(store.getState().plan).toBe('quest');
  });

  it('Test 10: cancelSubscription() calls window.sei.subscriptionCancel', async () => {
    subscriptionCancelMock.mockResolvedValue({
      ok: true,
      portalUrl: 'https://polar.sh/my-org/portal',
    });
    const store = await loadStore();
    await store.getState().cancelSubscription();
    expect(subscriptionCancelMock).toHaveBeenCalledTimes(1);
  });

  it('Test 11: reset() invokes the unsubscribe handles returned by the push subscriptions', async () => {
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
    expect(store.getState().plan).toBe('free');
  });

  it('Test 12: no token/dollar/micro field names in the state shape', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();
    await store.getState().init();

    // 260724: the store carries percentages, credit COUNTS and dates only.
    // Every monetary unit stays server-side; the only dollar figures in the app
    // are static copy on the plan cards, the top up packages and the legally
    // required purchase disclosures.
    for (const k of Object.keys(store.getState())) {
      const lower = k.toLowerCase();
      expect(lower).not.toContain('token');
      expect(lower).not.toContain('dollar');
      expect(lower).not.toContain('usd');
      // 'micro' is the µ$ ledger unit — banned from the renderer.
      expect(lower).not.toContain('micro');
    }
  });

  it('Test 13: topUpRequested hands the top up flow to the plan screen', async () => {
    creditsGetMock.mockResolvedValue(status());
    const store = await loadStore();

    expect(store.getState().topUpRequested).toBe(false);
    store.getState().requestTopUp();
    expect(store.getState().topUpRequested).toBe(true);
    store.getState().clearTopUpRequest();
    expect(store.getState().topUpRequested).toBe(false);
  });

  /* -------------------------------------------------------------------------
   * ReceiptScreen auto-navigate transition guard.
   *
   * The store exposes a pure helper `shouldNavigateToReceipt(prev, next)` that
   * returns true when the plan moves UP into a paid tier and false otherwise.
   *
   * Tested at the function level (not via a React render) because the project
   * doesn't ship @testing-library/react.
   * ----------------------------------------------------------------------- */

  it('Test 14: shouldNavigateToReceipt — free → quest returns true (first subscription)', async () => {
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt('free', 'quest')).toBe(true);
  });

  it('Test 15: shouldNavigateToReceipt — quest → party returns true (upgrade is a new charge)', async () => {
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt('quest', 'party')).toBe(true);
  });

  it('Test 16: shouldNavigateToReceipt — party → party returns false (no re-navigation on repeat push)', async () => {
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt('party', 'party')).toBe(false);
  });

  it('Test 17: shouldNavigateToReceipt — null (cold-load) → party returns false', async () => {
    // Cold-load case: prevPlan starts null when the store is fresh; the very
    // first status push must NOT be classified as a transition (otherwise an
    // already-subscribed user would see ReceiptScreen on every app start).
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt(null, 'party')).toBe(false);
  });

  it('Test 18: shouldNavigateToReceipt — party → quest / party → free return false (downgrades)', async () => {
    const mod = await import('./useCreditsStore');
    expect(mod.shouldNavigateToReceipt('party', 'quest')).toBe(false);
    expect(mod.shouldNavigateToReceipt('party', 'free')).toBe(false);
  });

  it('Test 19: seed populates subscription_status_raw from creditsGet', async () => {
    creditsGetMock.mockResolvedValue(status({ subscription_status_raw: 'past_due' }));
    const store = await loadStore();
    await store.getState().init();
    expect(store.getState().subscription_status_raw).toBe('past_due');
  });

  it('Test 20: ends_at propagates through seed and push (cancel-scheduled → resumed)', async () => {
    creditsGetMock.mockResolvedValue(
      status({
        plan: 'party',
        ends_at: '2099-01-01T00:00:00Z',
        subscription_status_raw: 'cancelled',
      }),
    );
    const store = await loadStore();
    await store.getState().init();
    expect(store.getState().ends_at).toBe('2099-01-01T00:00:00Z');

    statusHandler!(
      status({ plan: 'party', ends_at: null, subscription_status_raw: 'active' }),
    );
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
    plan: 'free' as PlanTier,
    extra_credits_total: 0,
    subscription_status_raw: null,
  };

  it('top up: true when the extra-credits total grew', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed('topup_small', base, {
        plan: 'free',
        extra_credits_total: 800,
        subscription_status_raw: null,
      }),
    ).toBe(true);
  });

  it('top up: false while the total is unchanged', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed('topup_large', base, {
        plan: 'free',
        extra_credits_total: 0,
        subscription_status_raw: null,
      }),
    ).toBe(false);
  });

  it('subscription: true once the purchased tier lands', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed('party', base, {
        plan: 'party',
        extra_credits_total: 0,
        subscription_status_raw: null,
      }),
    ).toBe(true);
  });

  it('subscription: true on status→active even before the tier lands', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed('quest', base, {
        plan: 'free',
        extra_credits_total: 0,
        subscription_status_raw: 'active',
      }),
    ).toBe(true);
  });

  it('subscription: false while nothing has changed', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed('quest', base, {
        plan: 'free',
        extra_credits_total: 0,
        subscription_status_raw: null,
      }),
    ).toBe(false);
  });

  it('resume: true when the sub flips off cancelled (cancelled→active)', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed(
        'resume',
        { plan: 'party', extra_credits_total: 0, subscription_status_raw: 'cancelled' },
        { plan: 'party', extra_credits_total: 0, subscription_status_raw: 'active' },
      ),
    ).toBe(true);
  });

  it('resume: false while still cancelled', async () => {
    const { isPurchaseConfirmed } = await import('./useCreditsStore');
    expect(
      isPurchaseConfirmed(
        'resume',
        { plan: 'party', extra_credits_total: 0, subscription_status_raw: 'cancelled' },
        { plan: 'party', extra_credits_total: 0, subscription_status_raw: 'cancelled' },
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

  it('beginPurchase(topup_small): opens checkout, polls, confirms on a credit grant', async () => {
    creditsOpenCheckoutMock.mockResolvedValue({ ok: true });
    // The poll's refresh() reads the granted extra credits.
    creditsGetMock.mockResolvedValue(status({ extra_credits_total: 800 }));
    const mod = await import('./useCreditsStore');
    const store = mod.useCreditsStore;

    await store.getState().beginPurchase('topup_small');
    expect(store.getState().checkoutStatus).toBe('waiting');
    expect(creditsOpenCheckoutMock).toHaveBeenCalledWith('topup_small');

    await vi.advanceTimersByTimeAsync(mod.CHECKOUT_POLL_INTERVAL_MS);
    expect(store.getState().checkoutStatus).toBe('confirmed');
    expect(store.getState().extra_credits_total).toBe(800);
  });

  it('beginPurchase(party, alreadyOpened): does NOT reopen checkout; confirms on the tier landing', async () => {
    creditsGetMock.mockResolvedValue(
      status({ plan: 'party', subscription_status_raw: 'active' }),
    );
    const mod = await import('./useCreditsStore');
    const store = mod.useCreditsStore;

    await store.getState().beginPurchase('party', { alreadyOpened: true });
    expect(creditsOpenCheckoutMock).not.toHaveBeenCalled();
    expect(store.getState().checkoutStatus).toBe('waiting');

    await vi.advanceTimersByTimeAsync(mod.CHECKOUT_POLL_INTERVAL_MS);
    expect(store.getState().checkoutStatus).toBe('confirmed');
  });

  it('beginPurchase: transitions to timeout after the wall-clock cap with no change', async () => {
    creditsOpenCheckoutMock.mockResolvedValue({ ok: true });
    creditsGetMock.mockResolvedValue(status()); // nothing moved vs the baseline
    const mod = await import('./useCreditsStore');
    const store = mod.useCreditsStore;

    await store.getState().beginPurchase('topup_small');
    await vi.advanceTimersByTimeAsync(mod.CHECKOUT_MAX_WAIT_MS);
    expect(store.getState().checkoutStatus).toBe('timeout');
  });

  it('dismissCheckout(): resets to idle and stops polling', async () => {
    creditsOpenCheckoutMock.mockResolvedValue({ ok: true });
    creditsGetMock.mockResolvedValue(status());
    const mod = await import('./useCreditsStore');
    const store = mod.useCreditsStore;

    await store.getState().beginPurchase('topup_small');
    store.getState().dismissCheckout();
    expect(store.getState().checkoutStatus).toBe('idle');
    expect(store.getState().checkoutKind).toBe(null);

    creditsGetMock.mockClear();
    await vi.advanceTimersByTimeAsync(mod.CHECKOUT_POLL_INTERVAL_MS * 3);
    expect(creditsGetMock).not.toHaveBeenCalled();
  });

  it('beginResume(): opens the billing portal (not checkout), polls, confirms when the sub flips off cancelled', async () => {
    subscriptionCancelMock.mockResolvedValue({ ok: true, portalUrl: 'https://portal.example' });
    // After the user resumes in the portal, creditsGet reports active again.
    creditsGetMock.mockResolvedValue(
      status({ plan: 'party', subscription_status_raw: 'active', ends_at: null }),
    );
    const mod = await import('./useCreditsStore');
    const store = mod.useCreditsStore;
    // Start from the "to be cancelled" state so the baseline is 'cancelled'.
    store.setState({
      plan: 'party',
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
