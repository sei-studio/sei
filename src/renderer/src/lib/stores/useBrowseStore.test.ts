/**
 * Tests for useBrowseStore — Phase 12 Plan 09 Browse tab state.
 *
 * RED phase: this file lands BEFORE useBrowseStore.ts exists. The implementation
 * lands in the GREEN-phase commit immediately after.
 *
 * Invariants under test (mirroring CONTEXT D-31a/b/c + 12-PATTERNS.md + Pitfall 8):
 *   1. setQuery debounces 250ms IN THE STORE (not in the screen) so multiple
 *      consumers observe consistent state.
 *   2. Rapid setQuery calls collapse to ONE refresh fetch with the final query.
 *   3. loadMore is a no-op when loading=true (in-flight guard) — Pitfall 8.
 *   4. loadMore is a no-op when exhausted=true (server says no more rows).
 *   5. loadMore APPENDS to entries; refresh REPLACES from offset=0.
 *   6. hasMore=false from main → store.exhausted becomes true.
 *   7. window.sei.browseList rejection → store.error set, loading=false.
 *   8. reset() clears every state field back to defaults (including any pending
 *      debounce handle so a queued refresh doesn't fire post-reset).
 *
 * Mock strategy: stub `window.sei.browseList` via globalThis.window before
 * importing the store. vi.useFakeTimers controls the 250ms debounce window so
 * tests don't actually wait wall-clock time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowseEntry, BrowsePage, BrowseSort } from '@shared/ipc';

// --- Test fixtures --------------------------------------------------------

function entry(id: string, name = `char-${id}`): BrowseEntry {
  return {
    id,
    publicId: null,
    name,
    personaSnippet: `${name} persona`,
    creatorLabel: 'by anonymous',
    portraitUrl: null,
    thumbUrl: null,
    skinUrl: null,
    updatedAt: new Date(0).toISOString(),
    inMyLibrary: false,
    addCount: null,
  };
}

type BrowseListArgs = { query: string; limit: number; offset: number; sort?: BrowseSort };
type BrowseListResult = BrowsePage;

let browseListMock: ReturnType<typeof vi.fn<(args: BrowseListArgs) => Promise<BrowseListResult>>>;
let trackMock: ReturnType<typeof vi.fn<(event: string, props: Record<string, unknown>) => void>>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  browseListMock = vi.fn<(args: BrowseListArgs) => Promise<BrowseListResult>>();
  trackMock = vi.fn<(event: string, props: Record<string, unknown>) => void>();
  // Stub window (renderer global) before the store imports anything. The store
  // uses window.setTimeout/clearTimeout for the debounce timer, so we proxy
  // those to vi's fake-timer-aware globalThis.setTimeout/clearTimeout.
  (globalThis as unknown as { window: unknown }).window = {
    sei: { browseList: browseListMock, track: trackMock },
    setTimeout: ((fn: () => void, ms: number) =>
      globalThis.setTimeout(fn, ms)) as typeof globalThis.setTimeout,
    clearTimeout: ((handle: number) =>
      globalThis.clearTimeout(handle)) as typeof globalThis.clearTimeout,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

// Helper — imports the store fresh after the window stub is in place + resets
// any leftover state so tests stay isolated.
async function loadStore() {
  const mod = await import('./useBrowseStore');
  mod.useBrowseStore.getState().reset();
  return mod.useBrowseStore;
}

// Flush all microtasks + advance timers to drive the debounced refresh through.
async function flush(ms = 250) {
  await vi.advanceTimersByTimeAsync(ms);
}

// --- Tests ----------------------------------------------------------------

describe('useBrowseStore', () => {
  it('Test 1: setQuery triggers refresh after 250ms (debounce)', async () => {
    browseListMock.mockResolvedValueOnce({ entries: [entry('a')], hasMore: false, sorted: true });
    const store = await loadStore();

    store.getState().setQuery('abc');
    // Before debounce window elapses, no IPC call yet.
    expect(browseListMock).not.toHaveBeenCalled();

    await flush(250);

    expect(browseListMock).toHaveBeenCalledTimes(1);
    expect(browseListMock).toHaveBeenCalledWith({ query: 'abc', limit: 24, offset: 0, sort: 'popular' });
    expect(store.getState().entries).toEqual([entry('a')]);
  });

  it('Test 2: rapid setQuery collapses to ONE refresh with the final query', async () => {
    browseListMock.mockResolvedValueOnce({ entries: [], hasMore: false, sorted: true });
    const store = await loadStore();

    store.getState().setQuery('a');
    await vi.advanceTimersByTimeAsync(50);
    store.getState().setQuery('ab');
    await vi.advanceTimersByTimeAsync(50);
    store.getState().setQuery('abc');
    // None should have fired yet — each keystroke restarts the timer.
    expect(browseListMock).not.toHaveBeenCalled();

    await flush(250);

    expect(browseListMock).toHaveBeenCalledTimes(1);
    expect(browseListMock).toHaveBeenCalledWith({ query: 'abc', limit: 24, offset: 0, sort: 'popular' });
  });

  it('Test 3: loadMore is a no-op while loading=true (Pitfall 8 in-flight guard)', async () => {
    // Make the first refresh hang so loading stays true during the second loadMore.
    let resolveFirst!: (v: BrowseListResult) => void;
    browseListMock.mockImplementationOnce(
      () => new Promise<BrowseListResult>((res) => { resolveFirst = res; })
    );
    const store = await loadStore();

    // Kick off a refresh that won't resolve until we say so.
    const inflight = store.getState().refresh();
    expect(store.getState().loading).toBe(true);

    // Second loadMore while loading=true must NOT call browseList again.
    await store.getState().loadMore();
    expect(browseListMock).toHaveBeenCalledTimes(1);

    resolveFirst({ entries: [], hasMore: false, sorted: true });
    await inflight;
  });

  it('Test 4: loadMore is a no-op when exhausted=true', async () => {
    browseListMock.mockResolvedValueOnce({ entries: [entry('a')], hasMore: false, sorted: true });
    const store = await loadStore();

    await store.getState().refresh();
    expect(store.getState().exhausted).toBe(true);

    browseListMock.mockClear();
    await store.getState().loadMore();
    expect(browseListMock).not.toHaveBeenCalled();
  });

  it('Test 5: loadMore APPENDS new entries to existing array (does not replace)', async () => {
    browseListMock
      .mockResolvedValueOnce({ entries: [entry('a'), entry('b')], hasMore: true, sorted: true })
      .mockResolvedValueOnce({ entries: [entry('c')], hasMore: false, sorted: true });
    const store = await loadStore();

    await store.getState().refresh();
    expect(store.getState().entries.map((e) => e.id)).toEqual(['a', 'b']);

    await store.getState().loadMore();
    expect(store.getState().entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    // Verify offset advanced for the second fetch.
    expect(browseListMock.mock.calls[1]?.[0]).toEqual({ query: '', limit: 24, offset: 2, sort: 'popular' });
  });

  it('Test 6: refresh resets entries to empty then fetches offset=0', async () => {
    browseListMock
      .mockResolvedValueOnce({ entries: [entry('a'), entry('b')], hasMore: true, sorted: true })
      .mockResolvedValueOnce({ entries: [entry('z')], hasMore: false, sorted: true });
    const store = await loadStore();

    await store.getState().refresh();
    expect(store.getState().entries.map((e) => e.id)).toEqual(['a', 'b']);

    await store.getState().refresh();
    // Second refresh should have started with empty entries and fetched offset=0.
    expect(store.getState().entries.map((e) => e.id)).toEqual(['z']);
    expect(browseListMock.mock.calls[1]?.[0]).toEqual({ query: '', limit: 24, offset: 0, sort: 'popular' });
  });

  it('Test 7: hasMore=false → store.exhausted becomes true', async () => {
    browseListMock.mockResolvedValueOnce({ entries: [entry('a')], hasMore: false, sorted: true });
    const store = await loadStore();

    await store.getState().refresh();
    expect(store.getState().exhausted).toBe(true);
  });

  it('Test 8: browseList rejection → store.error set, loading=false', async () => {
    browseListMock.mockRejectedValueOnce(new Error('boom'));
    const store = await loadStore();

    await store.getState().refresh();
    expect(store.getState().loading).toBe(false);
    expect(store.getState().error).toBe('boom');
  });

  it('Test 9: reset() clears all state back to defaults', async () => {
    browseListMock.mockResolvedValueOnce({ entries: [entry('a')], hasMore: false, sorted: true });
    const store = await loadStore();

    await store.getState().refresh();
    store.getState().setQuery('something');  // also schedules a pending debounce
    expect(store.getState().query).toBe('something');

    store.getState().reset();
    const s = store.getState();
    expect(s.entries).toEqual([]);
    expect(s.query).toBe('');
    expect(s.loading).toBe(false);
    expect(s.exhausted).toBe(false);
    expect(s.offset).toBe(0);
    expect(s.error).toBe(null);

    // The pending debounce that was queued by setQuery must be cancelled —
    // advancing the clock 250ms should NOT trigger any refresh.
    browseListMock.mockClear();
    await flush(500);
    expect(browseListMock).not.toHaveBeenCalled();
  });
  // ── 261110: Popular sort + auto-load ──────────────────────────────────────

  it('Test 10: sort defaults to popular and is sent with every page', async () => {
    browseListMock.mockResolvedValueOnce({ entries: [entry('a')], hasMore: false, sorted: true });
    const store = await loadStore();
    expect(store.getState().sort).toBe('popular');
    await store.getState().prefetch();
    expect(browseListMock).toHaveBeenCalledWith({ query: '', limit: 24, offset: 0, sort: 'popular' });
    expect(store.getState().serverSorted).toBe(true);
  });

  it('Test 11: setSort refetches from offset 0, tracks the choice, no-ops when unchanged', async () => {
    browseListMock
      .mockResolvedValueOnce({ entries: [entry('a'), entry('b')], hasMore: true, sorted: true })
      .mockResolvedValueOnce({ entries: [entry('z')], hasMore: false, sorted: true });
    const store = await loadStore();
    await store.getState().prefetch();

    store.getState().setSort('alpha');
    await flush(0);
    expect(browseListMock.mock.calls[1]?.[0]).toEqual({ query: '', limit: 24, offset: 0, sort: 'alpha' });
    expect(store.getState().entries.map((e) => e.id)).toEqual(['z']);
    expect(store.getState().sortChosen).toBe(true);
    expect(trackMock).toHaveBeenCalledWith('world_sort_selected', {
      sort: 'alpha',
      previous: 'popular',
      is_default: 0,
      searching: 0,
    });

    browseListMock.mockClear();
    store.getState().setSort('alpha');
    await flush(0);
    expect(browseListMock).not.toHaveBeenCalled();
  });

  it('Test 12: an answer superseded by a new sort is dropped', async () => {
    let resolveOld!: (v: BrowseListResult) => void;
    browseListMock
      .mockImplementationOnce(() => new Promise<BrowseListResult>((res) => { resolveOld = res; }))
      .mockResolvedValueOnce({ entries: [entry('new')], hasMore: false, sorted: true });
    const store = await loadStore();

    const oldFetch = store.getState().prefetch();
    store.getState().setSort('recent');
    await flush(0);
    expect(store.getState().entries.map((e) => e.id)).toEqual(['new']);

    resolveOld({ entries: [entry('old')], hasMore: true, sorted: true });
    await oldFetch;
    expect(store.getState().entries.map((e) => e.id)).toEqual(['new']);
    expect(store.getState().exhausted).toBe(true);
    expect(store.getState().loading).toBe(false);
  });

  it('Test 13: a failed next page keeps the list, pauses auto-load, and retries the same offset', async () => {
    browseListMock
      .mockResolvedValueOnce({ entries: [entry('a'), entry('b')], hasMore: true, sorted: true })
      .mockResolvedValueOnce({ entries: [], hasMore: false, sorted: false, failure: 'rpc_failed' })
      .mockResolvedValueOnce({ entries: [entry('c')], hasMore: false, sorted: true });
    const store = await loadStore();
    await store.getState().prefetch();

    await store.getState().loadMore();
    let s = store.getState();
    expect(s.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(s.loadMoreFailed).toBe(true);
    expect(s.exhausted).toBe(false);
    expect(trackMock).toHaveBeenLastCalledWith('world_page_loaded', expect.objectContaining({
      trigger: 'scroll',
      page_index: 1,
      batch_size: 24,
      outcome: 'error',
      failure_class: 'rpc_failed',
    }));

    // Auto-load can't spin on the failure.
    await store.getState().loadMore();
    expect(browseListMock).toHaveBeenCalledTimes(2);

    await store.getState().retryLoadMore();
    s = store.getState();
    expect(browseListMock.mock.calls[2]?.[0]).toEqual({ query: '', limit: 24, offset: 2, sort: 'popular' });
    expect(s.entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(s.loadMoreFailed).toBe(false);
    expect(s.exhausted).toBe(true);
  });

  it('Test 14: a rejected first page does not loop through loadMore', async () => {
    browseListMock.mockRejectedValueOnce(new Error('offline'));
    const store = await loadStore();
    await store.getState().prefetch();
    expect(store.getState().error).toBe('offline');
    await store.getState().loadMore();
    expect(browseListMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenLastCalledWith('world_page_loaded', expect.objectContaining({
      trigger: 'initial',
      page_index: 0,
      failure_class: 'ipc_failed',
    }));
  });

  it('Test 15: a fallback (unsorted) page marks the list unsorted; page analytics carry the shape', async () => {
    const counted = { ...entry('a'), addCount: 12 };
    browseListMock
      .mockResolvedValueOnce({ entries: [counted, entry('b')], hasMore: true, sorted: true })
      .mockResolvedValueOnce({ entries: [entry('c')], hasMore: false, sorted: false });
    const store = await loadStore();
    await store.getState().prefetch();
    expect(trackMock).toHaveBeenLastCalledWith('world_page_loaded', {
      trigger: 'initial',
      page_index: 0,
      batch_size: 24,
      returned: 2,
      has_more: 1,
      sort: 'popular',
      sort_source: 'default',
      server_sorted: 1,
      searching: 0,
      counts_known: 1,
      counts_shown: 1,
      counts_displayed: 0,
      thumbs_offered: 0,
      thumb_loads: 0,
      thumb_fallbacks: 0,
      outcome: 'ok',
      failure_class: 'none',
    });
    expect(store.getState().serverSorted).toBe(true);
    await store.getState().loadMore();
    expect(store.getState().serverSorted).toBe(false);
    expect(store.getState().pages).toBe(2);
  });

  it('Test 16: world_page_loaded carries thumbnail offers and the cards\' loads / fallbacks since the last page event', async () => {
    const { noteThumbLoaded, noteThumbFallback, takeThumbStats } = await import('../worldThumbStats');
    takeThumbStats();
    noteThumbLoaded();
    noteThumbLoaded();
    noteThumbFallback();
    browseListMock.mockResolvedValueOnce({
      entries: [{ ...entry('a'), thumbUrl: 'https://x/a.thumb.webp?v=1', portraitUrl: 'https://x/a.png?v=1' }, entry('b')],
      hasMore: false,
      sorted: true,
    });
    const store = await loadStore();
    await store.getState().prefetch();
    expect(trackMock).toHaveBeenLastCalledWith('world_page_loaded', expect.objectContaining({
      thumbs_offered: 1,
      thumb_loads: 2,
      thumb_fallbacks: 1,
    }));
    expect(takeThumbStats()).toEqual({ loads: 0, fallbacks: 0 });
  });
});
