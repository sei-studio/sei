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
import type { BrowseEntry } from '@shared/ipc';

// --- Test fixtures --------------------------------------------------------

function entry(id: string, name = `char-${id}`): BrowseEntry {
  return {
    id,
    name,
    personaSnippet: `${name} persona`,
    creatorLabel: 'by anonymous',
    portraitUrl: null,
    skinUrl: null,
    updatedAt: new Date(0).toISOString(),
    inMyLibrary: false,
  };
}

type BrowseListArgs = { query: string; limit: number; offset: number };
type BrowseListResult = { entries: BrowseEntry[]; hasMore: boolean };

let browseListMock: ReturnType<typeof vi.fn<(args: BrowseListArgs) => Promise<BrowseListResult>>>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  browseListMock = vi.fn<(args: BrowseListArgs) => Promise<BrowseListResult>>();
  // Stub window (renderer global) before the store imports anything. The store
  // uses window.setTimeout/clearTimeout for the debounce timer, so we proxy
  // those to vi's fake-timer-aware globalThis.setTimeout/clearTimeout.
  (globalThis as unknown as { window: unknown }).window = {
    sei: { browseList: browseListMock },
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
    browseListMock.mockResolvedValueOnce({ entries: [entry('a')], hasMore: false });
    const store = await loadStore();

    store.getState().setQuery('abc');
    // Before debounce window elapses, no IPC call yet.
    expect(browseListMock).not.toHaveBeenCalled();

    await flush(250);

    expect(browseListMock).toHaveBeenCalledTimes(1);
    expect(browseListMock).toHaveBeenCalledWith({ query: 'abc', limit: 24, offset: 0 });
    expect(store.getState().entries).toEqual([entry('a')]);
  });

  it('Test 2: rapid setQuery collapses to ONE refresh with the final query', async () => {
    browseListMock.mockResolvedValueOnce({ entries: [], hasMore: false });
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
    expect(browseListMock).toHaveBeenCalledWith({ query: 'abc', limit: 24, offset: 0 });
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

    resolveFirst({ entries: [], hasMore: false });
    await inflight;
  });

  it('Test 4: loadMore is a no-op when exhausted=true', async () => {
    browseListMock.mockResolvedValueOnce({ entries: [entry('a')], hasMore: false });
    const store = await loadStore();

    await store.getState().refresh();
    expect(store.getState().exhausted).toBe(true);

    browseListMock.mockClear();
    await store.getState().loadMore();
    expect(browseListMock).not.toHaveBeenCalled();
  });

  it('Test 5: loadMore APPENDS new entries to existing array (does not replace)', async () => {
    browseListMock
      .mockResolvedValueOnce({ entries: [entry('a'), entry('b')], hasMore: true })
      .mockResolvedValueOnce({ entries: [entry('c')], hasMore: false });
    const store = await loadStore();

    await store.getState().refresh();
    expect(store.getState().entries.map((e) => e.id)).toEqual(['a', 'b']);

    await store.getState().loadMore();
    expect(store.getState().entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    // Verify offset advanced for the second fetch.
    expect(browseListMock.mock.calls[1]?.[0]).toEqual({ query: '', limit: 24, offset: 2 });
  });

  it('Test 6: refresh resets entries to empty then fetches offset=0', async () => {
    browseListMock
      .mockResolvedValueOnce({ entries: [entry('a'), entry('b')], hasMore: true })
      .mockResolvedValueOnce({ entries: [entry('z')], hasMore: false });
    const store = await loadStore();

    await store.getState().refresh();
    expect(store.getState().entries.map((e) => e.id)).toEqual(['a', 'b']);

    await store.getState().refresh();
    // Second refresh should have started with empty entries and fetched offset=0.
    expect(store.getState().entries.map((e) => e.id)).toEqual(['z']);
    expect(browseListMock.mock.calls[1]?.[0]).toEqual({ query: '', limit: 24, offset: 0 });
  });

  it('Test 7: hasMore=false → store.exhausted becomes true', async () => {
    browseListMock.mockResolvedValueOnce({ entries: [entry('a')], hasMore: false });
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
    browseListMock.mockResolvedValueOnce({ entries: [entry('a')], hasMore: false });
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
});
