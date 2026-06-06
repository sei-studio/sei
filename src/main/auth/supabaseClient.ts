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
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
  });
  return client;
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
