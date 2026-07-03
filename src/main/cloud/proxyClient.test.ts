/**
 * Tests for src/main/cloud/proxyClient — Phase 13 typed wrapper over the
 * trial-claim Edge Function, Supabase ledger_balance + my_subscription reads
 * (260525-pbn task 4 view rename, H8), and Polar checkout/customer-portal
 * session launches (proxy-minted; 2026-06 migration off Lemon Squeezy).
 *
 * Covers each of the five public methods across:
 *   - the no-session short-circuit (PROXY_NO_SESSION)
 *   - the happy path
 *   - the error / already-claimed branch
 *
 * Mock strategy: vi.mock for `electron` (shell.openExternal), the
 * `edgeFunctionClient` (callEdgeFunction), the `supabaseClient` singleton
 * (getClient.auth.getSession + table builders), and `apiKeyStore`
 * (getAiBackendKind). The mocks let us assert the URL composition + the
 * Promise.all fan-out without touching the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Module mocks --------------------------------------------------------

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../auth/edgeFunctionClient', () => ({
  callEdgeFunction: vi.fn(),
}));

vi.mock('../auth/supabaseClient', () => ({
  getClient: vi.fn(),
  getAuthedClient: vi.fn(),
}));

vi.mock('../apiKeyStore', () => ({
  getAiBackendKind: vi.fn().mockResolvedValue('cloud-proxy'),
}));

// 260603 anti-abuse: trialClaim now sends the device-global device_id. Mock it
// to a deterministic UUID so the body assertion is stable.
const MOCK_DEVICE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
vi.mock('../auth/deviceId', () => ({
  getDeviceId: vi.fn().mockResolvedValue(MOCK_DEVICE_ID),
}));

// ---- Mock state ----------------------------------------------------------

interface MockSession {
  access_token: string;
  user: { id: string };
}

interface MockState {
  session: MockSession | null;
  ledgerBalance: { balance_micro: number | string } | null;
  /**
   * 260525-rfj Task 2: optional pre/post sequence for ledger_balance reads.
   * trialClaim() reads ledger_balance BEFORE the Edge Function call and
   * AGAIN AFTER (the M10 uniform 202 envelope hides claim state, so the
   * client uses a balance delta to decide success vs already-claimed).
   * When this array is set, successive `.from('ledger_balance').maybeSingle()`
   * calls drain it in order; once empty we fall back to `ledgerBalance`.
   */
  ledgerBalanceSequence: Array<{ balance_micro: number | string } | null> | null;
  subscription: { status: string; renews_at: string | null; ends_at: string | null } | null;
  /**
   * 260524-0ka B1: mock the ACTUAL ledger_consumption schema columns
   * (`micro`, `deducted_at`). The 260523-t8d shape referenced the phantom
   * per-token-count columns (see the proxyClient.ts B1 docblock for the
   * full migration note) that never existed in the database — the buggy
   * query silently returned an error and `data` was null. Tests that
   * don't care about tokens_per_min can leave this empty (the field is
   * optional on CreditsStatus and the implementation omits it when
   * consumptionRows.length < MIN_SIGNAL_ROWS = 20).
   */
  ledgerConsumption: Array<{ micro: number | string; deducted_at: string }>;
  /**
   * 260524-0ka B5: optional error-injection slot for the
   * ledger_consumption thenable, used by the "query errors → tokens_per_min
   * undefined + console.warn fires" test. When set, the mock's
   * `.from('ledger_consumption')` thenable yields { data: null, error }
   * instead of { data: state.ledgerConsumption, error: null }.
   */
  ledgerConsumptionError: { code: string; message: string } | null;
  /**
   * 260602-hbr: the caller's grant rows. creditsGet() sums credits_micro to
   * get total AVAILABLE credits for usage_pct. Refund rows are negative.
   * 20260603000000: `kind` drives `trial_claimed` (presence of a kind='trial'
   * grant) now that the trial is account-bound (trial_claims dropped).
   */
  ledgerGrants: Array<{ credits_micro: number | string; kind?: string }>;
}

