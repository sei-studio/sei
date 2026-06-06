/**
 * Tests for src/main/cloud/deletionQueueWriter.
 *
 * Source: 11-10-PLAN <behavior> bullets:
 *   - enqueueStorageOrphans inserts a single deletion_queue row with the given paths
 *   - storage_paths is a JSONB array of strings
 *   - 15s timeout via AbortController
 *   - RLS denial throws CLOUD_DELETION_QUEUE_INSERT_FAILED
 *   - Empty paths array is a no-op (does not call supabase)
 *
 * Mock strategy: mirror cloudCharacterClient.test.ts — vi.mock the
 * supabaseClient singleton with a hand-rolled mock chain we can inspect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface CapturedInsert {
  payload: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

interface MockState {
  insert: CapturedInsert;
  insertError: { message: string } | null;
  fromCalls: string[];
  /** When true the insert hangs and honors the AbortSignal — used to test timeout */
  hangInsert: boolean;
}

const state: MockState = {
  insert: { payload: null, signal: null },
  insertError: null,
  fromCalls: [],
  hangInsert: false,
};

function resetState(): void {
  state.insert = { payload: null, signal: null };
  state.insertError = null;
  state.fromCalls = [];
  state.hangInsert = false;
}

function makeInsertBuilder() {
  return {
    abortSignal(s: AbortSignal) {
      state.insert.signal = s;
      if (state.hangInsert) {
        return new Promise((_resolve, reject) => {
          s.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as Error & { name: string }).name = 'AbortError';
            reject(err);
          });
        });
      }
      return Promise.resolve({ error: state.insertError });
    },
  };
}

function makeFromBuilder() {
  return {
    insert(payload: Record<string, unknown>) {
      state.insert.payload = payload;
      return makeInsertBuilder();
    },
  };
}

const mockClient = {
  from: vi.fn((table: string) => {
    state.fromCalls.push(table);
    return makeFromBuilder();
  }),
};

vi.mock('../auth/supabaseClient', () => ({
  getClient: () => mockClient,
}));

const OWNER = '00000000-0000-0000-0000-000000000001';
const CHAR_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  resetState();
  mockClient.from.mockClear();
});

describe('deletionQueueWriter.enqueueStorageOrphans', () => {
  it('is a no-op when paths array is empty (does not call supabase)', async () => {
    const { enqueueStorageOrphans } = await import('./deletionQueueWriter');
    await enqueueStorageOrphans(OWNER, []);
    expect(state.insert.payload).toBeNull();
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('inserts a deletion_queue row with the given user_id and storage_paths', async () => {
    const { enqueueStorageOrphans } = await import('./deletionQueueWriter');
    const paths = [`${OWNER}/${CHAR_ID}.png`];
    await enqueueStorageOrphans(OWNER, paths);
    expect(state.fromCalls).toContain('deletion_queue');
    expect(state.insert.payload).not.toBeNull();
    expect(state.insert.payload!.user_id).toBe(OWNER);
    expect(state.insert.payload!.storage_paths).toEqual(paths);
  });

  it('wraps the insert in an AbortController (signal is an AbortSignal instance)', async () => {
    const { enqueueStorageOrphans } = await import('./deletionQueueWriter');
    await enqueueStorageOrphans(OWNER, [`${OWNER}/${CHAR_ID}.png`]);
    expect(state.insert.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws CLOUD_DELETION_QUEUE_INSERT_FAILED when the supabase insert errors (RLS denial)', async () => {
    state.insertError = { message: 'new row violates row-level security policy' };
    const { enqueueStorageOrphans } = await import('./deletionQueueWriter');
    await expect(
      enqueueStorageOrphans(OWNER, [`${OWNER}/${CHAR_ID}.png`]),
    ).rejects.toThrow(/CLOUD_DELETION_QUEUE_INSERT_FAILED.*row-level security/);
  });

  it('aborts via the 15s timer when the call hangs', async () => {
    vi.useFakeTimers();
    state.hangInsert = true;
    const { enqueueStorageOrphans } = await import('./deletionQueueWriter');
    const promise = enqueueStorageOrphans(OWNER, [`${OWNER}/${CHAR_ID}.png`]);
    // Attach a no-op catch so Node doesn't observe a transient unhandled rejection
    // before the awaiter below grabs it.
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_001);
    // The signal should be aborted by the timer firing.
    expect(state.insert.signal?.aborted).toBe(true);
    // The promise rejects (with the underlying AbortError surfaced by the mock).
    await expect(promise).rejects.toThrow();
    vi.useRealTimers();
  });
});
