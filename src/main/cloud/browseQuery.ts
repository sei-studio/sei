/**
 * browseQuery — the two cloud reads behind the World tab (product call 261110).
 *
 *   - fetchBrowseRows: one page of shared characters in the requested order.
 *     Tries `search_public_characters_sorted` (server-side Popular / Newest /
 *     A-Z) and falls back to the original `search_public_characters`
 *     (newest first) when the new RPC is missing or errors, reporting
 *     `sorted: false` so the renderer sorts the loaded pages itself, exactly
 *     as before. A World tab must never come back empty because the server
 *     side of a feature is not deployed yet.
 *   - fetchAddCounts: aggregate "added to library" counts for one page of ids
 *     via `character_library_counts`. Any failure means "unknown" (null): the
 *     cards just hide the number.
 *
 * A missing RPC (PostgREST PGRST202 / Postgres 42883) is remembered for
 * MISSING_RETRY_MS so a client running against an older database does not
 * pay a failed round trip on every page; after that it probes again, so the
 * feature turns on without a restart once the SQL is applied.
 *
 * Both RPCs are defined in sei-proxy
 * supabase/migrations/20261110120000_world_popular_sort.sql.
 */

import type { BrowseSort } from '../../shared/ipc';

export const SORTED_RPC = 'search_public_characters_sorted';
export const LEGACY_RPC = 'search_public_characters';
export const COUNTS_RPC = 'character_library_counts';
export const MISSING_RETRY_MS = 10 * 60_000;

interface RpcError {
  message: string;
  code?: string;
}

/** The slice of a supabase-js client these reads use. */
export interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

const missingUntil = new Map<string, number>();

/** Test hook: forget remembered missing RPCs. */
export function resetMissingRpcMemo(): void {
  missingUntil.clear();
}

function isMissingRpc(error: RpcError): boolean {
  return error.code === 'PGRST202' || error.code === '42883';
}

function knownMissing(fn: string, now: number): boolean {
  const until = missingUntil.get(fn);
  if (until === undefined) return false;
  if (now >= until) {
    missingUntil.delete(fn);
    return false;
  }
  return true;
}

function noteError(fn: string, error: RpcError, now: number): void {
  if (isMissingRpc(error)) missingUntil.set(fn, now + MISSING_RETRY_MS);
}

export interface BrowseRowsResult {
  rows: Array<Record<string, unknown>>;
  /** True when the rows come back in `sort` order (server-side). */
  sorted: boolean;
  /** Set when no listing could be fetched at all. */
  error: string | null;
}

export async function fetchBrowseRows(
  client: RpcClient,
  args: { query: string; limit: number; offset: number; sort?: BrowseSort },
  now: number = Date.now(),
): Promise<BrowseRowsResult> {
  if (args.sort && !knownMissing(SORTED_RPC, now)) {
    const { data, error } = await client.rpc(SORTED_RPC, {
      search_query: args.query,
      page_limit: args.limit,
      page_offset: args.offset,
      sort_by: args.sort,
    });
    if (!error) {
      return { rows: (data ?? []) as Array<Record<string, unknown>>, sorted: true, error: null };
    }
    noteError(SORTED_RPC, error, now);
    console.warn(`[sei] browse:list sorted rpc failed, using newest-first: ${error.message}`);
  }
  const { data, error } = await client.rpc(LEGACY_RPC, {
    search_query: args.query,
    page_limit: args.limit,
    page_offset: args.offset,
  });
  if (error) {
    console.warn(`[sei] browse:list rpc failed: ${error.message}`);
    return { rows: [], sorted: false, error: error.message };
  }
  // The legacy RPC orders by updated_at desc, which IS the 'recent' order.
  return {
    rows: (data ?? []) as Array<Record<string, unknown>>,
    sorted: args.sort === 'recent',
    error: null,
  };
}

/**
 * Add counts for `ids`. Ids missing from the RPC answer had no adds (0).
 * Returns null when the counts are unknown.
 */
export async function fetchAddCounts(
  client: RpcClient,
  ids: readonly string[],
  now: number = Date.now(),
): Promise<Map<string, number> | null> {
  if (ids.length === 0) return new Map();
  if (knownMissing(COUNTS_RPC, now)) return null;
  try {
    const { data, error } = await client.rpc(COUNTS_RPC, { character_ids: [...ids] });
    if (error) {
      noteError(COUNTS_RPC, error, now);
      return null;
    }
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, 0);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = typeof row.character_id === 'string' ? row.character_id : null;
      const adds = Number(row.adds);
      if (id && Number.isFinite(adds) && adds >= 0) counts.set(id, Math.floor(adds));
    }
    return counts;
  } catch {
    return null;
  }
}