const state: MockState = {
  session: null,
  ledgerBalance: null,
  ledgerBalanceSequence: null,
  subscription: null,
  ledgerConsumption: [],
  ledgerConsumptionError: null,
  ledgerGrants: [],
};

function resetState(): void {
  state.session = null;
  state.ledgerBalance = null;
  state.ledgerBalanceSequence = null;
  state.subscription = null;
  state.ledgerConsumption = [];
  state.ledgerConsumptionError = null;
  state.ledgerGrants = [];
}

/**
 * Build a hand-rolled mock SupabaseClient. The `.from(table)` builder returns
 * a chain that ultimately yields `{ data, error }` via `maybeSingle()` — we
 * dispatch on the `table` name to return the right slice of `state`.
 */
function makeMockSupabase(): unknown {
  return {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: state.session },
        error: null,
      })),
    },
    from: vi.fn((table: string) => {
      // ITEM 4: ledger_consumption is read with .select().eq().eq().gte()
      // and is `await`ed directly (no .maybeSingle()) — it yields an array
      // via the thenable contract. Other tables keep the .maybeSingle()
      // shape they had before.
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        gte: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => {
          if (table === 'ledger_balance') {
            // 260525-rfj Task 2: when a sequence is configured, drain it
            // call-by-call so the trialClaim() pre/post pattern can exercise
            // a delta. Falls back to the steady-state ledgerBalance when
            // exhausted or unset.
            if (state.ledgerBalanceSequence && state.ledgerBalanceSequence.length > 0) {
              const next = state.ledgerBalanceSequence.shift() ?? null;
              return { data: next, error: null };
            }
            return { data: state.ledgerBalance, error: null };
          }
          // 260525-pbn task 4 (H8): proxyClient now reads via the
          // my_subscription security_invoker view instead of the base
          // table. Mock continues to dispatch on state.subscription for
          // the same shape ({status, renews_at, ends_at}).
          if (table === 'my_subscription') return { data: state.subscription, error: null };
          return { data: null, error: null };
        }),
        // PostgrestFilterBuilder is thenable — awaiting it resolves to
        // { data, error }. We expose that for the ledger_consumption query
        // (it doesn't call .maybeSingle()). 260524-0ka B5: honour the
        // ledgerConsumptionError injection slot so the "console.warn on
        // query error" test can drive the defense-in-depth path.
        then: (
          resolve: (v: { data: unknown; error: { code: string; message: string } | null }) => void,
        ) => {
          if (table === 'ledger_consumption') {
            if (state.ledgerConsumptionError) {
              resolve({ data: null, error: state.ledgerConsumptionError });
            } else {
              resolve({ data: state.ledgerConsumption, error: null });
            }
          } else if (table === 'my_grants') {
            // creditsGet() reads the curated my_grants view (kind +
            // credits_micro), awaiting the thenable directly (no .maybeSingle()).
            resolve({ data: state.ledgerGrants, error: null });
          } else {
            resolve({ data: null, error: null });
          }
        },
      };
      return chain;
    }),
  };
}

// ---- Tests ---------------------------------------------------------------

beforeEach(async () => {
  resetState();
  vi.clearAllMocks();

  const { getClient, getAuthedClient } = await import('../auth/supabaseClient');
  // getClient backs getSessionOrNull (auth.getSession); getAuthedClient backs
  // the RLS-scoped reads. Both resolve against the same `state`-driven mock so
  // the session check and the data reads stay consistent.
  (getClient as ReturnType<typeof vi.fn>).mockReturnValue(makeMockSupabase());
  (getAuthedClient as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockSupabase());
});

