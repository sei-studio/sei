/**
 * Tests for src/main/cloud/proxyClient — the typed wrapper over the proxy's
 * my_plan / my_subscription views and the Polar checkout, plan-change and
 * customer-portal endpoints (all proxy-minted).
 *
 * Covers each public method across:
 *   - the no-session short-circuit (PROXY_NO_SESSION)
 *   - the happy path
 *   - the error branch
 *
 * Mock strategy: vi.mock for `electron` (shell.openExternal), the
 * `edgeFunctionClient` (callEdgeFunction), the `supabaseClient` singleton
 * (getClient.auth.getSession + table builders), and `apiKeyStore`
 * (getAiBackendKind). The mocks let us assert the URL composition + the
 * Promise.all fan-out without touching the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreditsStatus } from '../../shared/ipc';

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

// ---- Mock state ----------------------------------------------------------

interface MockSession {
  access_token: string;
  user: { id: string };
}

/**
 * A `my_plan` row as PostgREST would hand it back. Deliberately typed loosely:
 * the tests exercise the client's defensive coercion (bigints arriving as
 * strings, unknown tiers, missing columns).
 */
type MockPlanRow = Record<string, unknown> | null;

interface MockState {
  session: MockSession | null;
  plan: MockPlanRow;
  /** Non-null → the my_plan read fails (e.g. view missing pre-migration). */
  planError: { message: string } | null;
  subscription: { status: string; renews_at: string | null; ends_at: string | null } | null;
  /** usage_periods row behind the feedback-reward gate. null = no row yet. */
  usagePeriod: { feedback_reset_at: string | null } | null;
  /** Non-null → the usage_periods read fails (gate falls back to UNKNOWN). */
  usagePeriodError: { message: string } | null;
}

const state: MockState = {
  session: null,
  plan: null,
  planError: null,
  subscription: null,
  usagePeriod: null,
  usagePeriodError: null,
};

function resetState(): void {
  state.session = null;
  state.plan = null;
  state.planError = null;
  state.subscription = null;
  state.usagePeriod = null;
  state.usagePeriodError = null;
}

/** A complete, healthy my_plan row. Override fields per test. */
function planRow(over: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...over,
  };
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
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        gte: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => {
          // 260724: creditsGet reads the single self-filtering my_plan view.
          if (table === 'my_plan') return { data: state.plan, error: state.planError };
          // subscriptionStatus still reads the my_subscription view.
          if (table === 'my_subscription') return { data: state.subscription, error: null };
          if (table === 'usage_periods')
            return { data: state.usagePeriod, error: state.usagePeriodError };
          return { data: null, error: null };
        }),
        // PostgrestFilterBuilder is thenable — awaiting it resolves to
        // { data, error }. Nothing in the current client awaits a builder
        // directly, but keep the contract so a future query doesn't hang.
        then: (resolve: (v: { data: unknown; error: null }) => void) => {
          resolve({ data: null, error: null });
        },
      };
      return chain;
    }),
  };
}

const USER_ID = '11111111-2222-3333-4444-555555555555';

