import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));
vi.mock('../chatgptPlan', () => ({ chatgptSession: () => ({}) }));

import { createChatgptAccountLogin, type ChatgptAccountLoginDeps, type LoginRegistration } from './chatgptAccountLogin';
import type { PendingLoginAccount, LoginSignInResult } from '../chatgptPlan/session';

const SESSION = {
  access_token: 'sb-access',
  refresh_token: 'sb-refresh',
  expires_in: 3600,
  expires_at: 1_900_000_000,
  token_type: 'bearer',
};

function pending(n = 1, over: Partial<PendingLoginAccount> = {}): PendingLoginAccount {
  return {
    idToken: `id-token-${n}`,
    clientId: `app_client_${n}`,
    subject: 'chatgpt-sub',
    issuer: 'https://auth.openai.com',
    email: 'alex@example.com',
    hostId: 'host',
    tokens: { access_token: 'oa-access', refresh_token: 'oa-refresh', token_type: 'Bearer', expires_in: 3600 } as PendingLoginAccount['tokens'],
    receivedAt: Date.now(),
    planEnabled: true,
    ...over,
  };
}

type Route = (body: Record<string, unknown>, headers: Headers) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

function harness(opts: {
  routes?: Record<string, Route>;
  signIns?: LoginSignInResult[];
  registration?: LoginRegistration | null;
  adopt?: { ok: true; planEnabled: boolean } | { ok: false; reason: string };
  current?: { accessToken: string; userId: string } | null;
  regionBlocked?: boolean;
  fetchThrows?: boolean;
  /** Saved plan accounts loginTargetFor knows (accountId -> target). */
  vault?: Record<string, { client_id: string; id_token: string | null; email: string | null; subject: string }>;
} = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
  const signInCalls: Array<{ nonce: string; target: unknown; forceConsent?: boolean }> = [];
  const plainSignIns: Array<{ accountId?: string | null; enablePlan?: boolean } | undefined> = [];
  const discarded: PendingLoginAccount[] = [];
  const adopted: PendingLoginAccount[] = [];
  const setSessions: unknown[] = [];
  let reg: LoginRegistration | null = opts.registration ?? null;
  const regSaves: LoginRegistration[] = [];
  let regCleared = 0;
  let cancelSignIns = 0;
  let nonceN = 0;
  const signIns = [...(opts.signIns ?? [{ ok: true as const, pending: pending() }])];
  const routes: Record<string, Route> = {
    '/auth/chatgpt/nonce': () => ({ status: 200, body: { nonce: `nonce-${++nonceN}`, expires_in: 600 } }),
    ...(opts.routes ?? {}),
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (opts.fetchThrows) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const headers = new Headers(init?.headers);
    calls.push({ path: url.pathname, body, auth: headers.get('authorization') });
    const r = routes[url.pathname];
    const out = r ? await r(body, headers) : { status: 404, body: { error: 'not_found' } };
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status });
  }) as typeof fetch;

  const deps: ChatgptAccountLoginDeps = {
    fetchImpl,
    proxyBase: () => 'https://api.test/',
    regionBlocked: async () => opts.regionBlocked ?? false,
    chatgpt: () => ({
      signIn: async (o) => {
        plainSignIns.push(o);
        return { ok: true, status: { plain: true } as never, planEnabled: true };
      },
      signInForLogin: async (o) => {
        signInCalls.push({ nonce: o.nonce, target: o.target ?? null, ...(o.forceConsent !== undefined ? { forceConsent: o.forceConsent } : {}) });
        return signIns.shift() ?? { ok: false, reason: 'cancelled' };
      },
      loginTargetFor: async (id) => opts.vault?.[id] ?? null,
      adoptLoginAccount: async (p) => {
        adopted.push(p);
        const a = opts.adopt ?? { ok: true, planEnabled: true };
        return a.ok
          ? ({ ok: true, status: {} as never, planEnabled: a.planEnabled } as never)
          : ({ ok: false, reason: a.reason } as never);
      },
      discardLoginAccount: async (p) => {
        discarded.push(p);
      },
      cancelSignIn: () => {
        cancelSignIns += 1;
      },
    }),
    setSupabaseSession: async (s) => {
      setSessions.push(s);
      return { userId: 'user-1' };
    },
    currentSession: async () => (opts.current === undefined ? null : opts.current),
    waitForAccountScope: async () => undefined,
    registration: {
      load: async () => reg,
      save: async (r) => {
        reg = r;
        regSaves.push(r);
      },
      clear: async () => {
        reg = null;
        regCleared += 1;
      },
    },
    timeoutMs: 2000,
  };
  const login = createChatgptAccountLogin(deps);
  return {
    login,
    calls,
    signInCalls,
    plainSignIns,
    discarded,
    adopted,
    setSessions,
    regSaves,
    get reg() {
      return reg;
    },
    get regCleared() {
      return regCleared;
    },
    get cancelSignIns() {
      return cancelSignIns;
    },
  };
}

