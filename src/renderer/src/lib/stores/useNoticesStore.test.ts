/**
 * Tests for useNoticesStore — the notices inbox mirror.
 *
 * Invariants under test:
 *   1. init() subscribes and pulls; a snapshot with autoOpen opens the inbox on
 *      the newest unread and acks (so it opens exactly once).
 *   2. A snapshot WITHOUT autoOpen never opens the inbox by itself.
 *   3. An auto-open ignores a stale selection cursor from an earlier visit.
 *   4. select() marks read; re-selecting an already-read notice does not
 *      re-invoke the IPC.
 *   5. openInbox() opens on the newest unread and marks it read.
 *   6. A retracted notice's id is dropped from the selection cursor.
 *
 * Mock strategy mirrors useCreditsStore.test.ts: stub `window.sei` before the
 * store module is imported (ipcClient reads window.sei at module init), with
 * vi.resetModules() between tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Notice, NoticesSnapshot } from '@shared/ipc';

type Unsubscribe = () => void;

function notice(id: string, date: string): Notice {
  return { id, title: `Notice ${id}`, date, body: `body ${id}` };
}

function snap(
  notices: Notice[],
  readIds: string[] = [],
  autoOpen = false,
): NoticesSnapshot {
  return { notices, readIds, autoOpen };
}

let getNoticesMock: ReturnType<typeof vi.fn<() => Promise<NoticesSnapshot>>>;
let ackNoticesMock: ReturnType<typeof vi.fn<() => Promise<NoticesSnapshot>>>;
let markNoticeReadMock: ReturnType<typeof vi.fn<(id: string) => Promise<NoticesSnapshot>>>;
let onNoticesMock: ReturnType<typeof vi.fn<(cb: (s: NoticesSnapshot) => void) => Unsubscribe>>;
let noticesUnsub: ReturnType<typeof vi.fn<() => void>>;
/** Captured push handler so tests can fire snapshots at chosen moments. */
let pushHandler: ((s: NoticesSnapshot) => void) | null;

beforeEach(() => {
  vi.resetModules();
  getNoticesMock = vi.fn(async () => snap([]));
  ackNoticesMock = vi.fn(async () => snap([]));
  markNoticeReadMock = vi.fn(async () => snap([]));
  noticesUnsub = vi.fn();
  pushHandler = null;
  onNoticesMock = vi.fn((cb: (s: NoticesSnapshot) => void) => {
    pushHandler = cb;
    return noticesUnsub;
  });

  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      getNotices: getNoticesMock,
      ackNotices: ackNoticesMock,
      markNoticeRead: markNoticeReadMock,
      onNotices: onNoticesMock,
    },
  };
});

async function loadStore() {
  const mod = await import('./useNoticesStore');
  return mod.useNoticesStore;
}

/** Let the pull/ack/mark microtasks settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('useNoticesStore', () => {
  it('Test 1: an autoOpen snapshot opens on the newest unread and acks', async () => {
    const feed = [notice('b', '2026-07-25'), notice('a', '2026-07-01')];
    getNoticesMock.mockResolvedValue(snap(feed, [], true));
    ackNoticesMock.mockResolvedValue(snap(feed, []));
    markNoticeReadMock.mockResolvedValue(snap(feed, ['b']));
    const store = await loadStore();

    store.getState().init();
    await flush();

    expect(onNoticesMock).toHaveBeenCalledTimes(1);
    expect(store.getState().open).toBe(true);
    expect(store.getState().selectedId).toBe('b');
    expect(ackNoticesMock).toHaveBeenCalledTimes(1);
    expect(markNoticeReadMock).toHaveBeenCalledWith('b');
  });

  it('Test 2: a snapshot without autoOpen leaves the inbox closed', async () => {
    const feed = [notice('a', '2026-07-01')];
    getNoticesMock.mockResolvedValue(snap(feed, ['a'], false));
    const store = await loadStore();

    store.getState().init();
    await flush();

    expect(store.getState().open).toBe(false);
    expect(store.getState().notices).toHaveLength(1);
    expect(ackNoticesMock).not.toHaveBeenCalled();
  });

  it('Test 3: an auto-open overrides a stale selection cursor', async () => {
    const feed = [notice('b', '2026-07-25'), notice('a', '2026-07-01')];
    getNoticesMock.mockResolvedValue(snap([notice('a', '2026-07-01')], ['a'], false));
    ackNoticesMock.mockResolvedValue(snap(feed, ['a']));
    markNoticeReadMock.mockResolvedValue(snap(feed, ['a', 'b']));
    const store = await loadStore();

    store.getState().init();
    await flush();
    store.getState().openInbox();
    store.getState().close();
    expect(store.getState().selectedId).toBe('a');

    // A new notice lands.
    pushHandler?.(snap(feed, ['a'], true));
    await flush();

    expect(store.getState().open).toBe(true);
    expect(store.getState().selectedId).toBe('b');
  });

  it('Test 4: select() marks read once and skips an already-read notice', async () => {
    const feed = [notice('a', '2026-07-01')];
    getNoticesMock.mockResolvedValue(snap(feed, [], false));
    markNoticeReadMock.mockResolvedValue(snap(feed, ['a']));
    const store = await loadStore();

    store.getState().init();
    await flush();
    expect(store.getState().unreadCount()).toBe(1);

    store.getState().select('a');
    await flush();
    expect(store.getState().unreadCount()).toBe(0);

    store.getState().select('a');
    await flush();
    expect(markNoticeReadMock).toHaveBeenCalledTimes(1);
  });

  it('Test 5: openInbox() opens on the newest unread', async () => {
    const feed = [notice('b', '2026-07-25'), notice('a', '2026-07-01')];
    getNoticesMock.mockResolvedValue(snap(feed, ['b'], false));
    markNoticeReadMock.mockResolvedValue(snap(feed, ['b', 'a']));
    const store = await loadStore();

    store.getState().init();
    await flush();
    store.getState().openInbox();

    expect(store.getState().open).toBe(true);
    expect(store.getState().selectedId).toBe('a');
  });

  it('Test 6: a retracted notice is dropped from the selection cursor', async () => {
    const feed = [notice('a', '2026-07-01')];
    getNoticesMock.mockResolvedValue(snap(feed, ['a'], false));
    const store = await loadStore();

    store.getState().init();
    await flush();
    store.getState().openInbox();
    expect(store.getState().selectedId).toBe('a');

    pushHandler?.(snap([], [], false));
    await flush();

    expect(store.getState().selectedId).toBeNull();
    expect(store.getState().notices).toEqual([]);
  });

  it('Test 7: init() returns the push unsubscribe', async () => {
    const store = await loadStore();
    const unsub = store.getState().init();
    await flush();
    unsub();
    expect(noticesUnsub).toHaveBeenCalledTimes(1);
  });
});
