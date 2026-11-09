import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COUNTS_RPC,
  LEGACY_RPC,
  MISSING_RETRY_MS,
  SORTED_RPC,
  fetchAddCounts,
  fetchBrowseRows,
  resetMissingRpcMemo,
  type RpcClient,
} from './browseQuery';

type Answer = { data: unknown; error: { message: string; code?: string } | null };

function client(answers: Record<string, Answer | (() => Answer)>): RpcClient & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push([fn, args]);
      const a = answers[fn];
      const answer = typeof a === 'function' ? a() : a;
      return Promise.resolve(answer ?? { data: null, error: { message: 'no such fn', code: 'PGRST202' } });
    },
  };
}

const MISSING = { data: null, error: { message: 'Could not find the function', code: 'PGRST202' } };
const ARGS = { query: 'sun', limit: 24, offset: 48, sort: 'popular' as const };

beforeEach(() => {
  resetMissingRpcMemo();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('fetchBrowseRows', () => {
  it('uses the sorted RPC with the sort and paging args', async () => {
    const c = client({ [SORTED_RPC]: { data: [{ id: 'a' }], error: null } });
    const out = await fetchBrowseRows(c, ARGS);
    expect(out).toEqual({ rows: [{ id: 'a' }], sorted: true, error: null });
    expect(c.calls).toEqual([[SORTED_RPC, { search_query: 'sun', page_limit: 24, page_offset: 48, sort_by: 'popular' }]]);
  });

  it('falls back to the newest-first RPC when the sorted one is missing, and remembers it', async () => {
    const c = client({ [SORTED_RPC]: MISSING, [LEGACY_RPC]: { data: [{ id: 'b' }], error: null } });
    const out = await fetchBrowseRows(c, ARGS, 1000);
    expect(out).toEqual({ rows: [{ id: 'b' }], sorted: false, error: null });
    expect(c.calls.map(([fn]) => fn)).toEqual([SORTED_RPC, LEGACY_RPC]);
    expect(c.calls[1][1]).toEqual({ search_query: 'sun', page_limit: 24, page_offset: 48 });

    // Next page within the retry window skips the missing RPC.
    c.calls.length = 0;
    await fetchBrowseRows(c, ARGS, 2000);
    expect(c.calls.map(([fn]) => fn)).toEqual([LEGACY_RPC]);

    // After the window it probes again.
    c.calls.length = 0;
    await fetchBrowseRows(c, ARGS, 1000 + MISSING_RETRY_MS);
    expect(c.calls.map(([fn]) => fn)).toEqual([SORTED_RPC, LEGACY_RPC]);
  });

  it('the fallback order counts as sorted for "recent" (it is newest first)', async () => {
    const c = client({ [SORTED_RPC]: MISSING, [LEGACY_RPC]: { data: [], error: null } });
    expect((await fetchBrowseRows(c, { ...ARGS, sort: 'recent' })).sorted).toBe(true);
  });

  it('a transient sorted-RPC error falls back without being remembered', async () => {
    const c = client({
      [SORTED_RPC]: { data: null, error: { message: 'timeout', code: '57014' } },
      [LEGACY_RPC]: { data: [], error: null },
    });
    await fetchBrowseRows(c, ARGS, 0);
    c.calls.length = 0;
    await fetchBrowseRows(c, ARGS, 1);
    expect(c.calls[0][0]).toBe(SORTED_RPC);
  });

  it('reports an error only when no listing could be fetched', async () => {
    const c = client({ [SORTED_RPC]: MISSING, [LEGACY_RPC]: { data: null, error: { message: 'down' } } });
    expect(await fetchBrowseRows(c, ARGS)).toEqual({ rows: [], sorted: false, error: 'down' });
  });

  it('without a sort it calls only the legacy RPC (old renderer)', async () => {
    const c = client({ [LEGACY_RPC]: { data: [], error: null } });
    await fetchBrowseRows(c, { query: '', limit: 24, offset: 0 });
    expect(c.calls.map(([fn]) => fn)).toEqual([LEGACY_RPC]);
  });
});

describe('fetchAddCounts', () => {
  it('maps counts and fills 0 for ids with no adds', async () => {
    const c = client({ [COUNTS_RPC]: { data: [{ character_id: 'a', adds: 1140 }, { character_id: 'b', adds: '7' }], error: null } });
    const out = await fetchAddCounts(c, ['a', 'b', 'c']);
    expect(out && Object.fromEntries(out)).toEqual({ a: 1140, b: 7, c: 0 });
    expect(c.calls).toEqual([[COUNTS_RPC, { character_ids: ['a', 'b', 'c'] }]]);
  });

  it('is unknown (null) when the RPC is missing, and skips it for a while', async () => {
    const c = client({ [COUNTS_RPC]: MISSING });
    expect(await fetchAddCounts(c, ['a'], 0)).toBeNull();
    c.calls.length = 0;
    expect(await fetchAddCounts(c, ['a'], 10)).toBeNull();
    expect(c.calls).toEqual([]);
  });

  it('is unknown on a thrown request and skips the call for an empty page', async () => {
    const throwing: RpcClient = { rpc: () => Promise.reject(new Error('net')) };
    expect(await fetchAddCounts(throwing, ['a'])).toBeNull();
    const c = client({});
    expect(await fetchAddCounts(c, [])).toEqual(new Map());
    expect(c.calls).toEqual([]);
  });
});
