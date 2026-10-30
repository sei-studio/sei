/**
 * Supabase client singleton — main-process only.
 *
 * SECURITY: This module is main-process only. The renderer NEVER imports
 * from here. utilityProcess receives only the access-token JWT over
 * MessagePortMain (plan 06), never the SupabaseClient itself, never the
 * refresh token.
 *
 * Wiring:
 *   - Plan 01 (this file) creates the singleton + adapter slot.
 *   - Plan 02 (sessionStore.ts) implements StorageAdapter against safeStorage.
 *   - Plan 03 (bootstrap) calls setStorageAdapter(sessionStoreAdapter) BEFORE
 *     the first getClient() call.
 *
 * Sources:
 *   - 10-RESEARCH §Pattern 1 (Supabase client with safeStorage adapter)
 *   - 10-CONTEXT D-13 (clone apiKeyStore.ts pattern)
 *   - Supabase docs: https://supabase.com/docs/reference/javascript/initializing
 *   - PKCE flow: https://supabase.com/docs/guides/auth/sessions/pkce-flow
 */
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { getSupabaseUrl, getSupabaseAnonKey } from '../env';

/**
 * Storage adapter shape Supabase JS expects for session persistence.
 * Plan 02 implements this against Electron safeStorage in sessionStore.ts.
 */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

let client: SupabaseClient | null = null;
let storageAdapter: StorageAdapter | null = null;

/**
 * Wire the safeStorage-backed storage adapter into the Supabase client.
 * Must be called BEFORE the first getClient() call. Plan 03 calls this
 * during bootstrap, before any auth IPC handler is registered.
 *
 * If called after getClient() has already instantiated the singleton,
 * throws a named error indicating client-already-created — re-wiring storage
 * mid-flight would orphan the in-memory session.
 */
export function setStorageAdapter(adapter: StorageAdapter): void {
  if (client !== null) {
    throw new Error('SUPABASE_CLIENT_ALREADY_CREATED: setStorageAdapter must be called before getClient()');
  }
  storageAdapter = adapter;
}

/**
 * Return the singleton SupabaseClient. Lazy — instantiates on first call so
 * test harnesses that import auth modules but never call into Supabase don't
 * trip the env-var check in env.ts.
 *
 * Configuration is locked (see the config block below — do not edit without a
 * cross-referenced research update). The five auth options bake in:
 *   - the adapter wired by setStorageAdapter (REQUIRED — throws if missing)
 *   - automatic token refresh (Supabase rotates JWT 5 min before expiry)
 *   - session persistence via the storage adapter on every change
 *   - URL-based session detection disabled (main process is not a browser)
 *   - PKCE flow (RFC 8252; required for the loopback OAuth flow in plan 05)
 *
 * Source: RESEARCH §Pattern 1.
 */
export function getClient(): SupabaseClient {
  if (client !== null) return client;
  if (storageAdapter === null) {
    throw new Error('SUPABASE_NO_STORAGE_ADAPTER: setStorageAdapter must be called before getClient()');
  }
  client = createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    auth: {
      storage: storageAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    // 261029: bound every auth request (see withAuthRequestTimeout).
    global: { fetch: withAuthRequestTimeout() },
  });
  return client;
}

