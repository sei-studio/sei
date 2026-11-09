/**
 * useBrowseStore — Phase 12 Plan 09 Browse tab state.
 *
 * Source of truth for the Browse grid + search field on CharactersScreen.
 * Mirrors useCloudCharactersStore's state/actions split + useSyncStore's
 * idempotent init pattern.
 *
 * Lifecycle:
 *   - The store does NOT self-bootstrap. CharactersScreen's BrowseTab calls
 *     `useBrowseStore.getState().refresh()` from a useEffect on first mount,
 *     mirroring the way App.tsx wires useSyncStore.init() — keeps test
 *     determinism (no IPC fires on module import) and prevents the store from
 *     trying to call window.sei before the preload bridge is ready.
 *
 *   - `setQuery(q)` cancels any pending debounce timer and schedules a fresh
 *     `refresh()` after DEBOUNCE_MS (CONTEXT D-31a). The debounce lives HERE,
 *     not in the screen, so any future consumer of the store (e.g.
 *     ReportModal's post-submit refresh in 12-13) inherits the same
 *     consistency guarantee.
 *
 *   - `loadMore()` appends the next page (offset += page.entries.length).
 *     Pitfall 8: short-circuits when `loading=true` OR `exhausted=true` so
 *     rapid scroll on a slow network can't double-fetch.
 *
 *   - `refresh()` resets entries to empty + fetches offset=0 with the current
 *     query. Used by setQuery's debounced firing AND by ReportModal's
 *     post-report refresh (12-13 may opt-in or not).
 *
 *   - `reset()` returns the store to its initial state AND cancels any
 *     pending debounce — important so a queued refresh from a recent
 *     setQuery doesn't fire after the consumer thought it had wiped state.
 *
 * 261110 (product call): World auto-loads on scroll (no "Load more" button)
 * and sorts by popularity by default.
 *   - `sort` lives here (default DEFAULT_BROWSE_SORT = 'popular') and is sent
 *     with every page; `setSort` refetches from offset 0. `serverSorted`
 *     records whether main's answer is in that order (false = the server fell
 *     back to newest first; WorldGrid then sorts the loaded pages).
 *   - Every fetch carries a sequence number. A refresh (new search, new sort)
 *     supersedes whatever is in flight, and a superseded answer is dropped,
 *     so a slow page from the previous sort can never land in the new list.
 *   - A failed NEXT page sets `loadMoreFailed` instead of `error`: the loaded
 *     cards stay, auto-load stops (no retry loop), and the grid offers a
 *     quiet "Try again" (`retryLoadMore`).
 *   - Each page fires `world_page_loaded` (shape only).
 *
 * Constants:
 *   - PAGE_SIZE = 24 (CONTEXT D-31b — infinite-scroll page size).
 *   - DEBOUNCE_MS = 250 (CONTEXT D-31a — search input debounce).
 *
 * Type note (Pitfall 8 + 12-PATTERNS.md):
 *   - The debounce timer handle is `window.setTimeout(...)` so the TS return
 *     type is `number` (browser DOM lib), NOT `NodeJS.Timeout`. Mirrors how
 *     other renderer stores handle timer typing.
 *
 * Sources:
 *   - 12-09-PLAN.md
 *   - 12-CONTEXT.md §D-31a/b/c/d
 *   - 12-PATTERNS.md §useBrowseStore
 *   - 12-08-SUMMARY.md (IPC contract: window.sei.browseList)
 */

import { create } from 'zustand';
import { DEFAULT_BROWSE_SORT, type BrowseEntry, type BrowsePage, type BrowseSort } from '@shared/ipc';
import { sei } from '../ipcClient';

export const PAGE_SIZE = 24;
const DEBOUNCE_MS = 250;

/** What asked for a page (analytics). */
export type BrowseFetchTrigger = 'initial' | 'search' | 'sort' | 'scroll' | 'retry';

