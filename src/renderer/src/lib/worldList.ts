/**
 * worldList — pure helpers for the World tab (product call 261110).
 *
 *   - mergeWorldEntries: the cloud pages plus the bundled defaults, in the
 *     order the grid shows them.
 *   - formatAddCount: the compact "added to library" number on cards and the
 *     profile ("1.2K", locale aware).
 *
 * Ordering. When the server applied the sort (`serverSorted`), its order is
 * the truth: the list is paged, so re-sorting only the loaded pages would put
 * page 3's most popular card above page 1's. The bundled defaults (Sui, Lyra,
 * Marv) are shared cloud rows too, so they arrive in their server position;
 * the local default entry only replaces that row's DISPLAY data (local art,
 * "by Sei", the added_default_ids library flag) and keeps the server's add
 * count. A default the server did not return (offline, a search the cloud
 * copy does not match) is appended once the listing is exhausted, so it is
 * never lost. When the server could not sort (older database, newest-first
 * fallback) the merged list is sorted on the client like before 261110:
 * defaults first, then by the chosen sort over what is loaded.
 */

import type { BrowseEntry, BrowseSort } from '@shared/ipc';

export interface MergeWorldArgs {
  /** Local bundled defaults already filtered by the search query. */
  defaults: readonly BrowseEntry[];
  /**
   * Every local default regardless of the query (display data for a server
   * row of the same id). Defaults to `defaults`.
   */
  allDefaults?: readonly BrowseEntry[];
  /** Cloud entries in server order, all loaded pages. */
  entries: readonly BrowseEntry[];
  sort: BrowseSort;
  serverSorted: boolean;
  exhausted: boolean;
}

function byName(a: BrowseEntry, b: BrowseEntry): number {
  return a.name.localeCompare(b.name);
}

function byNewest(a: BrowseEntry, b: BrowseEntry): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/** Client-side order over loaded entries (fallback only). */
export function compareWorldEntries(sort: BrowseSort): (a: BrowseEntry, b: BrowseEntry) => number {
  if (sort === 'recent') return byNewest;
  if (sort === 'alpha') return byName;
  // popular: known counts first, most adds first; unknown counts sort like
  // the pre-261110 default (A-Z).
  return (a, b) => {
    const diff = (b.addCount ?? 0) - (a.addCount ?? 0);
    return diff !== 0 ? diff : byName(a, b);
  };
}

export function mergeWorldEntries(args: MergeWorldArgs): BrowseEntry[] {
  const { defaults, entries, sort, serverSorted, exhausted } = args;
  const defaultById = new Map(defaults.map((d) => [d.id, d]));
  if (serverSorted) {
    const displayById = new Map((args.allDefaults ?? defaults).map((d) => [d.id, d]));
    const seen = new Set<string>();
    const out: BrowseEntry[] = [];
    for (const e of entries) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const local = displayById.get(e.id);
      out.push(local ? { ...local, addCount: e.addCount ?? local.addCount } : e);
    }
    if (exhausted) {
      for (const d of defaults) if (!seen.has(d.id)) out.push(d);
    }
    return out;
  }
  const merged = [
    ...defaults.map((d) => {
      const cloud = entries.find((e) => e.id === d.id);
      return cloud && cloud.addCount !== null ? { ...d, addCount: cloud.addCount } : d;
    }),
    ...entries.filter((e) => !defaultById.has(e.id)),
  ];
  return merged.sort(compareWorldEntries(sort));
}

const compactFormatters = new Map<string, Intl.NumberFormat>();

/**
 * Compact count: 7 -> "7", 1234 -> "1.2K", 15300 -> "15K" (en), with the
 * locale's own compact form elsewhere. Returns null when there is nothing to
 * show (unknown, zero, negative, not a number) so callers hide the badge.
 */
export function formatAddCount(n: number | null | undefined, localeTag = 'en-US'): string | null {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null;
  const value = Math.floor(n);
  let fmt = compactFormatters.get(localeTag);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(localeTag, { notation: 'compact', maximumFractionDigits: 1 });
    } catch {
      fmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
    }
    compactFormatters.set(localeTag, fmt);
  }
  return fmt.format(value);
}
