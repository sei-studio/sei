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
import { getClient, setStorageAdapter, _resetForTests, type StorageAdapter } from './supabaseClient';

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