interface BrowseState {
  entries: BrowseEntry[];
  query: string;
  sort: BrowseSort;
  /** True once the user picked a sort themselves (analytics: default vs chosen). */
  sortChosen: boolean;
  /** Whether the loaded pages are in `sort` order server-side. */
  serverSorted: boolean;
  loading: boolean;
  exhausted: boolean;
  offset: number;
  /** Pages fetched for the current query + sort (0 = none yet). */
  pages: number;
  error: string | null;
  /** The last NEXT-page fetch failed; auto-load pauses until a retry. */
  loadMoreFailed: boolean;
  /** Internal — current debounce timer handle, null when no debounce pending. */
  _debounceHandle: number | null;
  /** Internal — bumps on every refresh/reset; stale answers are dropped. */
  _seq: number;
}

interface BrowseActions {
  /** Schedules a debounced (DEBOUNCE_MS) refresh; cancels any prior pending timer. */
  setQuery: (q: string) => void;
  /** Changes the sort and refetches from the first page (no-op when unchanged). */
  setSort: (sort: BrowseSort) => void;
  /** Appends the next page; no-op when loading, exhausted or after a failed page. */
  loadMore: () => Promise<void>;
  /** Clears a failed next page and fetches it again. */
  retryLoadMore: () => Promise<void>;
  /** Replaces entries with offset=0 results for the current query. */
  refresh: () => Promise<void>;
  /**
   * Warm the first page IF the store is cold (no entries, not already loading,
   * no active search query). Idempotent and non-destructive — safe to call
   * from a hover handler on the World rail icon so the grid is already
   * populated by the time the tab mounts. Unlike refresh() it never wipes a
   * populated grid or clobbers an in-flight/searched state.
   */
  prefetch: () => Promise<void>;
  /** Returns the store to initial state and cancels any pending debounce. */
  reset: () => void;
}

const initial: BrowseState = {
  entries: [],
  query: '',
  sort: DEFAULT_BROWSE_SORT,
  sortChosen: false,
  serverSorted: false,
  loading: false,
  exhausted: false,
  offset: 0,
  pages: 0,
  error: null,
  loadMoreFailed: false,
  _debounceHandle: null,
  _seq: 0,
};

/** Shape-only page analytics; never disrupts the grid. */
function trackPage(props: {
  trigger: BrowseFetchTrigger;
  pageIndex: number;
  sort: BrowseSort;
  sortChosen: boolean;
  searching: boolean;
  page: BrowsePage | null;
  failure: string | null;
}): void {
  try {
    const entries = props.page?.entries ?? [];
    sei.track('world_page_loaded', {
      trigger: props.trigger,
      page_index: props.pageIndex,
      batch_size: PAGE_SIZE,
      returned: entries.length,
      has_more: props.page?.hasMore ? 1 : 0,
      sort: props.sort,
      sort_source: props.sortChosen ? 'chosen' : 'default',
      server_sorted: props.page?.sorted ? 1 : 0,
      searching: props.searching ? 1 : 0,
      counts_known: entries.some((e) => e.addCount !== null) ? 1 : 0,
      counts_shown: entries.filter((e) => (e.addCount ?? 0) > 0).length,
      outcome: props.failure ? 'error' : 'ok',
      failure_class: props.failure ?? 'none',
    });
  } catch {
    /* analytics must never disrupt the page */
  }
}

