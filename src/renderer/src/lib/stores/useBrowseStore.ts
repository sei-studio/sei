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
import type { BrowseEntry } from '@shared/ipc';
import { sei } from '../ipcClient';

const PAGE_SIZE = 24;
const DEBOUNCE_MS = 250;

interface BrowseState {
  entries: BrowseEntry[];
  query: string;
  loading: boolean;
  exhausted: boolean;
  offset: number;
  error: string | null;
  /** Internal — current debounce timer handle, null when no debounce pending. */
  _debounceHandle: number | null;
}

interface BrowseActions {
  /** Schedules a debounced (DEBOUNCE_MS) refresh; cancels any prior pending timer. */
  setQuery: (q: string) => void;
  /** Appends the next page; no-op when loading or exhausted. */
  loadMore: () => Promise<void>;
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
  loading: false,
  exhausted: false,
  offset: 0,
  error: null,
  _debounceHandle: null,
};

export const useBrowseStore = create<BrowseState & BrowseActions>((set, get) => ({
  ...initial,

  setQuery: (q: string): void => {
    const prev = get()._debounceHandle;
    if (prev !== null) window.clearTimeout(prev);
    // Update the query field immediately so the input stays responsive while
    // the debounced fetch waits for the typing to settle.
    set({ query: q });
    const handle = window.setTimeout(() => {
      set({ _debounceHandle: null });
      void get().refresh();
    }, DEBOUNCE_MS);
    set({ _debounceHandle: handle });
  },

  loadMore: async (): Promise<void> => {
    const s = get();
    if (s.loading || s.exhausted) return;  // Pitfall 8 in-flight guard.
    set({ loading: true, error: null });
    try {
      const page = await sei.browseList({
        query: s.query,
        limit: PAGE_SIZE,
        offset: s.offset,
      });
      set({
        entries: [...s.entries, ...page.entries],
        offset: s.offset + page.entries.length,
        exhausted: !page.hasMore,
        loading: false,
      });
    } catch (e) {
      set({
        loading: false,
        error: (e as Error).message ?? 'browse_load_failed',
      });
    }
  },

  refresh: async (): Promise<void> => {
    // Wipe entries + offset BEFORE the fetch so a slow refresh doesn't visually
    // double the grid mid-fetch. error reset so a prior failure doesn't linger.
    set({
      loading: true,
      entries: [],
      offset: 0,
      exhausted: false,
      error: null,
    });
    try {
      const q = get().query;
      const page = await sei.browseList({
        query: q,
        limit: PAGE_SIZE,
        offset: 0,
      });
      set({
        entries: page.entries,
        offset: page.entries.length,
        exhausted: !page.hasMore,
        loading: false,
      });
    } catch (e) {
      set({
        loading: false,
        error: (e as Error).message ?? 'browse_load_failed',
      });
    }
  },

  prefetch: async (): Promise<void> => {
    const s = get();
    // Already warm, already fetching, or a search is active — nothing to do.
    if (s.loading || s.entries.length > 0 || s.query) return;
    set({ loading: true, error: null });
    try {
      const page = await sei.browseList({ query: '', limit: PAGE_SIZE, offset: 0 });
      set({
        entries: page.entries,
        offset: page.entries.length,
        exhausted: !page.hasMore,
        loading: false,
      });
    } catch (e) {
      set({
        loading: false,
        error: (e as Error).message ?? 'browse_load_failed',
      });
    }
  },

  reset: (): void => {
    const prev = get()._debounceHandle;
    if (prev !== null) window.clearTimeout(prev);
    set({ ...initial });
  },
}));
