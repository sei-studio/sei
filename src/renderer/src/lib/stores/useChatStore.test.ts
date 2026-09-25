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
/** The chat:message push handler the store registers at module load. */
let pushHandler: (e: { characterId: string; message: ChatMessage }) => void;

beforeEach(() => {
  vi.resetModules();
  chatHistoryMock = vi.fn();
  chatOpenedMock = vi.fn();
  // onChatMessage is subscribed at store-module load; give it a no-op so the
  // module init doesn't throw. chatOpened is optional per test.
  pushHandler = () => {};
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      onChatMessage: (fn: typeof pushHandler) => {
        pushHandler = fn;
        return () => {};
      },
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
    // 260706: greetings now reveal bubble-by-bubble with the same typing delays
    // send() uses. Turn realistic typing OFF so a single-bubble greeting reveals
    // instantly and this test asserts the awaiting lifecycle, not typing theater.
    const { useUiStore } = await import('./useUiStore');
    useUiStore.setState({ realisticTyping: false });

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

/**
 * Paced arrival for chat:message pushes (260724).
 *
 * Every surface that speaks over this push — the chess service, the in-game bot
 * — emits its bubbles in a tight loop with no delay. Before this, the push
 * handler appended each one the instant it arrived, so a multi-line reply
 * rendered as a single wall of text no matter what "Realistic typing" said:
 * the typing theater only ever ran inside send()'s own reveal loop, which this
 * path never touches.
 */
describe('useChatStore — paced arrival for pushed bubbles', () => {
  function companion(id: string, text: string): ChatMessage {
    return { id, role: 'companion', text, ts: 0 };
  }

  it('reveals a burst one bubble at a time, holding the typing indicator between them', async () => {
    vi.useFakeTimers();
    try {
      const store = await loadStore();
      // Three lines pushed in ONE tick, exactly as chessService.speak() emits them.
      // Short lines so each wait is the typingDelayMs FLOOR (500ms) exactly.
      pushHandler({ characterId: 'c1', message: companion('a', 'yo') });
      pushHandler({ characterId: 'c1', message: companion('b', 'hm') });
      pushHandler({ characterId: 'c1', message: companion('c', 'gg') });

      // Nothing has landed yet: bubble 1 is still "being typed".
      expect(store.getState().messages['c1'] ?? []).toHaveLength(0);
      expect(store.getState().awaiting['c1']).toBe(true);

      await vi.advanceTimersByTimeAsync(600);
      expect(store.getState().messages['c1']).toHaveLength(1);
      expect(store.getState().awaiting['c1']).toBe(true); // two still queued

      await vi.advanceTimersByTimeAsync(600);
      expect(store.getState().messages['c1']).toHaveLength(2);
      expect(store.getState().awaiting['c1']).toBe(true);

      await vi.advanceTimersByTimeAsync(600);
      expect(store.getState().messages['c1'].map((m) => m.id)).toEqual(['a', 'b', 'c']);
      // Burst drained: the indicator drops, which is also what releases the
      // chess reveal gate (useAiMoveReveal polls `awaiting`).
      expect(store.getState().awaiting['c1']).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scales the wait to the length of each line (the simulated typing speed)', async () => {
    vi.useFakeTimers();
    try {
      const store = await loadStore();
      // ~120 chars at TYPING_CPS 16.67 ≈ 7.2s, clamped to the 5s ceiling.
      pushHandler({ characterId: 'c1', message: companion('long', 'x'.repeat(120)) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.getState().messages['c1'] ?? []).toHaveLength(0); // still typing
      await vi.advanceTimersByTimeAsync(4200);
      expect(store.getState().messages['c1']).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lands system rows immediately: they are UI facts, not someone typing', async () => {
    vi.useFakeTimers();
    try {
      const store = await loadStore();
      pushHandler({
        characterId: 'c1',
        message: { id: 'sys', role: 'system', text: 'Marv joined your world.', ts: 0 },
      });
      expect(store.getState().messages['c1']).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('paces each character independently', async () => {
    vi.useFakeTimers();
    try {
      const store = await loadStore();
      pushHandler({ characterId: 'c1', message: companion('a', 'hi') });
      pushHandler({ characterId: 'c2', message: companion('b', 'hi') });
      await vi.advanceTimersByTimeAsync(600);
      expect(store.getState().messages['c1']).toHaveLength(1);
      expect(store.getState().messages['c2']).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useChatStore.send: model timeout vs user cancel (260926)', () => {
  // What a rejected ipcRenderer.invoke carries across the bridge.
  const ipcError = (inner: string): Error => new Error(`Error invoking remote method 'chat:send': ${inner}`);

  async function sendRejecting(err: Error) {
    const w = globalThis as unknown as { window: { sei: Record<string, unknown> } };
    w.window.sei.chatSend = vi.fn(async () => {
      throw err;
    });
    const store = await loadStore();
    const { useUiStore } = await import('./useUiStore');
    useUiStore.setState({ realisticTyping: false });
    await store.getState().send('c1', 'hello?');
    return store.getState();
  }

  it('a model timeout shows a short failure line and clears the typing indicator', async () => {
    const s = await sendRejecting(
      ipcError('LlmTimeoutError: LLM_TIMEOUT: the ollama model did not answer within 120s.'),
    );
    const list = s.messages.c1;
    expect(list.map((m) => m.role)).toEqual(['user', 'companion']);
    expect(list[1].text).toMatch(/took too long/);
    expect(s.awaiting.c1).toBe(false);
  });

  it('a user cancel stays silent: no failure line', async () => {
    const s = await sendRejecting(ipcError('Error: CHAT_ABORTED'));
    expect(s.messages.c1.map((m) => m.role)).toEqual(['user']);
    expect(s.awaiting.c1).toBe(false);
  });

  it('chatFailureLine keeps its other cases apart', async () => {
    const { chatFailureLine, isLlmTimeout } = await import('./useChatStore');
    expect(isLlmTimeout(ipcError('LlmTimeoutError: LLM_TIMEOUT: x'))).toBe(true);
    expect(isLlmTimeout(ipcError('Error: CHAT_ABORTED'))).toBe(false);
    expect(chatFailureLine(ipcError('Error: LOCAL_NO_API_KEY'))).toMatch(/no API key/);
    expect(chatFailureLine(ipcError('Error: 500 upstream'))).toMatch(/couldn't reply/);
  });
});

/**
 * Account scope change (260926): the bundled defaults share their UUIDs across
 * profiles, so a transcript cached for account A must never show for account B.
 */
describe('useChatStore.resetForScope: no transcript crosses accounts', () => {
  it("drops every cached transcript, preview and flag, so the next open re-reads the new account's disk", async () => {
    chatHistoryMock.mockResolvedValue([msg('a-private')]);
    const store = await loadStore();
    await store.getState().load('sui');
    store.setState({ previews: { sui: { text: 'a-private', role: 'companion', ts: 0 } as never } });
    expect(store.getState().messages.sui).toHaveLength(1);

    store.getState().resetForScope();
    const s = store.getState();
    expect(s.messages).toEqual({});
    expect(s.previews).toEqual({});
    expect(s.loaded).toEqual({});
    expect(s.awaiting).toEqual({});

    chatHistoryMock.mockResolvedValue([msg('b-own')]);
    await store.getState().load('sui');
    expect(store.getState().messages.sui.map((m) => m.id)).toEqual(['b-own']);
  });

  it("a history fetch still in flight for the old account never lands in the new one", async () => {
    const d = deferred<ChatMessage[]>();
    chatHistoryMock.mockReturnValueOnce(d.promise);
    const store = await loadStore();
    const pending = store.getState().load('sui');
    store.getState().resetForScope();
    d.resolve([msg('a-private')]);
    await pending;
    expect(store.getState().messages.sui).toBeUndefined();
    expect(store.getState().loaded.sui).toBeUndefined();
  });

  it('a reply in flight for the old account is dropped', async () => {
    const d = deferred<{ replies: ChatMessage[] }>();
    const w = globalThis as unknown as { window: { sei: Record<string, unknown> } };
    w.window.sei.chatSend = vi.fn(() => d.promise);
    w.window.sei.getCharacter = vi.fn(async () => null);
    const store = await loadStore();
    const { useUiStore } = await import('./useUiStore');
    useUiStore.setState({ realisticTyping: false });
    const sending = store.getState().send('sui', 'a secret');
    store.getState().resetForScope();
    d.resolve({ replies: [msg('a-reply')] });
    await sending;
    expect(store.getState().messages.sui).toBeUndefined();
  });

  it('a pushed line queued for the old account is not revealed after the reset', async () => {
    vi.useFakeTimers();
    try {
      const store = await loadStore();
      const { useUiStore } = await import('./useUiStore');
      useUiStore.setState({ realisticTyping: true });
      pushHandler({ characterId: 'sui', message: msg('a-pushed') });
      store.getState().resetForScope();
      await vi.advanceTimersByTimeAsync(6000);
      expect(store.getState().messages.sui).toBeUndefined();
      expect(store.getState().awaiting.sui).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The guided first moment (260926) rides load()'s greeting path: the armed
 * companion's empty-transcript open passes chatOpened options that steer the
 * greeting, and every way the greeting can fail leaves the plain chat screen.
 */
describe('useChatStore.load: guided first moment', () => {
  async function setup() {
    const w = (globalThis as unknown as { window: { sei: Record<string, unknown> } }).window;
    w.sei.detectMcInstalls = vi.fn().mockResolvedValue({ installs: [] });
    w.sei.track = vi.fn();
    const store = await loadStore();
    const { useUiStore } = await import('./useUiStore');
    useUiStore.setState({ realisticTyping: false });
    const { useFirstMomentStore } = await import('./useFirstMomentStore');
    return { store, fm: useFirstMomentStore };
  }

  it('an unarmed open calls chatOpened exactly as before (no options)', async () => {
    chatHistoryMock.mockResolvedValue([]);
    chatOpenedMock.mockResolvedValue([msg('hi')]);
    const { store, fm } = await setup();
    await store.getState().load('c1');
    expect(chatOpenedMock).toHaveBeenCalledWith('c1');
    expect(chatOpenedMock.mock.calls[0]).toHaveLength(1);
    expect(fm.getState().status).toBeNull();
  });

  it('the armed companion greets with the first-moment options, then the card is ready', async () => {
    chatHistoryMock.mockResolvedValue([]);
    chatOpenedMock.mockResolvedValue([msg('hi'), msg('chess?')]);
    const { store, fm } = await setup();
    fm.getState().arm('c1');
    await store.getState().load('c1');
    expect(chatOpenedMock).toHaveBeenCalledWith('c1', { firstMoment: { primary: 'chess' } });
    expect(store.getState().messages['c1']).toHaveLength(2);
    expect(fm.getState().status).toBe('ready');
  });

  it('another companion opened first is left alone and the arm survives', async () => {
    chatHistoryMock.mockResolvedValue([]);
    chatOpenedMock.mockResolvedValue([msg('hi')]);
    const { store, fm } = await setup();
    fm.getState().arm('c1');
    await store.getState().load('other');
    expect(chatOpenedMock).toHaveBeenCalledWith('other');
    expect(fm.getState().status).toBe('armed');
  });

  it('a greeting call that throws falls back silently to the plain chat', async () => {
    chatHistoryMock.mockResolvedValue([]);
    chatOpenedMock.mockRejectedValue(new Error('llm down'));
    const { store, fm } = await setup();
    fm.getState().arm('c1');
    await store.getState().load('c1');
    expect(fm.getState().status).toBe('failed');
    expect(store.getState().awaiting['c1']).toBe(false);
    expect(store.getState().messages['c1'] ?? []).toHaveLength(0);
  });

  it('an empty greeting (main found the companion ineligible) falls back', async () => {
    chatHistoryMock.mockResolvedValue([]);
    chatOpenedMock.mockResolvedValue([]);
    const { store, fm } = await setup();
    fm.getState().arm('c1');
    await store.getState().load('c1');
    expect(fm.getState().status).toBe('failed');
  });

  it('a planning failure still greets the plain way and settles the moment', async () => {
    chatHistoryMock.mockResolvedValue([]);
    chatOpenedMock.mockResolvedValue([msg('hi')]);
    const { store, fm } = await setup();
    fm.getState().arm('c1');
    const realOptions = fm.getState().greetingOptions;
    fm.setState({
      greetingOptions: async (id: string) => {
        await realOptions(id); // moves the status to 'greeting'
        throw new Error('plan failed');
      },
    });
    await store.getState().load('c1');
    expect(chatOpenedMock).toHaveBeenCalledWith('c1');
    expect(chatOpenedMock.mock.calls[0]).toHaveLength(1);
    expect(store.getState().messages['c1']).toHaveLength(1);
    expect(fm.getState().status).toBe('failed');
  });

  it('an existing transcript means no greeting and no card', async () => {
    chatHistoryMock.mockResolvedValue([msg('old')]);
    const { store, fm } = await setup();
    fm.getState().arm('c1');
    await store.getState().load('c1');
    expect(chatOpenedMock).not.toHaveBeenCalled();
    expect(fm.getState().status).toBe('failed');
  });
});