const sessionAnswer = (created = false): Route => () => ({ status: 200, body: { status: 'session', created, session: SESSION } });
const codeAnswer = (reason = 'existing_account'): Route => () => ({
  status: 200,
  body: { status: 'email_code', ticket: 'ticket-xyz', email_hint: 's***@example.com', reason },
});

describe('chatgptAccountLogin.login', () => {
  it('one-step sign-in: nonce rides the browser flow, only id_token + client_id go to the proxy', async () => {
    const h = harness({ routes: { '/auth/chatgpt/session': sessionAnswer(true) } });
    const r = await h.login.login();
    expect(r).toEqual({ ok: true, kind: 'signed_in', created: true, planEnabled: true });
    expect(h.signInCalls[0]!.nonce).toBe('nonce-1');
    const sent = h.calls.find((c) => c.path === '/auth/chatgpt/session')!;
    expect(sent.body).toEqual({ id_token: 'id-token-1', client_id: 'app_client_1' });
    expect(JSON.stringify(h.calls)).not.toContain('oa-refresh');
    expect(JSON.stringify(h.calls)).not.toContain('oa-access');
    expect(h.setSessions).toEqual([SESSION]);
    expect(h.adopted).toHaveLength(1);
    expect(h.regSaves[0]).toMatchObject({ client_id: 'app_client_1', subject: 'chatgpt-sub', user_id: 'user-1' });
    expect(h.discarded).toHaveLength(0);
  });

  it('a saved registration is reused as the reauth target', async () => {
    const h = harness({
      registration: { client_id: 'app_saved', subject: 'chatgpt-sub', email: 'a@b.co', id_token: 'old', user_id: 'user-1' },
      routes: { '/auth/chatgpt/session': sessionAnswer() },
    });
    await h.login.login();
    expect(h.signInCalls[0]!.target).toEqual({ client_id: 'app_saved', id_token: 'old', email: 'a@b.co' });
  });

  it('a stale registration is cleared and the install registers fresh once, with a new nonce', async () => {
    const h = harness({
      registration: { client_id: 'app_saved', subject: 's', email: null, id_token: null, user_id: null },
      signIns: [{ ok: false, reason: 'client_mismatch' }, { ok: true, pending: pending(2) }],
      routes: { '/auth/chatgpt/session': sessionAnswer() },
    });
    const r = await h.login.login();
    expect(r.ok).toBe(true);
    expect(h.regCleared).toBe(1);
    expect(h.signInCalls.map((c) => [c.nonce, c.target])).toEqual([
      ['nonce-1', { client_id: 'app_saved', id_token: null, email: null }],
      ['nonce-2', null],
    ]);
  });

  it('email code: no session is set, the code step is reported with the masked hint only', async () => {
    const h = harness({ routes: { '/auth/chatgpt/session': codeAnswer('existing_account') } });
    const r = await h.login.login();
    expect(r).toEqual({ ok: true, kind: 'email_code', emailHint: 's***@example.com', reason: 'existing_account' });
    expect(JSON.stringify(r)).not.toContain('ticket');
    expect(h.setSessions).toHaveLength(0);
    expect(h.adopted).toHaveLength(0);
    expect((await h.login.status()).awaitingCode).toBe(true);
  });

  it('maps proxy refusals and revokes the unused ChatGPT grant', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { error: 'chatgpt_token_invalid', reason: 'nonce_used' }, 'token_rejected'],
      [409, { error: 'chatgpt_account_conflict', reason: 'linked_elsewhere' }, 'linked_elsewhere'],
      [409, { error: 'chatgpt_account_conflict', reason: 'account_linked_to_other_chatgpt' }, 'account_conflict'],
      [422, { error: 'chatgpt_no_email' }, 'no_email'],
      [429, { error: 'rate_limited' }, 'rate_limited'],
      [429, { error: 'rate_limited', reason: 'email_tickets', retry_after: 3600 }, 'rate_limited'],
      [429, { error: 'rate_limited', reason: 'global_emails', retry_after: 3600 }, 'rate_limited'],
      [404, { error: 'not_found' }, 'unavailable'],
      [503, { error: 'chatgpt_login_unavailable' }, 'unavailable'],
    ];
    for (const [status, body, reason] of cases) {
      const h = harness({ routes: { '/auth/chatgpt/session': () => ({ status, body }) } });
      const r = await h.login.login();
      expect(r.ok ? null : r.reason, JSON.stringify(body)).toBe(reason);
      expect(h.discarded).toHaveLength(1);
      expect(h.setSessions).toHaveLength(0);
    }
  });

  it('an incomplete session answer is refused, not half-applied', async () => {
    const h = harness({ routes: { '/auth/chatgpt/session': () => ({ status: 200, body: { status: 'session', session: { access_token: 'x' } } }) } });
    const r = await h.login.login();
    expect(r).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(h.setSessions).toHaveLength(0);
    expect(h.discarded).toHaveLength(1);
  });

  it('network failure on the nonce never opens the browser', async () => {
    const h = harness({ fetchThrows: true });
    const r = await h.login.login();
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(h.signInCalls).toHaveLength(0);
  });

  it('region gate refuses before any network call', async () => {
    const h = harness({ regionBlocked: true });
    const r = await h.login.login();
    expect(r).toMatchObject({ ok: false, reason: 'region_blocked' });
    expect(h.calls).toHaveLength(0);
  });

  it('browser failures map through', async () => {
    const h = harness({ signIns: [{ ok: false, reason: 'denied' }] });
    expect(await h.login.login()).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('signed in even when the plan cannot be saved; no plan offer then', async () => {
    const h = harness({ adopt: { ok: false, reason: 'not_eligible' }, routes: { '/auth/chatgpt/session': sessionAnswer() } });
    const r = await h.login.login();
    expect(r).toEqual({ ok: true, kind: 'signed_in', created: false, planEnabled: false });
    expect(h.discarded).toHaveLength(1);
    expect(h.login.takePlanOffer()).toBe(false);
  });
});