describe('trialClaim', () => {
  it('returns PROXY_NO_SESSION when the user is not signed in', async () => {
    const { trialClaim } = await import('./proxyClient');
    const res = await trialClaim();
    expect(res).toEqual({ ok: false, code: 'PROXY_NO_SESSION' });
  });

  // 260525-rfj Task 2 (M10): the Edge Function now returns a uniform 202
  // envelope `{ status: 'received' }` across all three claim-disposition
  // branches. proxyClient.trialClaim() reads ledger_balance BEFORE the call
  // and AGAIN AFTER, and uses the delta to decide success vs already-claimed.
  // The old 409-branch and `code: 'already_claimed'` paths are gone.

  it('260525-rfj — returns ok:true after a successful 202 (balance delta > 0)', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    // Pre: balance 0; Post: balance 1_000_000 (server granted the trial).
    state.ledgerBalanceSequence = [
      { balance_micro: 0 },
      { balance_micro: 1_000_000 },
    ];

    const { callEdgeFunction } = await import('../auth/edgeFunctionClient');
    (callEdgeFunction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: { status: 'received' },
    });

    const { trialClaim } = await import('./proxyClient');
    const res = await trialClaim();

    expect(res).toEqual({ ok: true, credits_micro: 1_000_000 });
    // 260603: the device-global device_id is included so the server can enforce
    // one-trial-per-device. Identity still comes from the bearer JWT.
    expect(callEdgeFunction).toHaveBeenCalledWith('trial-claim', {
      jwt: 'jwt-xyz',
      body: { device_id: MOCK_DEVICE_ID },
    });
  });

  it('260525-rfj — returns PROXY_ALREADY_CLAIMED after a 202 with no balance delta AND an existing account trial grant', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    // Pre and post both 1_000_000 — server's uniform 202 fired but this
    // account already claimed its trial, so balance is unchanged.
    state.ledgerBalanceSequence = [
      { balance_micro: 1_000_000 },
      { balance_micro: 1_000_000 },
    ];
    // The account HOLDS a kind='trial' grant → the no-delta is because THIS
    // account already claimed (not the per-device gate). proxyClient reads
    // my_grants to disambiguate.
    state.ledgerGrants = [{ credits_micro: 1_000_000, kind: 'trial' }];

    const { callEdgeFunction } = await import('../auth/edgeFunctionClient');
    (callEdgeFunction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: { status: 'received' },
    });

    const { trialClaim } = await import('./proxyClient');
    const res = await trialClaim();

    expect(res).toEqual({ ok: false, code: 'PROXY_ALREADY_CLAIMED' });
  });

  it('260605 — returns PROXY_DEVICE_CLAIMED after a 202 with no balance delta AND no account trial grant (per-device gate)', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-2' } };
    // No delta — the grant never landed on THIS account. And my_grants has no
    // kind='trial' row → the refusal came from the per-DEVICE gate (this
    // machine already spent its one trial under a different account), NOT the
    // account gate. The renderer surfaces honest "this device already used its
    // free trial" copy instead of the misleading account-level message.
    state.ledgerBalanceSequence = [
      { balance_micro: 0 },
      { balance_micro: 0 },
    ];
    state.ledgerGrants = []; // account never received any grant

    const { callEdgeFunction } = await import('../auth/edgeFunctionClient');
    (callEdgeFunction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: { status: 'received' },
    });

    const { trialClaim } = await import('./proxyClient');
    const res = await trialClaim();

    expect(res).toEqual({ ok: false, code: 'PROXY_DEVICE_CLAIMED' });
  });

  it('260525-rfj — returns PROXY_NETWORK on 403 email_not_confirmed (H2)', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    state.ledgerBalanceSequence = [{ balance_micro: 0 }]; // only the pre-read happens

    const { callEdgeFunction } = await import('../auth/edgeFunctionClient');
    (callEdgeFunction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: { ok: false, code: 'email_not_confirmed', message: 'Please verify your email…' },
    });

    const { trialClaim } = await import('./proxyClient');
    const res = await trialClaim();

    // No dedicated sentinel yet — the renderer surfaces PROXY_NETWORK. A
    // future quick task can wire a PROXY_EMAIL_NOT_CONFIRMED sentinel once
    // the renderer has copy for it (tracked in 260525-rfj SUMMARY).
    expect(res).toEqual({ ok: false, code: 'PROXY_NETWORK' });
  });

  it('260525-rfj — returns PROXY_NETWORK on a status:0 (network/abort) failure', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    state.ledgerBalanceSequence = [{ balance_micro: 0 }];

    const { callEdgeFunction } = await import('../auth/edgeFunctionClient');
    (callEdgeFunction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 0,
      message: 'network',
    });

    const { trialClaim } = await import('./proxyClient');
    const res = await trialClaim();
    expect(res).toEqual({ ok: false, code: 'PROXY_NETWORK' });
  });
});