function signIn(): void {
  state.session = { access_token: 'jwt-xyz', user: { id: USER_ID } };
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

describe('creditsGet', () => {
  it('returns the free placeholder with the REAL backend kind when there is no session', async () => {
    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res).toEqual<CreditsStatus>({
      plan: 'free',
      usage_pct: 0,
      over_limit: false,
      resets_at: '',
      extra_credits_used: 0,
      extra_credits_total: 0,
      renews_at: null,
      ends_at: null,
      subscription_status_raw: null,
      // 260703: the persisted backend kind, never a hardcoded 'local'.
      ai_backend_kind: 'cloud-proxy',
      // Signed out: nothing to claim against.
      feedback_reward_available: false,
    });
  });

  it('passes the my_plan row straight through', async () => {
    signIn();
    state.plan = planRow({
      plan: 'quest',
      usage_pct: 42,
      resets_at: '2026-08-01T00:00:00Z',
      extra_credits_used: 120,
      extra_credits_total: 800,
      renews_at: '2026-08-14T00:00:00Z',
      subscription_status_raw: 'active',
    });

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();

    expect(res.plan).toBe('quest');
    expect(res.usage_pct).toBe(42);
    expect(res.over_limit).toBe(false);
    expect(res.resets_at).toBe('2026-08-01T00:00:00Z');
    expect(res.extra_credits_used).toBe(120);
    expect(res.extra_credits_total).toBe(800);
    expect(res.renews_at).toBe('2026-08-14T00:00:00Z');
    expect(res.subscription_status_raw).toBe('active');
    expect(res.ai_backend_kind).toBe('cloud-proxy');
  });

  // 260726: the feedback banner is gated on the SERVER, not the per-profile
  // config mirror. A fresh profile (or a re-onboard, which writes the local
  // flag false) used to re-offer a reward the account had already spent.
  it('feedback reward is available when usage_periods has no claim stamp', async () => {
    signIn();
    state.plan = planRow();
    state.usagePeriod = { feedback_reset_at: null };

    const { creditsGet } = await import('./proxyClient');
    expect((await creditsGet()).feedback_reward_available).toBe(true);
  });

  it('feedback reward is NOT available once feedback_reset_at is stamped', async () => {
    signIn();
    state.plan = planRow();
    state.usagePeriod = { feedback_reset_at: '2026-07-10T00:31:24Z' };

    const { creditsGet } = await import('./proxyClient');
    expect((await creditsGet()).feedback_reward_available).toBe(false);
  });

  it('a failed usage_periods read reports UNKNOWN and does not fail the snapshot', async () => {
    // Unknown must not hide a real reward, and must not take the whole plan
    // snapshot down over a cosmetic gate.
    signIn();
    state.plan = planRow({ plan: 'quest' });
    state.usagePeriodError = { message: 'network' };

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();
    expect(res.feedback_reward_available).toBeNull();
    expect(res.plan).toBe('quest');
  });

  it('throws when the my_plan read errors (never paints a failed read as a fresh free account)', async () => {
    // 260725: a PostgREST failure (e.g. the my_plan view missing because the
    // v0.5 migrations have not been applied) must reach the renderer as a
    // thrown error so it shows snapshotFailed, not zeros.
    signIn();
    state.plan = null;
    state.planError = { message: 'relation "public.my_plan" does not exist' };

    const { creditsGet } = await import('./proxyClient');
    await expect(creditsGet()).rejects.toThrow(/my_plan read failed/);
  });

  it('surfaces over_limit for a spent allowance with no extra credits', async () => {
    signIn();
    state.plan = planRow({ plan: 'free', usage_pct: 100, over_limit: true });

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();

    expect(res.usage_pct).toBe(100);
    expect(res.over_limit).toBe(true);
  });

  it('keeps a cancel-scheduled subscription on its tier and exposes ends_at', async () => {
    signIn();
    state.plan = planRow({
      plan: 'party',
      subscription_status_raw: 'cancelled',
      ends_at: '2099-01-01T00:00:00Z',
      renews_at: null,
    });

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();

    // The server owns the "still usable until ends_at" decision; the client
    // reports exactly what the view says.
    expect(res.plan).toBe('party');
    expect(res.subscription_status_raw).toBe('cancelled');
    expect(res.ends_at).toBe('2099-01-01T00:00:00Z');
  });

  it('coerces bigints returned as strings and clamps a bad usage_pct', async () => {
    signIn();
    state.plan = planRow({
      usage_pct: '150',
      extra_credits_used: '1200',
      extra_credits_total: '3600',
    });

    const { creditsGet } = await import('./proxyClient');
    const res = await creditsGet();

    expect(res.usage_pct).toBe(100); // clamped
    expect(res.extra_credits_used).toBe(1200);
    expect(res.extra_credits_total).toBe(3600);
  });

  it('falls back to the free tier for a missing row or an unknown tier', async () => {
    signIn();
    state.plan = null;

    const { creditsGet } = await import('./proxyClient');
    const missing = await creditsGet();
    expect(missing.plan).toBe('free');
    expect(missing.usage_pct).toBe(0);
    expect(missing.resets_at).toBe('');

    state.plan = planRow({ plan: 'legendary' });
    const unknown = await creditsGet();
    expect(unknown.plan).toBe('free');
  });
});

describe('cloudOverLimit (pre-flight summon gate)', () => {
  it('is false when signed out', async () => {
    const { cloudOverLimit } = await import('./proxyClient');
    expect(await cloudOverLimit()).toBe(false);
  });

  it('is false on BYOK even when the account is over its limit', async () => {
    signIn();
    state.plan = planRow({ over_limit: true });
    const { getAiBackendKind } = await import('../apiKeyStore');
    (getAiBackendKind as ReturnType<typeof vi.fn>).mockResolvedValueOnce('local');

    const { cloudOverLimit } = await import('./proxyClient');
    expect(await cloudOverLimit()).toBe(false);
  });

  it('is true for a cloud account that is over its limit', async () => {
    signIn();
    state.plan = planRow({ usage_pct: 100, over_limit: true });

    const { cloudOverLimit } = await import('./proxyClient');
    expect(await cloudOverLimit()).toBe(true);
  });

  it('is false while the allowance still has room', async () => {
    signIn();
    state.plan = planRow({ usage_pct: 99, over_limit: false });

    const { cloudOverLimit } = await import('./proxyClient');
    // Slight overage is allowed by design: a call that starts with any
    // allowance left is charged in full, so 99% must not refuse a summon.
    expect(await cloudOverLimit()).toBe(false);
  });

  it('fails OPEN when the read throws', async () => {
    signIn();
    const { getAuthedClient } = await import('../auth/supabaseClient');
    (getAuthedClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('supabase down');
    });

    const { cloudOverLimit } = await import('./proxyClient');
    expect(await cloudOverLimit()).toBe(false);
  });
});