describe('chatgptAccountLogin email code', () => {
  async function atCode(routes: Record<string, Route>) {
    const h = harness({ routes: { '/auth/chatgpt/session': codeAnswer('new_device'), ...routes } });
    await h.login.login();
    return h;
  }

  it('a wrong code keeps the ticket for another try', async () => {
    let n = 0;
    const h = await atCode({
      '/auth/chatgpt/verify': () =>
        ++n === 1 ? { status: 401, body: { error: 'invalid_code' } } : { status: 200, body: { status: 'session', created: false, session: SESSION } },
    });
    expect(await h.login.verifyCode('111111')).toMatchObject({ ok: false, reason: 'invalid_code' });
    expect(h.discarded).toHaveLength(0);
    const r = await h.login.verifyCode('123 456');
    expect(r).toMatchObject({ ok: true, kind: 'signed_in' });
    const verifies = h.calls.filter((c) => c.path === '/auth/chatgpt/verify');
    expect(verifies[1]!.body).toEqual({ ticket: 'ticket-xyz', code: '123456' });
    expect(h.setSessions).toEqual([SESSION]);
  });

  it('a spent ticket ends the attempt and revokes the grant', async () => {
    const h = await atCode({ '/auth/chatgpt/verify': () => ({ status: 401, body: { error: 'ticket_invalid' } }) });
    expect(await h.login.verifyCode('123456')).toMatchObject({ ok: false, reason: 'code_expired' });
    expect(h.discarded).toHaveLength(1);
    expect(await h.login.verifyCode('123456')).toMatchObject({ ok: false, reason: 'code_expired' });
    expect((await h.login.status()).awaitingCode).toBe(false);
  });

  it('a network blip keeps the ticket', async () => {
    let down = true;
    const h = await atCode({
      '/auth/chatgpt/verify': () => (down ? { status: 503, body: {} } : { status: 200, body: { status: 'session', session: SESSION } }),
    });
    expect(await h.login.verifyCode('123456')).toMatchObject({ ok: false, reason: 'unavailable' });
    down = false;
    expect(await h.login.verifyCode('123456')).toMatchObject({ ok: true, kind: 'signed_in' });
  });

  it('per-address / project-wide caps (429 with a reason) are rate_limited and keep the ticket', async () => {
    let capped = true;
    const h = await atCode({
      '/auth/chatgpt/verify': () =>
        capped
          ? { status: 429, body: { error: 'rate_limited', reason: 'email_failures', retry_after: 86400 } }
          : { status: 200, body: { status: 'session', session: SESSION } },
      '/auth/chatgpt/resend': () => ({ status: 429, body: { error: 'rate_limited', reason: 'global_emails', retry_after: 3600 } }),
    });
    expect(await h.login.verifyCode('123456')).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(await h.login.resendCode()).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(h.discarded).toHaveLength(0);
    expect((await h.login.status()).awaitingCode).toBe(true);
    capped = false;
    expect(await h.login.verifyCode('123456')).toMatchObject({ ok: true, kind: 'signed_in' });
  });

  it('a conflict after the code is refused and nothing is signed in', async () => {
    const h = await atCode({
      '/auth/chatgpt/verify': () => ({ status: 409, body: { error: 'chatgpt_account_conflict', reason: 'account_linked_to_other_chatgpt' } }),
    });
    expect(await h.login.verifyCode('123456')).toMatchObject({ ok: false, reason: 'account_conflict' });
    expect(h.setSessions).toHaveLength(0);
    expect(h.discarded).toHaveLength(1);
  });

  it('resend uses the same ticket; an expired one ends the attempt', async () => {
    let expired = false;
    const h = await atCode({
      '/auth/chatgpt/resend': () => (expired ? { status: 401, body: { error: 'ticket_invalid' } } : { status: 200, body: { status: 'sent' } }),
    });
    expect(await h.login.resendCode()).toEqual({ ok: true });
    expect(h.calls.find((c) => c.path === '/auth/chatgpt/resend')!.body).toEqual({ ticket: 'ticket-xyz' });
    expired = true;
    expect(await h.login.resendCode()).toMatchObject({ ok: false, reason: 'code_expired' });
    expect(h.discarded).toHaveLength(1);
  });

  it('cancel drops the ticket, revokes the grant and aborts the browser flow', async () => {
    const h = await atCode({});
    h.login.cancel();
    expect(h.cancelSignIns).toBe(1);
    expect(h.discarded).toHaveLength(1);
    expect(await h.login.verifyCode('123456')).toMatchObject({ ok: false, reason: 'code_expired' });
    expect(h.calls.some((c) => c.path === '/auth/chatgpt/verify')).toBe(false);
  });

  it('a verify without any pending code never calls the proxy', async () => {
    const h = harness();
    expect(await h.login.verifyCode('123456')).toMatchObject({ ok: false, reason: 'code_expired' });
    expect(h.calls).toHaveLength(0);
  });
});

