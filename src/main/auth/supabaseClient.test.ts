/**
 * Tests for the Supabase client singleton + storage-adapter wiring.
 *
 * Stubs env.ts so the test does not require real Supabase credentials.
 * Stubs @supabase/supabase-js's createClient so the test doesn't depend on
 * actually being able to reach a Supabase project — we only assert the
 * call arguments + singleton behavior + ordering invariants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env', () => ({
  getSupabaseUrl: () => 'https://stub.supabase.co',
  getSupabaseAnonKey: () => 'stub-anon-key',
}));

const createClientMock = vi.fn((..._args: unknown[]) => ({ __stub: true } as unknown));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

// Imported AFTER mocks so the module uses the stubs.
import {
  getClient,
  setStorageAdapter,
  persistedSessionUserId,
  userIdFromPersistedSession,
  parsePersistedSession,
  withAuthRequestTimeout,
  _resetForTests,
  type StorageAdapter,
} from './supabaseClient';

const stubAdapter: StorageAdapter = {
  getItem: async () => null,
  setItem: async () => {},
  removeItem: async () => {},
};

beforeEach(() => {
  createClientMock.mockClear();
  _resetForTests();
});

afterEach(() => {
  _resetForTests();
});

describe('supabaseClient', () => {
  it('getClient() before setStorageAdapter() throws SUPABASE_NO_STORAGE_ADAPTER', () => {
    expect(() => getClient()).toThrowError(/SUPABASE_NO_STORAGE_ADAPTER/);
  });

  it('after setStorageAdapter(stubAdapter), two getClient() calls return the same instance', () => {
    setStorageAdapter(stubAdapter);
    const first = getClient();
    const second = getClient();
    expect(first).toBe(second);
    // createClient called exactly once — singleton
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('setStorageAdapter() after getClient() throws SUPABASE_CLIENT_ALREADY_CREATED', () => {
    setStorageAdapter(stubAdapter);
    getClient();
    expect(() => setStorageAdapter(stubAdapter)).toThrowError(/SUPABASE_CLIENT_ALREADY_CREATED/);
  });
});

describe('persisted session user id (261029 boot scope)', () => {
  const ID = '6F1C2A3B-4D5E-4F60-8A7B-9C0D1E2F3A4B';
  const stored = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    access_token: 'at',
    refresh_token: 'rt',
    expires_at: 1,
    user: { id: ID },
    ...extra,
  });
  it('reads the user id out of a stored session, lowercased', () => {
    expect(userIdFromPersistedSession(JSON.stringify(stored()))).toBe(ID.toLowerCase());
    expect(userIdFromPersistedSession(JSON.stringify({ currentSession: stored() }))).toBe(ID.toLowerCase());
    expect(parsePersistedSession(JSON.stringify(stored()))).toEqual({
      userId: ID.toLowerCase(),
      user: { id: ID },
      accessToken: 'at',
    });
  });
  it('is null for nothing stored, junk, or an id that is not a UUID', () => {
    expect(userIdFromPersistedSession(null)).toBeNull();
    expect(userIdFromPersistedSession('not json')).toBeNull();
    expect(userIdFromPersistedSession(JSON.stringify(stored({ user: { id: '../etc' } })))).toBeNull();
    expect(userIdFromPersistedSession(JSON.stringify(stored({ user: null })))).toBeNull();
  });
  it('is null for a blob supabase-js would not load as a session (main starts from it signed in)', () => {
    for (const k of ['access_token', 'refresh_token', 'expires_at']) {
      const s = stored();
      delete s[k];
      expect(userIdFromPersistedSession(JSON.stringify(s))).toBeNull();
    }
    expect(userIdFromPersistedSession(JSON.stringify(stored({ access_token: '' })))).toBeNull();
  });
  it("reads the client's own storage key through the adapter", async () => {
    const getItem = vi.fn(async (k: string) => (k === 'sb-stub-auth-token' ? JSON.stringify(stored()) : null));
    const storage: StorageAdapter = { ...stubAdapter, getItem };
    const client = { auth: { storageKey: 'sb-stub-auth-token' } } as never;
    expect(await persistedSessionUserId({ client, storage })).toBe(ID.toLowerCase());
    expect(await persistedSessionUserId({ client, storage: null })).toBeNull();
  });
});

describe('withAuthRequestTimeout (261029 review)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const hanging = vi.fn(
    (_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );
  it('aborts an auth request that hangs past the bound', async () => {
    vi.useFakeTimers();
    const f = withAuthRequestTimeout(hanging as unknown as typeof fetch, 15_000);
    const p = f('https://stub.supabase.co/auth/v1/token?grant_type=refresh_token', { method: 'POST' });
    const settled = vi.fn();
    p.then(settled, settled);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toThrow(/timed out after 15000ms/);
  });
  it('leaves other requests (data, storage, functions) alone', async () => {
    const plain = vi.fn(async () => new Response('ok'));
    const f = withAuthRequestTimeout(plain as unknown as typeof fetch, 10);
    const init = { method: 'GET' };
    await f('https://stub.supabase.co/rest/v1/characters', init);
    expect(plain).toHaveBeenCalledWith('https://stub.supabase.co/rest/v1/characters', init);
  });
  it("still honours the caller's own abort", async () => {
    const f = withAuthRequestTimeout(hanging as unknown as typeof fetch, 60_000);
    const ac = new AbortController();
    const p = f('https://stub.supabase.co/auth/v1/user', { signal: ac.signal });
    ac.abort(new Error('caller gave up'));
    await expect(p).rejects.toThrow(/caller gave up/);
  });
});