describe('creditsGet', () => {
  it('returns the depleted placeholder with the REAL backend kind when there is no session', async () => {
    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    // ITEM 4 (quick/260523-t8d): the placeholder response stays minimal —
    // remaining_tokens + tokens_per_min are not populated when there is no
    // session, and the renderer's tokensRemainingToPlaytime() shows
    // "Calculating…" for undefined inputs.
    expect(res).toEqual({
      remaining_pct: 0,
      plan: 'depleted',
      renews_at: null,
      ends_at: null,
      trial_claimed: false,
      // 260703: no longer a hardcoded 'local' — the placeholder reports the
      // persisted getAiBackendKind() (mocked 'cloud-proxy' above) so a
      // transient getSession() miss can't paint a cloud profile as BYOK on
      // the ACCOUNT MODE surface while the calls keep spending credits.
      ai_backend_kind: 'cloud-proxy',
      // quick/260525-sbo Task 8: subscription_status_raw is part of the
      // no-session placeholder — null when the caller has never subscribed
      // (or is signed out). SettingsScreen reads this to decide whether to
      // render the past-due / paused contextual banner.
      subscription_status_raw: null,
    });
  });

  it('computes pct=50% and plan=trial for a $2.50/$5 trial balance', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    // 2_500_000 µ$ against the 5_000_000 µ$ trial cap → 50%.
    state.ledgerBalance = { balance_micro: 2_500_000 };
    // 260602-hbr: $5 trial grant; 2.5M of 5M consumed → usage_pct 50%.
    // 20260603000000: kind='trial' grant drives trial_claimed + plan='trial'.
    state.ledgerGrants = [{ credits_micro: 5_000_000, kind: 'trial' }];
    state.subscription = null;

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res.remaining_pct).toBe(50);
    expect(res.usage_pct).toBe(50);
    expect(res.plan).toBe('trial');
    expect(res.trial_claimed).toBe(true);
    expect(res.ai_backend_kind).toBe('cloud-proxy');
  });

  it('returns plan=unlimited for an active subscriber', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    // Subscriber cap is 20_000_000 µ$; 10_000_000 µ$ → 50%.
    state.ledgerBalance = { balance_micro: 10_000_000 };
    // 260602-hbr: $20 of grants, half consumed → usage_pct 50%.
    state.ledgerGrants = [{ credits_micro: 20_000_000, kind: 'subscription' }];
    state.subscription = {
      status: 'active',
      renews_at: '2026-06-22T00:00:00Z',
      ends_at: null,
    };

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res.plan).toBe('unlimited');
    expect(res.renews_at).toBe('2026-06-22T00:00:00Z');
    // 10_000_000 / 20_000_000 = 50%.
    expect(res.remaining_pct).toBe(50);
    expect(res.usage_pct).toBe(50);
  });

  it('cancel-scheduled sub (cancelled + future ends_at) stays plan=unlimited + exposes ends_at', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    state.ledgerBalance = { balance_micro: 10_000_000 };
    state.ledgerGrants = [{ credits_micro: 20_000_000, kind: 'subscription' }];
    // "To be cancelled": still usable until ends_at in the future.
    state.subscription = {
      status: 'cancelled',
      renews_at: '2099-01-01T00:00:00Z',
      ends_at: '2099-01-01T00:00:00Z',
    };

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    // Keeps the subscribed interface (full access) until the end date.
    expect(res.plan).toBe('unlimited');
    expect(res.ends_at).toBe('2099-01-01T00:00:00Z');
    expect(res.subscription_status_raw).toBe('cancelled');
  });

  it('cancelled sub past ends_at is no longer unlimited', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    state.ledgerBalance = { balance_micro: 5_000_000 };
    state.ledgerGrants = [{ credits_micro: 20_000_000, kind: 'subscription' }];
    state.subscription = {
      status: 'cancelled',
      renews_at: '2020-01-01T00:00:00Z',
      ends_at: '2020-01-01T00:00:00Z',
    };

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    // End date has passed → not subscribed anymore (falls through to pack/depleted).
    expect(res.plan).not.toBe('unlimited');
    expect(res.subscription_status_raw).toBe('cancelled');
  });

  it('returns plan=depleted when balance hits 0 and no active sub', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    state.ledgerBalance = { balance_micro: 0 };
    // 260602-hbr: granted $5 but fully consumed → usage_pct 100%.
    state.ledgerGrants = [{ credits_micro: 5_000_000, kind: 'trial' }];
    state.subscription = null;

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res.plan).toBe('depleted');
    expect(res.remaining_pct).toBe(0);
    expect(res.usage_pct).toBe(100);
  });

  it('handles bigint balances expressed as a string from supabase-js', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    // supabase-js returns bigint as a string for very large values; we use a
    // normal-magnitude string here to assert BigInt(string) parses correctly.
    state.ledgerBalance = { balance_micro: '5000000' };
    state.subscription = null;
    // No grant rows → no trial grant → plan='pack'.
    state.ledgerGrants = [{ credits_micro: '5000000', kind: 'pack' }];

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    // 5_000_000 against the 5_000_000 cap → 100%, plan='pack' (no trial grant).
    expect(res.remaining_pct).toBe(100);
    expect(res.plan).toBe('pack');
  });
});