describe('chatgptAccountLogin.link and plan offer', () => {
  it('link needs a signed-in Sei account', async () => {
    const h = harness({ current: null });
    expect(await h.login.link()).toMatchObject({ ok: false, reason: 'not_signed_in' });
    expect(h.signInCalls).toHaveLength(0);
  });

  it('link sends the id_token with the Sei JWT and adopts the plan', async () => {
    const h = harness({
      current: { accessToken: 'sei-jwt', userId: 'user-1' },
      routes: { '/auth/chatgpt/link': () => ({ status: 200, body: { status: 'linked' } }) },
    });
    const r = await h.login.link();
    expect(r).toEqual({ ok: true, planEnabled: true, email: 'alex@example.com' });
    expect(h.signInCalls[0]).not.toHaveProperty('forceConsent');
    const sent = h.calls.find((c) => c.path === '/auth/chatgpt/link')!;
    expect(sent.auth).toBe('Bearer sei-jwt');
    expect(sent.body).toEqual({ id_token: 'id-token-1', client_id: 'app_client_1' });
    expect(h.setSessions).toHaveLength(0);
    expect(await h.login.status()).toEqual({ linked: true, email: 'alex@example.com', awaitingCode: false });
    expect(h.login.takePlanOffer()).toBe(true);
    expect(h.login.takePlanOffer()).toBe(false);
  });

  it('link refused elsewhere revokes the grant and keeps nothing', async () => {
    const h = harness({
      current: { accessToken: 'sei-jwt', userId: 'user-1' },
      routes: { '/auth/chatgpt/link': () => ({ status: 409, body: { error: 'chatgpt_account_conflict', reason: 'linked_elsewhere' } }) },
    });
    expect(await h.login.link()).toMatchObject({ ok: false, reason: 'linked_elsewhere' });
    expect(h.adopted).toHaveLength(0);
    expect(h.discarded).toHaveLength(1);
    expect(h.regSaves).toHaveLength(0);
  });

  it('the plan offer is one-shot after a plan-enabled login', async () => {
    const h = harness({ routes: { '/auth/chatgpt/session': sessionAnswer() } });
    expect(h.login.takePlanOffer()).toBe(false);
    await h.login.login();
    expect(h.login.takePlanOffer()).toBe(true);
    expect(h.login.takePlanOffer()).toBe(false);
  });

  it('status is linked only for the registration of the CURRENT Sei user', async () => {
    const h = harness({
      registration: { client_id: 'c', subject: 's', email: 'x@y.z', id_token: null, user_id: 'someone-else' },
      current: { accessToken: 't', userId: 'user-1' },
    });
    expect(await h.login.status()).toEqual({ linked: false, email: null, awaitingCode: false });
  });
});