describe('openCheckout', () => {
  it('returns PROXY_NO_SESSION when the user is not signed in', async () => {
    const { openCheckout } = await import('./proxyClient');
    const res = await openCheckout('quest');
    expect(res).toEqual({ ok: false, code: 'PROXY_NO_SESSION' });
  });

  it('asks the proxy to mint a checkout session and RETURNS the validated URL', async () => {
    signIn();
    const checkoutUrl = 'https://buy.polar.sh/polar_c_quest123';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, url: checkoutUrl }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { shell } = await import('electron');
    const { openCheckout } = await import('./proxyClient');
    const res = await openCheckout('quest');

    // openCheckout returns the allowlist-validated URL; the main IPC handler
    // is what opens it (in the system browser via shell.openExternal).
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
        body: JSON.stringify({ kind: 'quest' }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it('passes each of the four product kinds through to the proxy', async () => {
    signIn();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, url: 'https://buy.polar.sh/polar_c_x' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { openCheckout } = await import('./proxyClient');
    for (const kind of ['quest', 'party', 'topup_small', 'topup_large'] as const) {
      await openCheckout(kind);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/billing/checkout'),
        expect.objectContaining({ body: JSON.stringify({ kind }) }),
      );
    }
    vi.unstubAllGlobals();
  });

  it('rejects a non-https checkout URL from the proxy (PROXY_NETWORK, no openExternal)', async () => {
    signIn();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, url: 'file:///etc/passwd' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { shell } = await import('electron');
    const { openCheckout } = await import('./proxyClient');
    const res = await openCheckout('party');

    expect(res).toEqual({ ok: false, code: 'PROXY_NETWORK' });
    expect(shell.openExternal).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('260725: an arbitrary https host from the proxy now passes (host allowlist removed)', async () => {
    // Documents the security delta of dropping the host allowlist: the checkout
    // URL used to be bounded to polar.sh, so a compromised proxy or MITM could
    // not redirect the user off-domain. It can now send them to any https site;
    // only the protocol gate survives.
    signIn();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, url: 'https://evil.attacker.tld/checkout' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { openCheckout } = await import('./proxyClient');
    const res = await openCheckout('party');

    expect(res).toEqual({ ok: true, url: 'https://evil.attacker.tld/checkout' });
    vi.unstubAllGlobals();
  });
});

describe('changePlan', () => {
  it('returns PROXY_NO_SESSION when the user is not signed in', async () => {
    const { changePlan } = await import('./proxyClient');
    expect(await changePlan('party')).toEqual({ ok: false, code: 'PROXY_NO_SESSION' });
  });

  it('POSTs the tier to /billing/change-plan and never opens a browser', async () => {
    signIn();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const { shell } = await import('electron');
    const { changePlan } = await import('./proxyClient');
    const res = await changePlan('party');

    expect(res).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/billing/change-plan'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-xyz' }),
        body: JSON.stringify({ tier: 'party' }),
      }),
    );
    // A tier change is a subscription UPDATE, not a checkout: no browser hop.
    expect(shell.openExternal).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('maps a 429 to PROXY_RATE_LIMITED and other failures to PROXY_NETWORK', async () => {
    signIn();
    const { changePlan } = await import('./proxyClient');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    expect(await changePlan('quest')).toEqual({ ok: false, code: 'PROXY_RATE_LIMITED' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await changePlan('quest')).toEqual({ ok: false, code: 'PROXY_NETWORK' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await changePlan('quest')).toEqual({ ok: false, code: 'PROXY_NETWORK' });
    vi.unstubAllGlobals();
  });
});

describe('feedbackSubmit', () => {
  it('reports the weekly usage reset returned by the proxy', async () => {
    signIn();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, usage_reset: true, already_claimed: false }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { feedbackSubmit } = await import('./proxyClient');
    const res = await feedbackSubmit({ body: 'more building tools please', claimReward: true });

    expect(res).toEqual({ ok: true, usage_reset: true, already_claimed: false });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/feedback'),
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });

  it('reports already_claimed with no reset', async () => {
    signIn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, usage_reset: false, already_claimed: true }),
      }),
    );

    const { feedbackSubmit } = await import('./proxyClient');
    const res = await feedbackSubmit({ body: 'hello', claimReward: true });
    expect(res).toEqual({ ok: true, usage_reset: false, already_claimed: true });
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
    signIn();
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
    signIn();
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
  it('fetches the signed customer-portal URL from the proxy and opens it', async () => {
    // Signed-in users route through the proxy's /billing/customer-portal
    // endpoint. The proxy mints a Polar customer session server-side and
    // returns the signed customer_portal_url.
    signIn();
    const signedUrl = 'https://polar.sh/my-org/portal?customer_session_token=abc123';
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
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-xyz' }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it('returns PROXY_NO_PORTAL_URL when the proxy returns no portalUrl', async () => {
    signIn();
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

  it('returns PROXY_NO_SESSION when signed out (symmetric session gate)', async () => {
    state.session = null;
    const { shell } = await import('electron');
    const { cancelSubscription } = await import('./proxyClient');
    const res = await cancelSubscription();

    expect(res).toEqual({ ok: false, code: 'PROXY_NO_SESSION' });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