describe('openCheckout', () => {
  it('returns PROXY_NO_SESSION when the user is not signed in', async () => {
    const { openCheckout } = await import('./proxyClient');
    const res = await openCheckout('pack');
    expect(res).toEqual({ ok: false, code: 'PROXY_NO_SESSION' });
  });

  it('asks the proxy to mint a checkout session and RETURNS the validated URL (pack)', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-abc-123' } };
    const checkoutUrl = 'https://buy.polar.sh/polar_c_pack123';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, url: checkoutUrl }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { shell } = await import('electron');
    const { openCheckout } = await import('./proxyClient');
    const res = await openCheckout('pack');

    // openCheckout returns the allowlist-validated URL; the main IPC handler
    // is what opens it (in the system browser via shell.openExternal, 260603).
    // The proxyClient function itself never opens anything.
    expect(res).toEqual({ ok: true, url: checkoutUrl });
    expect(shell.openExternal).not.toHaveBeenCalled();
    // The proxy mints the session server-side; the client only sends `kind`
    // and its bearer JWT (user_id is derived from the JWT, never the body).
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/billing/checkout'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-xyz' }),
        body: JSON.stringify({ kind: 'pack' }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it('passes kind=subscription through to the proxy', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, url: 'https://buy.polar.sh/polar_c_sub456' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { openCheckout } = await import('./proxyClient');
    await openCheckout('subscription');

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/billing/checkout'),
      expect.objectContaining({ body: JSON.stringify({ kind: 'subscription' }) }),
    );
    vi.unstubAllGlobals();
  });

  it('rejects a non-allowlisted checkout URL from the proxy (PROXY_NETWORK, no openExternal)', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, url: 'https://evil.attacker.tld/checkout' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { shell } = await import('electron');
    const { openCheckout } = await import('./proxyClient');
    const res = await openCheckout('pack');

    expect(res).toEqual({ ok: false, code: 'PROXY_NETWORK' });
    expect(shell.openExternal).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('subscriptionStatus', () => {
  it('returns the none/inactive placeholder when there is no session', async () => {
    const { subscriptionStatus } = await import('./proxyClient');
    const res = await subscriptionStatus();
    expect(res).toEqual({ active: false, status: 'none', renews_at: null, ends_at: null });
  });

  it('returns active=true when the row.status is active', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    state.subscription = {
      status: 'active',
      renews_at: '2026-06-22T00:00:00Z',
      ends_at: null,
    };

    const { subscriptionStatus } = await import('./proxyClient');
    const res = await subscriptionStatus();
    expect(res.active).toBe(true);
    expect(res.status).toBe('active');
    expect(res.renews_at).toBe('2026-06-22T00:00:00Z');
  });

  it('returns active=false when status is cancelled', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    state.subscription = {
      status: 'cancelled',
      renews_at: null,
      ends_at: '2026-06-22T00:00:00Z',
    };

    const { subscriptionStatus } = await import('./proxyClient');
    const res = await subscriptionStatus();
    expect(res.active).toBe(false);
    expect(res.status).toBe('cancelled');
    expect(res.ends_at).toBe('2026-06-22T00:00:00Z');
  });
});