describe('chatgptAccountLogin.connectPlan (plan sign-in that also links)', () => {
  const ME = { accessToken: 'sei-jwt', userId: 'user-1' };
  const linkOk: Route = () => ({ status: 200, body: { status: 'linked' } });

  it('signed out: the plain plan sign-in, no proxy call', async () => {
    const h = harness({ current: null });
    const r = await h.login.connectPlan({ enablePlan: true });
    expect(r).toMatchObject({ ok: true, planEnabled: true });
    expect(h.plainSignIns).toEqual([{ enablePlan: true }]);
    expect(h.calls).toHaveLength(0);
    expect(h.signInCalls).toHaveLength(0);
  });

  it('"Add account" (accountId null) stays the plain sign-in even when signed in', async () => {
    const h = harness({ current: ME });
    await h.login.connectPlan({ accountId: null });
    expect(h.plainSignIns).toEqual([{ accountId: null }]);
    expect(h.calls).toHaveLength(0);
  });

  it('signed in: one browser trip, links with the Sei JWT, adopts the plan, remembers the registration', async () => {
    const h = harness({ current: ME, routes: { '/auth/chatgpt/link': linkOk } });
    const r = await h.login.connectPlan();
    expect(r).toMatchObject({ ok: true, planEnabled: true });
    expect(h.plainSignIns).toHaveLength(0);
    expect(h.signInCalls).toHaveLength(1);
    const sent = h.calls.find((c) => c.path === '/auth/chatgpt/link')!;
    expect(sent.auth).toBe('Bearer sei-jwt');
    expect(sent.body).toEqual({ id_token: 'id-token-1', client_id: 'app_client_1' });
    expect(h.adopted).toHaveLength(1);
    expect(h.discarded).toHaveLength(0);
    expect(h.regSaves).toEqual([
      { client_id: 'app_client_1', subject: 'chatgpt-sub', email: 'alex@example.com', id_token: 'id-token-1', user_id: 'user-1' },
    ]);
    expect(await h.login.status()).toMatchObject({ linked: true });
    // The plan surface switches itself: no second offer from ChatgptPlanHost.
    expect(h.login.takePlanOffer()).toBe(false);
  });

  it('passes the consent option through (plan usage after a decline)', async () => {
    const h = harness({ current: ME, routes: { '/auth/chatgpt/link': linkOk } });
    await h.login.connectPlan({ enablePlan: true });
    expect(h.signInCalls[0]).toMatchObject({ forceConsent: true });
  });

  for (const [label, route] of [
    ['linked_elsewhere', () => ({ status: 409, body: { error: 'chatgpt_account_conflict', reason: 'linked_elsewhere' } })],
    ['account_conflict', () => ({ status: 409, body: { error: 'chatgpt_account_conflict', reason: 'account_linked_to_other_chatgpt' } })],
    ['an expired Sei session', () => ({ status: 401, body: { error: 'expired_jwt' } })],
    ['an older proxy (404)', () => ({ status: 404, body: { error: 'not_found' } })],
    ['a proxy outage', () => ({ status: 503, body: { error: 'chatgpt_login_unavailable' } })],
  ] as Array<[string, Route]>) {
    it(`link refused by ${label}: the plan still connects on the same grant, nothing linked`, async () => {
      const h = harness({ current: ME, routes: { '/auth/chatgpt/link': route } });
      const r = await h.login.connectPlan();
      expect(r).toMatchObject({ ok: true, planEnabled: true });
      expect(h.signInCalls).toHaveLength(1);
      expect(h.plainSignIns).toHaveLength(0);
      expect(h.adopted).toHaveLength(1);
      expect(h.discarded).toHaveLength(0);
      expect(h.regSaves).toHaveLength(0);
    });
  }

  it('proxy unreachable for the nonce: falls back to the plain sign-in, browser opened once', async () => {
    const h = harness({ current: ME, routes: { '/auth/chatgpt/nonce': () => ({ status: 503, body: {} }) } });
    const r = await h.login.connectPlan({ enablePlan: true });
    expect(r).toMatchObject({ ok: true });
    expect(h.signInCalls).toHaveLength(0);
    expect(h.plainSignIns).toEqual([{ enablePlan: true }]);
  });

  it('a browser failure is reported as is, with no second browser trip', async () => {
    const h = harness({ current: ME, signIns: [{ ok: false, reason: 'denied' }] });
    expect(await h.login.connectPlan()).toEqual({ ok: false, reason: 'denied' });
    expect(h.plainSignIns).toHaveLength(0);
    expect(h.calls.map((c) => c.path)).toEqual(['/auth/chatgpt/nonce']);
  });

  it('renewing a saved plan account uses THAT account as the target and refuses a different ChatGPT account', async () => {
    const vault = { acc1: { client_id: 'app_saved', id_token: 'old-id', email: 'alex@example.com', subject: 'chatgpt-sub' } };
    const h = harness({ current: ME, vault, routes: { '/auth/chatgpt/link': linkOk } });
    expect(await h.login.connectPlan({ accountId: 'acc1', enablePlan: true })).toMatchObject({ ok: true });
    expect(h.signInCalls[0]).toEqual({
      nonce: 'nonce-1',
      target: { client_id: 'app_saved', id_token: 'old-id', email: 'alex@example.com' },
      forceConsent: true,
    });

    const other = harness({ current: ME, vault, signIns: [{ ok: true, pending: pending(2, { subject: 'someone-else' }) }] });
    expect(await other.login.connectPlan({ accountId: 'acc1' })).toEqual({ ok: false, reason: 'account_mismatch' });
    expect(other.adopted).toHaveLength(0);
    expect(other.discarded).toHaveLength(1);
    expect(other.calls.some((c) => c.path === '/auth/chatgpt/link')).toBe(false);
  });

  it('an unknown saved account falls back to the plain sign-in (which reports it)', async () => {
    const h = harness({ current: ME });
    await h.login.connectPlan({ accountId: 'gone' });
    expect(h.plainSignIns).toEqual([{ accountId: 'gone' }]);
    expect(h.signInCalls).toHaveLength(0);
  });

  it('a plan that cannot be saved is a failure and the grant is revoked', async () => {
    const h = harness({ current: ME, routes: { '/auth/chatgpt/link': linkOk }, adopt: { ok: false, reason: 'keychain_unavailable' } });
    expect(await h.login.connectPlan()).toMatchObject({ ok: false, reason: 'keychain_unavailable' });
    expect(h.discarded).toHaveLength(1);
    expect(h.regSaves).toHaveLength(0);
  });
});

