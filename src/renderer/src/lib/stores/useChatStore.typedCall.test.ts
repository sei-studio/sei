/**
 * 261124 (in-app feedback, Backseat): "the chat doesn't show messages typed
 * by me". Every row sent on a call was flagged `voice` and hidden, including
 * a line the player TYPED in the composer, so it vanished on send. And while
 * the companion was watching the screen (Backseat) the typed line went to a
 * chat turn that could not see it.
 *
 * Under test:
 *   1. A typed line on a call keeps `voice` but gains `typed`, stays visible,
 *      and chatSend carries `typed` so main stamps the rows the same way.
 *   2. A director (spoken) send on a call stays hidden, as before.
 *   3. Typed to the companion watching the screen, the line goes to the
 *      Backseat loop under the bubble's own id, not to chatSend.
 *   4. A typed line the capture could not send falls back to chatSend.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatRowHidden, type ChatMessage } from '@shared/ipc';

let chatSendMock: ReturnType<typeof vi.fn>;
let sendUserTickMock: ReturnType<typeof vi.fn>;
let sharingFor: string | null;

beforeEach(() => {
  vi.resetModules();
  chatSendMock = vi.fn(async () => ({ replies: [], streamed: true }));
  sendUserTickMock = vi.fn(async () => true);
  sharingFor = null;
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      onChatMessage: () => () => {},
      chatSend: chatSendMock,
      // send() refreshes the character after a reply (Home presence).
      getCharacter: async () => null,
    },
  };
  vi.doMock('./useBackseatStore', () => ({
    useBackseatStore: { getState: () => ({ sharingFor }) },
    backseatCapture: () => ({ sendUserTick: sendUserTickMock }),
  }));
});

async function loadOnCall() {
  const bridge = await import('../voice/voiceBridge');
  bridge.registerVoiceHooks({
    onCompanionText: () => {},
    isCallActive: (id) => id === 'c1',
    onRemoteEndCall: () => {},
    onTurnFailed: () => false,
    onPlayerText: () => {},
    voicePeersFor: () => [],
  });
  const { useChatStore } = await import('./useChatStore');
  return useChatStore;
}

const visible = (list: ChatMessage[] | undefined): ChatMessage[] => (list ?? []).filter((m) => !chatRowHidden(m));

describe('useChatStore.send: lines typed on a call (261124)', () => {
  it('a typed line on a call stays visible and tells main it was typed', async () => {
    const store = await loadOnCall();
    await store.getState().send('c1', 'what boss is that', undefined, undefined, { typed: true });
    const list = store.getState().messages.c1;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ role: 'user', text: 'what boss is that', voice: true, typed: true });
    expect(visible(list)).toHaveLength(1);
    expect(chatSendMock).toHaveBeenCalledWith(expect.objectContaining({ text: 'what boss is that', typed: true }));
  });

  it('a spoken (director) line on a call is still hidden', async () => {
    const store = await loadOnCall();
    await store.getState().send('c1', 'hello', undefined, []);
    const list = store.getState().messages.c1;
    expect(list[0]).toMatchObject({ voice: true });
    expect(list[0].typed).toBeUndefined();
    expect(visible(list)).toHaveLength(0);
    expect(chatSendMock.mock.calls[0][0].typed).toBeUndefined();
  });

  it('typed to the companion watching the screen, the line goes to Backseat under its own id', async () => {
    sharingFor = 'c1';
    const store = await loadOnCall();
    const res = await store.getState().send('c1', 'is that the warden', undefined, undefined, { typed: true });
    expect(res).toMatchObject({ routed: true });
    expect(chatSendMock).not.toHaveBeenCalled();
    const list = store.getState().messages.c1;
    expect(visible(list)).toHaveLength(1);
    expect(sendUserTickMock).toHaveBeenCalledWith('is that the warden', undefined, list[0].id);
    // A real UUID: main's zod schema accepts only that as BackseatTick.lineId.
    expect(list[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('a typed line the capture could not send falls back to the chat turn', async () => {
    sharingFor = 'c1';
    sendUserTickMock.mockResolvedValue(false);
    const store = await loadOnCall();
    await store.getState().send('c1', 'you there?', undefined, undefined, { typed: true });
    expect(sendUserTickMock).toHaveBeenCalledTimes(1);
    expect(chatSendMock).toHaveBeenCalledWith(expect.objectContaining({ text: 'you there?', typed: true }));
    expect(visible(store.getState().messages.c1)).toHaveLength(1);
  });

  it('a quoted reply keeps the chat path even while sharing (a tick carries no quote)', async () => {
    sharingFor = 'c1';
    const store = await loadOnCall();
    await store.getState().send('c1', 'this one', { role: 'companion', text: 'look left' }, undefined, { typed: true });
    expect(sendUserTickMock).not.toHaveBeenCalled();
    expect(chatSendMock).toHaveBeenCalledTimes(1);
  });

  it('chatRowHidden: spoken call rows and desktop lines hide, typed call rows and plain chat show', () => {
    const base = { id: 'x', role: 'user' as const, text: 't', ts: 0 };
    expect(chatRowHidden(base)).toBe(false);
    expect(chatRowHidden({ ...base, voice: true })).toBe(true);
    expect(chatRowHidden({ ...base, voice: true, typed: true })).toBe(false);
    expect(chatRowHidden({ ...base, desktop: true })).toBe(true);
    expect(chatRowHidden({ ...base, desktop: true, typed: true })).toBe(true);
  });
});