describe('cancelSubscription', () => {
  it(
    'fetches the signed customer-portal URL from the proxy and opens it (ITEM 8 / quick/260523-t8d)',
    async () => {
      // WR-04 + ITEM 8: signed-in users route through the proxy's
      // /billing/customer-portal endpoint. The proxy mints a Polar customer
      // session server-side and returns the signed customer_portal_url.
      state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
      const signedUrl =
        'https://polar.sh/my-org/portal?customer_session_token=abc123';
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, portalUrl: signedUrl }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const { shell } = await import('electron');
      const { cancelSubscription } = await import('./proxyClient');
      const res = await cancelSubscription();

      expect(res).toEqual({ ok: true, portalUrl: signedUrl });
      expect(shell.openExternal).toHaveBeenCalledWith(signedUrl);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/billing/customer-portal'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer jwt-xyz',
          }),
        }),
      );
      vi.unstubAllGlobals();
    },
  );

  it('returns PROXY_NO_PORTAL_URL when the proxy returns no portalUrl (ITEM 8)', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: 'user-1' } };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, code: 'no_subscription' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { cancelSubscription } = await import('./proxyClient');
    const res = await cancelSubscription();

    expect(res).toEqual({ ok: false, code: 'PROXY_NO_PORTAL_URL' });
    vi.unstubAllGlobals();
  });

  it('returns PROXY_NO_SESSION when signed out (WR-04 — symmetric session gate)', async () => {
    state.session = null;
    const { shell } = await import('electron');
    const { cancelSubscription } = await import('./proxyClient');
    const res = await cancelSubscription();

    expect(res).toEqual({ ok: false, code: 'PROXY_NO_SESSION' });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

// ---- 260602-hbr usage_pct -----------------------------------------------
// usage_pct = used / available × 100, where available = SUM(ledger_grants)
// and used = available − balance (clamped ≥ 0). Replaces the removed
// personalized tokens_per_min derivation (no more rolling-24h
// ledger_consumption read). Rounded to REMAINING_PCT_STEP=5.

const USER_ID = '11111111-2222-3333-4444-555555555555';

describe('260602-hbr usage_pct (used/available)', () => {
  it('fresh grant, nothing used → usage_pct 0', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
    state.ledgerBalance = { balance_micro: 3_825_000 };
    state.ledgerGrants = [{ credits_micro: 3_825_000 }]; // a Quest pack, untouched
    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res.usage_pct).toBe(0);
  });

  it('partial usage → percent of total granted (3M of 4M → 75%)', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
    state.ledgerBalance = { balance_micro: 1_000_000 };
    state.ledgerGrants = [{ credits_micro: 4_000_000 }];
    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res.usage_pct).toBe(75);
  });

  it('EDGE: subscription + Quest-pack top-up is ADDITIVE on available', async () => {
    // The named edge case: a subscriber tops up with a Quest pack. Both grant
    // rows sum into `available`, so the denominator GROWS and the bar moves
    // LEFT — not a reset. sub $16.65 + pack $3.825 = $20.475 granted.
    state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
    state.ledgerBalance = { balance_micro: 10_000_000 }; // $10.475 used
    state.ledgerGrants = [
      { credits_micro: 16_650_000 }, // Party subscription grant
      { credits_micro: 3_825_000 }, // Quest pack top-up
    ];
    state.subscription = { status: 'active', renews_at: null, ends_at: null };
    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res.plan).toBe('unlimited');
    // used 10_475_000 / granted 20_475_000 = 51.2% → round to step 5 → 50.
    expect(res.usage_pct).toBe(50);
  });

  it('EDGE: multiple Quest packs all add to available', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
    state.ledgerBalance = { balance_micro: 3_825_000 }; // used exactly two of three packs
    state.ledgerGrants = [
      { credits_micro: 3_825_000 },
      { credits_micro: 3_825_000 },
      { credits_micro: 3_825_000 },
    ];
    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    // granted 11_475_000, used 7_650_000 → 66.7% → round to step 5 → 65.
    expect(res.usage_pct).toBe(65);
  });

  it('EDGE: refund (negative grant row) shrinks available symmetrically', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
    // granted 10M − 4M refund = 6M available; balance 3M → used 3M → 50%.
    state.ledgerBalance = { balance_micro: 3_000_000 };
    state.ledgerGrants = [
      { credits_micro: 10_000_000 },
      { credits_micro: -4_000_000 },
    ];
    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res.usage_pct).toBe(50);
  });

  it('no grants at all → usage_pct 0 (no divide-by-zero)', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
    state.ledgerBalance = { balance_micro: 0 };
    state.ledgerGrants = [];
    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res.usage_pct).toBe(0);
  });

  it('grants expressed as strings from supabase-js sum correctly', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
    state.ledgerBalance = { balance_micro: '5000000' };
    state.ledgerGrants = [{ credits_micro: '10000000' }]; // 5M of 10M → 50%
    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res.usage_pct).toBe(50);
  });
});