describe('chatgptAccountLogin.unlink', () => {
  const ME = { accessToken: 'sei-jwt', userId: 'user-1' };
  const mine: LoginRegistration = { client_id: 'c', subject: 's', email: 'x@y.z', id_token: null, user_id: 'user-1' };

  it('needs a signed-in Sei account', async () => {
    const h = harness({ current: null, registration: mine });
    expect(await h.login.unlink()).toMatchObject({ ok: false, reason: 'not_signed_in' });
    expect(h.calls).toHaveLength(0);
    expect(h.regCleared).toBe(0);
  });

  it('unlinks with the Sei JWT and forgets this account\'s device registration', async () => {
    const h = harness({
      current: ME,
      registration: mine,
      routes: { '/auth/chatgpt/unlink': () => ({ status: 200, body: { status: 'unlinked', removed: true } }) },
    });
    expect(await h.login.status()).toMatchObject({ linked: true });
    expect(await h.login.unlink()).toEqual({ ok: true, removed: true });
    const sent = h.calls.find((c) => c.path === '/auth/chatgpt/unlink')!;
    expect(sent.auth).toBe('Bearer sei-jwt');
    expect(h.regCleared).toBe(1);
    expect(await h.login.status()).toMatchObject({ linked: false });
  });

  it('is fine when the server had no link (removed:false)', async () => {
    const h = harness({ current: ME, routes: { '/auth/chatgpt/unlink': () => ({ status: 200, body: { status: 'unlinked', removed: false } }) } });
    expect(await h.login.unlink()).toEqual({ ok: true, removed: false });
  });

  it("keeps another Sei account's registration on this device", async () => {
    const h = harness({
      current: ME,
      registration: { ...mine, user_id: 'someone-else' },
      routes: { '/auth/chatgpt/unlink': () => ({ status: 200, body: { status: 'unlinked', removed: true } }) },
    });
    expect(await h.login.unlink()).toEqual({ ok: true, removed: true });
    expect(h.regCleared).toBe(0);
  });

  it('an older proxy without the route (404): unavailable, nothing forgotten', async () => {
    const h = harness({ current: ME, registration: mine });
    expect(await h.login.unlink()).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(h.regCleared).toBe(0);
    expect(h.reg).toEqual(mine);
  });

  it('network failure and an expired session map through', async () => {
    const down = harness({ current: ME, registration: mine, fetchThrows: true });
    expect(await down.login.unlink()).toMatchObject({ ok: false, reason: 'network' });
    const expired = harness({ current: ME, routes: { '/auth/chatgpt/unlink': () => ({ status: 401, body: { error: 'expired_jwt' } }) } });
    expect(await expired.login.unlink()).toMatchObject({ ok: false, reason: 'not_signed_in' });
    expect(down.regCleared + expired.regCleared).toBe(0);
  });
});