/** Upper bound on one auth-server request (token refresh, sign-in, getUser). */
export const AUTH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * 261029: a fetch that gives up on an auth-server request (`/auth/v1/`) after
 * `timeoutMs`. supabase-js sets no timeout of its own and only retries a
 * refresh after the fetch FAILS, so a server that accepts the connection and
 * never answers held the refresh, and everything waiting on it (getSession,
 * sign-out, the profile move's session reads), forever. The abort surfaces as
 * a retryable fetch error, the same as being offline, so the session is kept.
 * Other requests (PostgREST, storage, functions) pass through untouched; their
 * callers bound them already.
 */
export function withAuthRequestTimeout(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  timeoutMs = AUTH_REQUEST_TIMEOUT_MS,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/auth/v1/')) return fetchImpl(input, init);
    const controller = new AbortController();
    const outer = init?.signal;
    const onOuterAbort = (): void => controller.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = setTimeout(
      () => controller.abort(new Error(`auth request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }) as typeof fetch;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What main needs from a stored supabase-js session to start signed in without the network. */
export interface PersistedSession {
  /** Lowercased account UUID. */
  userId: string;
  user: User;
  accessToken: string;
}

/**
 * The session inside a persisted supabase-js blob, or null. Pure. Mirrors
 * supabase-js's own validity test (access + refresh token + expires_at): a
 * blob it would discard is no session here either.
 */
export function parsePersistedSession(raw: string | null | undefined): PersistedSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    // `currentSession` is the pre-v2 wrapper.
    const s = (parsed.currentSession && typeof parsed.currentSession === 'object'
      ? parsed.currentSession
      : parsed) as { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown; user?: unknown };
    if (!('access_token' in s) || !('refresh_token' in s) || !('expires_at' in s)) return null;
    if (typeof s.access_token !== 'string' || !s.access_token) return null;
    const user = s.user as { id?: unknown } | null | undefined;
    const id = user?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    return { userId: id.toLowerCase(), user: user as User, accessToken: s.access_token };
  } catch {
    return null;
  }
}

/** The user id inside a persisted supabase-js session blob, or null. Pure. */
export function userIdFromPersistedSession(raw: string | null | undefined): string | null {
  return parsePersistedSession(raw)?.userId ?? null;
}

/** The adapter wired at bootstrap, else the client's own (what supabase-js reads). */
function storageOf(c: SupabaseClient): StorageAdapter | null {
  if (storageAdapter) return storageAdapter;
  const own = (c.auth as unknown as { storage?: unknown }).storage as StorageAdapter | undefined;
  return own && typeof own.getItem === 'function' ? own : null;
}

function storageKeyOf(c: SupabaseClient): string | null {
  const key = (c.auth as unknown as { storageKey?: unknown }).storageKey;
  return typeof key === 'string' ? key : null;
}

/**
 * 261029: the persisted session read straight from the storage adapter: no
 * token refresh, no network. initAuthState starts from it, so an offline
 * launch (or one whose refresh is slow) comes up signed in on the account's
 * profile at once; supabase-js's own session load corrects it later.
 */
export async function readPersistedSession(
  deps: { client?: SupabaseClient; storage?: StorageAdapter | null } = {},
): Promise<PersistedSession | null> {
  const c = deps.client ?? getClient();
  const storage = deps.storage !== undefined ? deps.storage : storageOf(c);
  if (!storage) return null;
  const key = storageKeyOf(c);
  if (!key) return null;
  return parsePersistedSession(await storage.getItem(key));
}

/**
 * 261029: drop the stored session without asking the auth server. supabase-js
 * removes it only once its logout request succeeds, or not at all when the
 * token needs a refresh it cannot make, so an offline sign-out left the
 * session on disk and the next launch signed straight back in. Same keys
 * supabase-js's own _removeSession clears.
 */
export async function clearPersistedSession(
  deps: { client?: SupabaseClient; storage?: StorageAdapter | null } = {},
): Promise<void> {
  const c = deps.client ?? getClient();
  const storage = deps.storage !== undefined ? deps.storage : storageOf(c);
  if (!storage) return;
  const key = storageKeyOf(c);
  if (!key) return;
  for (const k of [key, `${key}-code-verifier`, `${key}-user`]) await storage.removeItem(k);
}

/**
 * 261029: the account the PERSISTED session belongs to, read straight from the
 * storage adapter: no token refresh, no network.
 *
 * main/index.ts step 0a picks the boot profile scope with this. It used to call
 * `auth.getSession()`, which REFRESHES an expired access token over the
 * network (supabase-js v2 refreshes inside getSession when the token expires
 * within 90 s, so on most restarts). A failed refresh there (offline for a
 * moment, a 5xx) returned no session, the boot scope fell to 'local', and the
 * window waited out the refresh retries (~25 s) before it was even created.
 * A dead session still resolves here; supabase-js's own session load (the
 * SIGNED_OUT / INITIAL_SESSION event initAuthState listens for) finds it dead
 * and authState moves the scope back to 'local'.
 */
export async function persistedSessionUserId(
  deps: { client?: SupabaseClient; storage?: StorageAdapter | null } = {},
): Promise<string | null> {
  return (await readPersistedSession(deps))?.userId ?? null;
}

/**
 * 261029: sign out on THIS device whether or not the auth server answers.
 * Clears the stored session first, then lets supabase-js sign out locally: with
 * nothing stored it has no logout request to make, so it clears its state and
 * emits SIGNED_OUT to every subscriber (authState moves the scope, jwtBridge
 * drops the bot's JWT).
 *
 * If that local sign-out fails anyway (the clear failed, or a refresh wrote
 * the session back in between, and its reload then failed offline), no
 * SIGNED_OUT is sent: the session is cleared again and the auto-refresh
 * ticker stopped explicitly, or the next tick would bring the session back
 * (TOKEN_REFRESHED) once the network returns. Never throws.
 */
export async function dropSessionLocally(deps: { client?: SupabaseClient } = {}): Promise<void> {
  const client = deps.client ?? getClient();
  const clear = async (): Promise<void> => {
    try {
      await clearPersistedSession({ client });
    } catch (err) {
      console.warn(`[sei] clearing the stored session failed: ${(err as Error).message}`);
    }
  };
  await clear();
  let failed = false;
  try {
    const { error } = await client.auth.signOut({ scope: 'local' });
    failed = !!error;
  } catch {
    failed = true;
  }
  if (!failed) return;
  console.warn('[sei] local sign-out failed; clearing the stored session again');
  await clear();
  try {
    await client.auth.stopAutoRefresh();
  } catch {
    /* nothing to stop */
  }
}

/**
 * Build a short-lived, request-scoped client that authenticates as the given
 * user by sending their JWT in the Authorization header on EVERY PostgREST
 * request. Use this for RLS-scoped reads (ledger_balance, ledger_grants,
 * trial_claims, my_subscription).
 *
 * Why this exists: relying on the singleton's ambient session to attach the
 * access token to outgoing PostgREST requests proved unreliable in the main
 * process — `getClient().auth.getSession()` returns a session, but the
 * persisted-session token was not consistently applied to data requests, so
 * RLS saw an anonymous caller and `auth.uid()` returned null → the user's own
 * rows came back empty (a fresh trial grant read as a 0 balance + the
 * trial_claims row read as absent). Sending `Authorization: Bearer <jwt>`
 * explicitly is the same pattern the Edge Functions' userClient uses and makes
 * RLS resolve `auth.uid()` deterministically.
 *
 * persistSession:false + autoRefreshToken:false — this client never owns the
 * session lifecycle (the singleton does); it's a thin per-request read client,
 * so it touches no storage and starts no refresh timer.
 */
export function getAuthedClient(jwt: string): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** TEST-ONLY: reset the singleton so each test starts clean. Production code must not call. */
export function _resetForTests(): void {
  client = null;
  storageAdapter = null;
}