// ---- 260524-0ka C3 ------------------------------------------------------
// LEDGER-BALANCE-DIAGNOSIS.md verdict: Branch B (doc-only contract). The
// C3 tests pin the creditsGet shape contract for three edge cases of the
// ledger_balance view's return:
//   1. NULL row (user has no auth.users row visible to caller — either
//      hard-deleted, or MCP-side role-mismatch). Coalesced to 0n via
//      `?? 0` per the C2 contract doc-block in proxyClient.ts.
//   2. Positive balance + zero consumption (fresh grant, hasn't been
//      used yet — tokens_per_min undefined per B3 noise-floor gate).
//   3. Mid-reservation balance (view subtracts reserved+settled
//      server-side; client just sees the net).
// All three MUST NOT throw and must return a sensible CreditsStatus shape.

describe('260524-0ka C3 — creditsGet shape for ledger_balance edge cases', () => {
  it('C3 user with zero grants ever: ledger_balance NULL → plan=depleted, remaining_pct=0, remaining_tokens=0', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
    state.ledgerBalance = null; // .maybeSingle() returns { data: null, error: null }
    state.subscription = null;
    state.ledgerGrants = [];

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();

    expect(res.plan).toBe('depleted');
    expect(res.remaining_pct).toBe(0);
    expect(res.remaining_tokens).toBe(0);
    // 260602-hbr: no grants → usage_pct 0 (no divide-by-zero).
    expect(res.usage_pct).toBe(0);
    expect(res.ai_backend_kind).toBe('cloud-proxy');
  });

  it('C3 user with grants but zero consumption: positive balance, usage_pct 0', async () => {
    state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
    state.ledgerBalance = { balance_micro: 18_500_000 };
    // 260602-hbr: balance == granted → nothing used yet → usage_pct 0.
    state.ledgerGrants = [{ credits_micro: 18_500_000, kind: 'pack' }];
    state.subscription = null;

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();

    // No trial grant + non-zero balance + no active sub → 'pack' label.
    expect(res.plan).toBe('pack');
    // 18_500_000 µ$ / MICRO_PER_TOKEN_BLENDED (2) = 9_250_000 tokens
    expect(res.remaining_tokens).toBe(9_250_000);
    expect(res.usage_pct).toBe(0);
  });

  it('C3 user mid-reservation: ledger_balance reflects subtracted reservation (no throw)', async () => {
    // The ledger_balance VIEW subtracts both reserved AND settled consumption
    // from grants server-side; the client just sees the net 800_000 (1M grant
    // − 200K reserved). 260602-hbr: usage_pct uses the same net balance, so a
    // reservation in flight counts as "used" (200K of 1M granted → 20%).
    state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
    state.ledgerBalance = { balance_micro: 800_000 };
    state.ledgerGrants = [{ credits_micro: 1_000_000, kind: 'pack' }];
    state.subscription = null;

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();

    expect(res.remaining_tokens).toBe(400_000); // 800_000 / 2
    expect(res.usage_pct).toBe(20); // 200K used / 1M granted
    // No trial grant + positive balance + no active sub → 'pack'.
    expect(res.plan).toBe('pack');
  });
});

