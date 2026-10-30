/**
 * Regression: "sometimes when I restart the app it locks me in the login page
 * and won't let me enter with my account" (Discord, 261028).
 *
 * Drives the REAL supabase-js client (fake GoTrue over a stub fetch, in-memory
 * storage) through main's boot order, with the real step 0a:
 *
 *   0a. applyBootScope()        stored session -> setActiveScope   (bootScope.ts)
 *   5b. initAuthState(window)   first state from storage, subscribe (authState.ts)
 *   ... supabase-js's own session load reports through the subscription
 *   ... the user signs in / out on the panel
 *
 * After a restart the persisted access token has expired, so anything that
 * calls `auth.getSession()` refreshes over the network. The first fix picked
 * the boot scope from storage but still awaited getSession() in initAuthState:
 * offline, with supabase-js's real backoff, that took ~51 s, the renderer
 * routed on main's default 'local' meanwhile, and a sign-in made then had no
 * subscriber. The tests marked "real backoff" run supabase-js's own retry
 * timing on fake timers instead of skipping it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---- profile scope: real paths module, spied switch ------------------------
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }));
const switchScopeMock = vi.fn();
vi.mock('../profile/profileScope', () => ({
  switchScopeForAuth: (...a: unknown[]) => switchScopeMock(...a),
}));
// Side effects of a sign-in transition: spied no-ops.
vi.mock('../apiKeyStore', () => ({ applyCloudDefaultForSignIn: vi.fn(async () => {}) }));
vi.mock('../cloud/reconcileLocalOwnership', () => ({ reconcileLocalOwnershipOnSignIn: vi.fn(async () => {}) }));
vi.mock('../ipc', () => ({ remoderateResetSharedCharactersOnSignIn: vi.fn(async () => {}) }));
vi.mock('../configStore', () => ({ loadConfig: vi.fn(async () => ({})) }));
vi.mock('../cloud/cloudCharacterClient', () => ({ upsertMyProfile: vi.fn(async () => {}) }));
vi.mock('../analytics', () => ({ identifyUser: vi.fn(), capture: vi.fn(), resetUser: vi.fn() }));
vi.mock('../cloud/librarySync', () => ({ syncLibraryRoster: vi.fn(async () => {}) }));
vi.mock('./tosGate', () => ({ getTosAcceptance: vi.fn(async () => 'accepted') }));

let client: SupabaseClient;
vi.mock('./supabaseClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./supabaseClient')>()),
  getClient: () => client,
}));

import { setActiveScope, getActiveScope } from '../paths';
import { capture } from '../analytics';
import { applyCloudDefaultForSignIn } from '../apiKeyStore';
import { reconcileLocalOwnershipOnSignIn } from '../cloud/reconcileLocalOwnership';
import {
  initAuthState,
  getCurrentAuthState,
  getAuthSnapshot,
  transitionToLocal,
  _disposeForTests,
  _scopeSwitchSettledForTests,
} from './authState';
import { persistedSessionUserId, withAuthRequestTimeout } from './supabaseClient';
import { applyBootScope } from './bootScope';
import { signOut } from './authHandlers';

const URL_BASE = 'https://proj.supabase.co';
const STORAGE_KEY = 'sb-proj-auth-token';
const USER_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_ID = '7a2b3c4d-5e6f-4a70-8b8c-9d0e1f2a3b4c';

let jwtSerial = 0;
/** Every token is distinct, like GoTrue's (which carry iat and session_id). */
function fakeJwt(sub: string, exp: number): string {
  const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  jwtSerial += 1;
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, exp, role: 'authenticated', session_id: `s-${jwtSerial}` })}.sig`;
}

const userFor = (id: string, email: string): Record<string, unknown> => ({
  id,
  aud: 'authenticated',
  role: 'authenticated',
  email,
  email_confirmed_at: '2026-05-01T00:00:00Z',
  created_at: '2026-05-01T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
});
const user = userFor(USER_ID, 'player@example.com');
const other = userFor(OTHER_ID, 'other@example.com');

function sessionBody(nowSec: number, n: number, u: Record<string, unknown> = user): Record<string, unknown> {
  return {
    access_token: fakeJwt(String(u.id), nowSec + 3600),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: nowSec + 3600,
    refresh_token: `rt-${n}`,
    user: u,
  };
}

/**
 * Stub GoTrue. `networkDown` fails every request like an offline fetch,
 * `refreshDown` only the token refresh. `skipBackoff` skews the clock past
 * supabase-js's retry window on a failure so it gives up at once (the quick
 * tests); the real-backoff tests leave it off and run the retries on fake
 * timers.
 */
interface FakeServer {
  networkDown: boolean;
  refreshDown: boolean;
  skipBackoff: boolean;
  refreshCalls: number;
  logoutCalls: number;
  fetch: typeof fetch;
}
let signInCount = 0;
function fakeServer(): FakeServer {
  const s: FakeServer = {
    networkDown: false,
    refreshDown: false,
    skipBackoff: true,
    refreshCalls: 0,
    logoutCalls: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const isRefresh = url.includes('grant_type=refresh_token');
      if (s.networkDown || (s.refreshDown && isRefresh)) {
        if (s.skipBackoff) clockSkewMs += 31_000;
        throw new TypeError('fetch failed');
      }
      const now = Math.floor(Date.now() / 1000);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (isRefresh) {
        s.refreshCalls += 1;
        return json(sessionBody(now, 100 + s.refreshCalls));
      }
      if (url.includes('grant_type=password')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { email?: string };
        signInCount += 1;
        return json(sessionBody(now, 900 + signInCount, body.email === 'other@example.com' ? other : user));
      }
      if (url.endsWith('/auth/v1/verify')) {
        signInCount += 1;
        return json(sessionBody(now, 950 + signInCount));
      }
      if (url.includes('/logout')) {
        s.logoutCalls += 1;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/auth/v1/user')) return json(user);
      return json({ msg: 'not found' }, 404);
    }) as typeof fetch,
  };
  return s;
}

let clockSkewMs = 0;
const realNow = Date.now.bind(Date);

function memoryStorage(seed: Record<string, string>): {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
  has(k: string): boolean;
  /** The next `n` removes of `k` throw (a locked or failing disk). */
  failRemoves(k: string, n: number): void;
} {
  const m = new Map(Object.entries(seed));
  const failing = new Map<string, number>();
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async (k) => {
      const n = failing.get(k) ?? 0;
      if (n > 0) {
        failing.set(k, n - 1);
        throw new Error('EBUSY: remove failed');
      }
      m.delete(k);
    },
    has: (k) => m.has(k),
    failRemoves: (k, n) => void failing.set(k, n),
  };
}

function fakeWindow(): { win: Electron.BrowserWindow; sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (ch: string, payload: unknown) => sent.push([ch, payload]),
      on: () => {},
      removeListener: () => {},
    },
  } as unknown as Electron.BrowserWindow;
  return { win, sent };
}

/** The persisted session from the previous run: its access token expired an hour ago. */
function expiredPersistedSession(): Record<string, string> {
  const past = Math.floor(Date.now() / 1000) - 3600;
  return {
    [STORAGE_KEY]: JSON.stringify({ ...sessionBody(past - 3600, 1), expires_at: past }),
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  clockSkewMs = 0;
  signInCount = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockSkewMs);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  switchScopeMock.mockReset().mockImplementation(async (id: string | null) => setActiveScope(id));
  vi.mocked(capture).mockClear();
  vi.mocked(applyCloudDefaultForSignIn).mockClear();
  vi.mocked(reconcileLocalOwnershipOnSignIn).mockClear();
  setActiveScope('local');
});

afterEach(() => {
  vi.useRealTimers();
  _disposeForTests();
  vi.restoreAllMocks();
  setActiveScope('local');
});

let storage: ReturnType<typeof memoryStorage>;
function makeClient(server: FakeServer, seed: Record<string, string> = expiredPersistedSession()): SupabaseClient {
  storage = memoryStorage(seed);
  return createClient(URL_BASE, 'sb_publishable_test', {
    auth: {
      storage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    global: { fetch: withAuthRequestTimeout(server.fetch) },
  });
}

/** Main's boot order up to the auth state: step 0a, then 5b. */
async function boot(server: FakeServer, seed?: Record<string, string>): Promise<Array<[string, unknown]>> {
  client = makeClient(server, seed);
  await applyBootScope({ client });
  const { win, sent } = fakeWindow();
  await initAuthState(win);
  return sent;
}

const authPushes = (sent: Array<[string, unknown]>): string[] =>
  sent.filter(([ch]) => ch === 'auth:state').map(([, s]) => (s as { kind: string }).kind);

describe('restart with an expired access token', () => {
  it('comes up signed in on the account profile at once, and the refresh agrees later', async () => {
    const server = fakeServer();
    const sent = await boot(server);
    // From storage: no network involved yet.
    expect(getActiveScope()).toBe(USER_ID);
    expect(getCurrentAuthState().kind).toBe('signed_in');
    expect(await getAuthSnapshot()).toEqual({
      state: getCurrentAuthState(),
      scopeReady: true,
      loaded: true,
      scope: USER_ID,
    });
    await flush();
    await _scopeSwitchSettledForTests();
    // supabase-js's own load refreshed the token: same account, nothing moved.
    expect(server.refreshCalls).toBeGreaterThan(0);
    expect(getCurrentAuthState().kind).toBe('signed_in');
    expect(switchScopeMock).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalledWith('signed_in');
    expect(authPushes(sent)).not.toContain('local');
  });

  it('offline at launch: stays signed in on the account profile (the stored session is kept)', async () => {
    const server = fakeServer();
    server.networkDown = true;
    const sent = await boot(server);
    await flush();
    await flush();
    await _scopeSwitchSettledForTests();
    expect(getCurrentAuthState().kind).toBe('signed_in');
    expect(getActiveScope()).toBe(USER_ID);
    expect(switchScopeMock).not.toHaveBeenCalled();
    expect(authPushes(sent)).not.toContain('local');
    // The network comes back: the next refresh is a same-account no-op.
    server.networkDown = false;
    const { error } = await client.auth.refreshSession();
    expect(error).toBeNull();
    await flush();
    await _scopeSwitchSettledForTests();
    expect(getCurrentAuthState().kind).toBe('signed_in');
    expect(switchScopeMock).not.toHaveBeenCalled();
    // The session coming back online is not a sign-in.
    expect(capture).not.toHaveBeenCalledWith('signed_in');
    expect(applyCloudDefaultForSignIn).not.toHaveBeenCalled();
  });

  it('a session the server rejects at launch moves the scope to local', async () => {
    const server = fakeServer();
    const rejecting: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('grant_type=refresh_token')
        ? new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh Token Not Found', code: 'refresh_token_not_found' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        : server.fetch(input, init)) as typeof fetch;
    server.fetch = rejecting;
    await boot(server);
    await flush();
    await flush();
    await _scopeSwitchSettledForTests();
    expect(getCurrentAuthState().kind).toBe('local');
    expect(getActiveScope()).toBe('local');
    // supabase-js removes the refused session and emits SIGNED_OUT: the same
    // path as a session revoked mid-run.
    expect(switchScopeMock).toHaveBeenCalledWith(null, { restored: false });
    expect(storage.has(STORAGE_KEY)).toBe(false);
  });

  it('signing in again on the sign-in panel moves the scope when it is stale', async () => {
    const server = fakeServer();
    await boot(server);
    await flush();
    // Simulate a scope left behind by an older build.
    setActiveScope('local');
    switchScopeMock.mockClear();

    const { error } = await client.auth.signInWithPassword({ email: 'player@example.com', password: 'pw' });
    expect(error).toBeNull();
    await flush();
    await _scopeSwitchSettledForTests();
    expect(switchScopeMock).toHaveBeenCalledWith(USER_ID, { restored: false });
    expect(getActiveScope()).toBe(USER_ID);
    expect(capture).toHaveBeenCalledWith('signed_in');
  });

  it('the boot scope read finds the account offline, where getSession() does not', async () => {
    const server = fakeServer();
    server.networkDown = true;
    client = makeClient(server);
    const { data } = await client.auth.getSession();
    expect(data.session).toBeNull();
    expect(await persistedSessionUserId({ client })).toBe(USER_ID);
    expect(await persistedSessionUserId({ client, storage: memoryStorage({}) })).toBeNull();
  });

  it('a snapshot reports the scope not ready while a switch runs, then ready', async () => {
    const server = fakeServer();
    let release: () => void = () => {};
    switchScopeMock.mockImplementation(
      (id: string | null) =>
        new Promise<void>((r) => {
          release = () => {
            setActiveScope(id);
            r();
          };
        }),
    );
    // Boot scope left on 'local' (an older build's step 0a): init moves it.
    client = makeClient(server);
    setActiveScope('local');
    await initAuthState(fakeWindow().win);
    await vi.waitFor(() => expect(switchScopeMock).toHaveBeenCalled());
    const during = await getAuthSnapshot();
    expect(during.state.kind).toBe('signed_in');
    expect(during.scopeReady).toBe(false);
    expect(during.scope).toBe('local');
    release();
    await _scopeSwitchSettledForTests();
    expect(await getAuthSnapshot()).toMatchObject({ scopeReady: true, scope: USER_ID });
  });
});

describe('restart offline, with supabase-js real backoff timing (fake clock)', () => {
  function fakeClockServer(): FakeServer {
    const server = fakeServer();
    server.skipBackoff = false;
    server.networkDown = true;
    return server;
  }
  beforeEach(() => {
    vi.mocked(Date.now).mockRestore();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
    let done = false;
    void p.then(() => (done = true), () => (done = true));
    await vi.advanceTimersByTimeAsync(ms);
    return done;
  }

  it('getSession() itself takes about 51 s offline (what the first fix awaited)', async () => {
    client = makeClient(fakeClockServer());
    const started = Date.now();
    let ended = 0;
    void client.auth.getSession().then(() => (ended = Date.now()));
    for (let i = 0; i < 120 && !ended; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(ended - started).toBeGreaterThanOrEqual(45_000);
    expect(ended - started).toBeLessThan(60_000);
  });

  it('initAuthState answers from storage without waiting for the refresh, then keeps the session', async () => {
    const server = fakeClockServer();
    client = makeClient(server);
    await applyBootScope({ client });
    const { win, sent } = fakeWindow();
    const init = initAuthState(win);
    expect(await settledWithin(init, 100)).toBe(true);
    expect(await getAuthSnapshot(0)).toEqual({
      state: getCurrentAuthState(),
      scopeReady: true,
      loaded: true,
      scope: USER_ID,
    });
    expect(getCurrentAuthState().kind).toBe('signed_in');
    // Let supabase-js's startup refresh and its INITIAL_SESSION load fail for real.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getCurrentAuthState().kind).toBe('signed_in');
    expect(getActiveScope()).toBe(USER_ID);
    expect(switchScopeMock).not.toHaveBeenCalled();
    expect(authPushes(sent)).not.toContain('local');
    expect(storage.has(STORAGE_KEY)).toBe(true);
  });

  it('a sign-in made while the startup refresh is still retrying is not lost', async () => {
    const server = fakeClockServer();
    server.networkDown = false;
    server.refreshDown = true; // the expired session cannot refresh; sign-in works
    client = makeClient(server);
    await applyBootScope({ client });
    const init = initAuthState(fakeWindow().win);
    expect(await settledWithin(init, 100)).toBe(true);
    // Two seconds in, the startup refresh is mid-backoff. Sign in as someone else.
    await vi.advanceTimersByTimeAsync(2_000);
    const signIn = client.auth.signInWithPassword({ email: 'other@example.com', password: 'pw' });
    expect(await settledWithin(signIn, 100)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await _scopeSwitchSettledForTests();
    const state = getCurrentAuthState();
    expect(state.kind === 'signed_in' && state.user.id).toBe(OTHER_ID);
    expect(getActiveScope()).toBe(OTHER_ID);
    expect(capture).toHaveBeenCalledWith('signed_in');
  });

  it('a hung auth server does not hold the refresh forever (request timeout)', async () => {
    const server = fakeClockServer();
    server.networkDown = false;
    const hung: typeof fetch = ((_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
      })) as typeof fetch;
    server.fetch = hung;
    client = makeClient(server);
    const res = client.auth.refreshSession();
    let out: Awaited<typeof res> | null = null;
    void res.then((r) => (out = r));
    for (let i = 0; i < 120 && !out; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(out).not.toBeNull();
    expect(out!.error).not.toBeNull();
    expect(storage.has(STORAGE_KEY)).toBe(true);
  });
});

describe('sign-in follow-up steps', () => {
  it('sign-in A, sign-out, sign-in A in quick succession runs them once, for the last request', async () => {
    const server = fakeServer();
    await boot(server, {}); // signed out at launch
    switchScopeMock.mockImplementation(
      (id: string | null) => new Promise<void>((r) => setTimeout(() => { setActiveScope(id); r(); }, 30)),
    );
    await client.auth.signInWithPassword({ email: 'player@example.com', password: 'pw' });
    await client.auth.signOut({ scope: 'local' });
    await client.auth.signInWithPassword({ email: 'player@example.com', password: 'pw' });
    await new Promise((r) => setTimeout(r, 200));
    await _scopeSwitchSettledForTests();
    expect(getActiveScope()).toBe(USER_ID);
    expect(vi.mocked(capture).mock.calls.filter(([e]) => e === 'signed_in')).toHaveLength(1);
    expect(vi.mocked(applyCloudDefaultForSignIn)).toHaveBeenCalledTimes(1);
  });

  it('a sign-in undone before its move finished runs none of them (superseded request)', async () => {
    const server = fakeServer();
    await boot(server, {});
    // Serialized like the real switchScopeForAuth; each move waits for release.
    const gates: Array<() => void> = [];
    let chain: Promise<void> = Promise.resolve();
    switchScopeMock.mockImplementation((id: string | null) => {
      const run = chain.then(() => new Promise<void>((r) => gates.push(() => { setActiveScope(id); r(); })));
      chain = run;
      return run;
    });
    await client.auth.signInWithPassword({ email: 'player@example.com', password: 'pw' });
    await client.auth.signOut({ scope: 'local' });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates.shift()!(); // the move onto the account lands, with the sign-out queued behind it
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    await flush();
    // Nothing runs for the account while its sign-out is still to come.
    expect(applyCloudDefaultForSignIn).not.toHaveBeenCalled();
    expect(reconcileLocalOwnershipOnSignIn).not.toHaveBeenCalled();
    gates.shift()!();
    await _scopeSwitchSettledForTests();
    expect(getActiveScope()).toBe('local');
    expect(capture).not.toHaveBeenCalledWith('signed_in');
    expect(applyCloudDefaultForSignIn).not.toHaveBeenCalled();
    expect(vi.mocked(capture).mock.calls.filter(([e]) => e === 'signed_out')).toHaveLength(1);
  });

  it('a move that threw runs none of them', async () => {
    const server = fakeServer();
    await boot(server, {});
    switchScopeMock.mockImplementation(async () => {
      throw new Error('disk full');
    });
    await client.auth.signInWithPassword({ email: 'player@example.com', password: 'pw' });
    await flush();
    await _scopeSwitchSettledForTests();
    expect(getActiveScope()).toBe('local');
    expect(capture).not.toHaveBeenCalledWith('signed_in');
    // The next auth event retries the move, and the sign-in still owes its steps.
    switchScopeMock.mockImplementation(async (id: string | null) => setActiveScope(id));
    await client.auth.refreshSession();
    await flush();
    await _scopeSwitchSettledForTests();
    expect(getActiveScope()).toBe(USER_ID);
    expect(vi.mocked(capture).mock.calls.filter(([e]) => e === 'signed_in')).toHaveLength(1);
  });

  it('a real sign-in onto the profile that is already active still runs them, once', async () => {
    const server = fakeServer();
    await boot(server); // restored session, scope already on the account
    await flush();
    await _scopeSwitchSettledForTests();
    expect(capture).not.toHaveBeenCalledWith('signed_in');
    await client.auth.signInWithPassword({ email: 'player@example.com', password: 'pw' });
    await flush();
    await _scopeSwitchSettledForTests();
    expect(switchScopeMock).not.toHaveBeenCalled();
    expect(vi.mocked(capture).mock.calls.filter(([e]) => e === 'signed_in')).toHaveLength(1);
    expect(vi.mocked(applyCloudDefaultForSignIn)).toHaveBeenCalledTimes(1);
  });

  it("supabase-js re-announcing the stored session (its startup SIGNED_IN) is not a sign-in", async () => {
    const server = fakeServer();
    const nowSec = Math.floor(Date.now() / 1000);
    const fresh = sessionBody(nowSec, 7);
    await boot(server, { [STORAGE_KEY]: JSON.stringify(fresh) });
    await (client.auth as unknown as { _notifyAllSubscribers: (e: string, s: unknown) => Promise<void> })._notifyAllSubscribers(
      'SIGNED_IN',
      fresh,
    );
    await flush();
    await _scopeSwitchSettledForTests();
    expect(capture).not.toHaveBeenCalledWith('signed_in');
    expect(applyCloudDefaultForSignIn).not.toHaveBeenCalled();
  });

  it('a password-reset session (PASSWORD_RECOVERY, not SIGNED_IN) is a sign-in', async () => {
    const server = fakeServer();
    await boot(server, {}); // signed out
    const events: string[] = [];
    client.auth.onAuthStateChange((e) => void events.push(e));
    // authHandlers' reset-code path: verifyOtp type 'recovery'.
    const { error } = await client.auth.verifyOtp({ email: 'player@example.com', token: '123456', type: 'recovery' });
    expect(error).toBeNull();
    await flush();
    await _scopeSwitchSettledForTests();
    expect(events).toContain('PASSWORD_RECOVERY');
    expect(events).not.toContain('SIGNED_IN');
    expect(getActiveScope()).toBe(USER_ID);
    expect(switchScopeMock).toHaveBeenCalledWith(USER_ID, { restored: false });
    expect(vi.mocked(capture).mock.calls.filter(([e]) => e === 'signed_in')).toHaveLength(1);
    expect(applyCloudDefaultForSignIn).toHaveBeenCalledTimes(1);
  });
});

describe('auth snapshot before the session load', () => {
  it('answers on its time bound as not loaded, never as a ready local state', async () => {
    const snap = await getAuthSnapshot(5);
    expect(snap).toEqual({ state: { kind: 'local' }, scopeReady: false, loaded: false, scope: 'local' });
  });
});

describe('sign-out', () => {
  it('transitionToLocal moves a scope left on the account back to local', async () => {
    const server = fakeServer();
    await boot(server);
    await flush();
    expect(getCurrentAuthState().kind).toBe('signed_in');
    expect(switchScopeMock).not.toHaveBeenCalled(); // scope already right
    transitionToLocal();
    await _scopeSwitchSettledForTests();
    expect(switchScopeMock).toHaveBeenCalledWith(null, { restored: false });
    expect(getActiveScope()).toBe('local');
    expect((await getAuthSnapshot()).scopeReady).toBe(true);
  });

  it('a SIGNED_OUT nobody asked for moves the scope and is tagged session_rejected', async () => {
    const server = fakeServer();
    await boot(server);
    await flush();
    await client.auth.signOut({ scope: 'local' });
    await flush();
    await _scopeSwitchSettledForTests();
    expect(switchScopeMock).toHaveBeenCalledWith(null, { restored: false });
    expect(getActiveScope()).toBe('local');
    expect(capture).toHaveBeenCalledWith('signed_out', { reason: 'session_rejected' });
  });

  it('offline: signing out clears the stored session, so the next launch is signed out', async () => {
    const server = fakeServer();
    await boot(server);
    await flush();
    await _scopeSwitchSettledForTests();
    server.networkDown = true;
    // What supabase-js does on its own offline: reports the error, keeps the session.
    const { error } = await client.auth.signOut();
    expect(error).not.toBeNull();
    expect(storage.has(STORAGE_KEY)).toBe(true);
    // The app's sign-out.
    await signOut();
    await flush();
    await _scopeSwitchSettledForTests();
    expect(storage.has(STORAGE_KEY)).toBe(false);
    expect(getCurrentAuthState().kind).toBe('local');
    expect(getActiveScope()).toBe('local');
    expect(await persistedSessionUserId({ client })).toBeNull();
  });

  it('online: signing out still goes through the auth server', async () => {
    const server = fakeServer();
    await boot(server);
    await flush();
    await signOut();
    await flush();
    await _scopeSwitchSettledForTests();
    expect(server.logoutCalls).toBe(1);
    expect(storage.has(STORAGE_KEY)).toBe(false);
    expect(getActiveScope()).toBe('local');
    // The user's own sign-out carries no rejection tag.
    expect(capture).toHaveBeenCalledWith('signed_out', undefined);
    expect(capture).not.toHaveBeenCalledWith('signed_out', { reason: 'session_rejected' });
  });

  it('offline, when the local sign-out fails too: clears again and stops the refresh ticker', async () => {
    const server = fakeServer();
    server.networkDown = true;
    await boot(server); // the stored session stays expired: any load must refresh
    await flush();
    await _scopeSwitchSettledForTests();
    const stopTicker = vi.spyOn(client.auth, 'stopAutoRefresh');
    storage.failRemoves(STORAGE_KEY, 1); // the first clear fails
    await signOut();
    await flush();
    await _scopeSwitchSettledForTests();
    expect(stopTicker).toHaveBeenCalled();
    expect(storage.has(STORAGE_KEY)).toBe(false);
    expect(getCurrentAuthState().kind).toBe('local');
    expect(getActiveScope()).toBe('local');
    // Network back: nothing left to refresh back into a session.
    server.networkDown = false;
    const { data } = await client.auth.getSession();
    expect(data.session).toBeNull();
    await flush();
    expect(getCurrentAuthState().kind).toBe('local');
  });
});
