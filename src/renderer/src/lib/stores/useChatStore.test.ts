/**
 * Tests for useChatStore.load() — the per-character `loading` flag lifecycle
 * that drives the ChatScreen wireframe skeleton.
 *
 * Invariants under test:
 *   1. load() flips `loading` true SYNCHRONOUSLY (before the history fetch
 *      resolves) so the skeleton shows on the first paint.
 *   2. `loading` clears the moment history lands — BEFORE the first-meeting
 *      greeting turn (that phase is covered by `awaiting`, not the skeleton).
 *   3. A greeting turn on an empty transcript flips `awaiting` (not `loading`).
 *   4. A failed fetch clears `loading` AND resets `loaded` so a later open retries.
 *   5. A re-entrant load() while already loaded is a no-op (no skeleton flash).
 *
 * Mock strategy mirrors useBrowseStore.test.ts: stub `window.sei` on globalThis
 * before importing the store, and import fresh per test for isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '@shared/ipc';

/** A deferred promise so a test can assert state WHILE the fetch is in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function msg(id: string): ChatMessage {
  return { id, role: 'companion', text: `line-${id}`, ts: 0 };
}

let chatHistoryMock: ReturnType<typeof vi.fn>;
let chatOpenedMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  chatHistoryMock = vi.fn();
  chatOpenedMock = vi.fn();
  // onChatMessage is subscribed at store-module load; give it a no-op so the
  // module init doesn't throw. chatOpened is optional per test.
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      onChatMessage: () => {},
      chatHistory: chatHistoryMock,
      chatOpened: chatOpenedMock,
    },
  };
});

async function loadStore() {
  const mod = await import('./useChatStore');
  return mod.useChatStore;
}

/** Flush pending microtasks (promise callbacks). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('useChatStore.load — loading flag lifecycle', () => {
  it('flips loading true synchronously, then false once history lands', async () => {
    const d = deferred<ChatMessage[]>();
    chatHistoryMock.mockReturnValue(d.promise);
    const store = await loadStore();

    // Kick load WITHOUT awaiting — the synchronous prologue must set loading.
    void store.getState().load('c1');
    expect(store.getState().loading['c1']).toBe(true);
    expect(store.getState().loaded['c1']).toBe(true);

    d.resolve([msg('a'), msg('b')]);
    await flush();

    expect(store.getState().loading['c1']).toBe(false);
    expect(store.getState().messages['c1']).toHaveLength(2);
  });

  it('clears loading before the greeting turn — greeting drives awaiting', async () => {
    chatHistoryMock.mockResolvedValue([]); // empty transcript → greeting path
    const g = deferred<ChatMessage[]>();
    chatOpenedMock.mockReturnValue(g.promise);
    const store = await loadStore();

    void store.getState().load('c2');
    await flush();

    // History applied: skeleton is done, but the greeting is still in flight so
    // the typing indicator (awaiting), not the skeleton (loading), covers it.
    expect(store.getState().loading['c2']).toBe(false);
    expect(store.getState().awaiting['c2']).toBe(true);

    g.resolve([msg('hi')]);
    await flush();
    expect(store.getState().awaiting['c2']).toBe(false);
  });

  it('resets loading AND loaded on a failed fetch so a later open retries', async () => {
    chatHistoryMock.mockRejectedValueOnce(new Error('boom'));
    const store = await loadStore();

    await store.getState().load('c3');
    expect(store.getState().loading['c3']).toBe(false);
    expect(store.getState().loaded['c3']).toBe(false);
  });

  it('is a no-op when already loaded (no skeleton flash on re-open)', async () => {
    chatHistoryMock.mockResolvedValue([msg('a')]);
    const store = await loadStore();

    await store.getState().load('c4');
    expect(store.getState().loaded['c4']).toBe(true);
    chatHistoryMock.mockClear();

    void store.getState().load('c4');
    expect(store.getState().loading['c4']).toBe(false);
    expect(chatHistoryMock).not.toHaveBeenCalled();
  });
});