export const useBrowseStore = create<BrowseState & BrowseActions>((set, get) => {
  /**
   * Fetch one page. `fresh` = first page of a new list (replaces entries).
   * Returns without touching state when a newer refresh superseded it.
   */
  const fetchPage = async (fresh: boolean, trigger: BrowseFetchTrigger): Promise<void> => {
    const s = get();
    const seq = fresh ? s._seq + 1 : s._seq;
    const offset = fresh ? 0 : s.offset;
    const pageIndex = fresh ? 0 : s.pages;
    if (fresh) {
      // Wipe entries + offset BEFORE the fetch so a slow refresh doesn't
      // visually double the grid mid-fetch. error reset so a prior failure
      // doesn't linger.
      set({
        _seq: seq,
        loading: true,
        entries: [],
        offset: 0,
        pages: 0,
        exhausted: false,
        error: null,
        loadMoreFailed: false,
      });
    } else {
      set({ loading: true, error: null, loadMoreFailed: false });
    }
    const { query, sort, sortChosen } = get();
    let page: BrowsePage;
    try {
      page = await sei.browseList({ query, limit: PAGE_SIZE, offset, sort });
    } catch (e) {
      if (get()._seq !== seq) return;
      trackPage({ trigger, pageIndex, sort, sortChosen, searching: !!query, page: null, failure: 'ipc_failed' });
      if (fresh) {
        set({ loading: false, error: (e as Error).message ?? 'browse_load_failed' });
      } else {
        set({ loading: false, loadMoreFailed: true });
      }
      return;
    }
    if (get()._seq !== seq) return;
    const failure = page.failure ?? null;
    trackPage({ trigger, pageIndex, sort, sortChosen, searching: !!query, page, failure });
    if (failure && !fresh) {
      // A failed next page is not the end of the list: keep what is loaded,
      // pause auto-load, offer a retry.
      set({ loading: false, loadMoreFailed: true });
      return;
    }
    const prev = fresh ? [] : get().entries;
    set({
      entries: [...prev, ...page.entries],
      offset: offset + page.entries.length,
      pages: pageIndex + 1,
      exhausted: !page.hasMore,
      // A page from the fallback RPC makes the whole list unsorted.
      serverSorted: fresh ? page.sorted : get().serverSorted && page.sorted,
      loading: false,
    });
  };

  return {
    ...initial,

    setQuery: (q: string): void => {
      const prev = get()._debounceHandle;
      if (prev !== null) window.clearTimeout(prev);
      // Update the query field immediately so the input stays responsive while
      // the debounced fetch waits for the typing to settle.
      set({ query: q });
      const handle = window.setTimeout(() => {
        set({ _debounceHandle: null });
        void fetchPage(true, 'search');
      }, DEBOUNCE_MS);
      set({ _debounceHandle: handle });
    },

    setSort: (sort: BrowseSort): void => {
      const s = get();
      if (s.sort === sort) return;
      // A pending search debounce is folded into this fetch (same query).
      if (s._debounceHandle !== null) window.clearTimeout(s._debounceHandle);
      try {
        sei.track('world_sort_selected', {
          sort,
          previous: s.sort,
          is_default: sort === DEFAULT_BROWSE_SORT ? 1 : 0,
          searching: s.query ? 1 : 0,
        });
      } catch {
        /* analytics must never disrupt the page */
      }
      set({ sort, sortChosen: true, _debounceHandle: null });
      void fetchPage(true, 'sort');
    },

    loadMore: async (): Promise<void> => {
      const s = get();
      // Pitfall 8 in-flight guard; a failed page (first or next) waits for
      // retryLoadMore, so a broken connection can never spin a fetch loop.
      if (s.loading || s.exhausted || s.loadMoreFailed || s.error !== null) return;
      await fetchPage(s.pages === 0 && s.entries.length === 0, s.pages === 0 ? 'initial' : 'scroll');
    },

    retryLoadMore: async (): Promise<void> => {
      const s = get();
      if (s.loading) return;
      set({ loadMoreFailed: false });
      await fetchPage(s.pages === 0 && s.entries.length === 0, 'retry');
    },

    refresh: async (): Promise<void> => {
      await fetchPage(true, 'search');
    },

    prefetch: async (): Promise<void> => {
      const s = get();
      // Already warm, already fetching, or a search is active — nothing to do.
      if (s.loading || s.entries.length > 0 || s.query) return;
      await fetchPage(true, 'initial');
    },

    reset: (): void => {
      const s = get();
      if (s._debounceHandle !== null) window.clearTimeout(s._debounceHandle);
      // Keep bumping the sequence so an answer in flight is dropped.
      set({ ...initial, _seq: s._seq + 1 });
    },
  };
});
