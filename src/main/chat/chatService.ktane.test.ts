/**
 * 261115: KTANE expert mode on the real chat turn.
 *
 * Pins: while a session is on, the manual rides the cached system prompt,
 * bomb_notes() rides last on every turn kind (one list, for the cache
 * prefix), the companion's notes ride the uncached tail, the player's turn
 * thinks (adaptive) with room for it, a line plus notes ends the turn in one
 * call, notes without a line get one more hop, and idle chatter is skipped.
 * Mocks copied from chatService.together.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';
import { drainScopedWrites } from '../profile/scopeBarrier';

const { createSpy, streamSpy, getCharacterSpy, patchCharacterSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  streamSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  patchCharacterSpy: vi.fn(),
}));
vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  capture: vi.fn(),
}));
vi.mock('./sdk', () => ({
  CHAT_TIMEOUT_MS: 30_000,
  buildChatSdk: vi.fn(async () => ({
    client: { messages: { create: createSpy, stream: streamSpy } },
    model: 'test-model',
  })),
}));
vi.mock('../characterStore', () => ({
  getCharacter: getCharacterSpy,
  patchCharacter: patchCharacterSpy,
}));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Player' })),
}));
vi.mock('../llm/webSearchSettings', () => ({
  resolveWebSearchSettings: () => ({ provider: 'auto', api_key: '' }),
  getChatWebSession: () => ({ lastProvider: 'fake', beginTurn() {}, async runTool() { return { content: 'nothing', is_error: false }; } }),
}));

import type { ChatDeps } from './chatService';
import { sendChatMessage, sendVoiceGreetingTurn, sendVoiceIdleTurn } from './chatService';
import { setCallActive } from '../voice/callState';
import { __resetKtaneForTests, endKtaneSession, getKtaneState, initKtaneService, startKtaneSession } from '../ktane/ktaneService';

const CHAR = '77777777-7777-4777-8777-777777777777';
let dir: string;

type Req = {
  system: Array<{ type: string; text: string }>;
  tools?: Array<{ name: string }>;
  messages: Array<{ role: string; content: unknown }>;
  max_tokens: number;
  thinking?: unknown;
};
const req = (i: number): Req => createSpy.mock.calls[i][0] as Req;
const toolNames = (r: Req): string[] => (r.tools ?? []).map((t) => t.name);
const systemText = (r: Req): string => r.system.map((b) => b.text).join('\n');
const lastUserText = (r: Req): string => JSON.stringify(r.messages[r.messages.length - 1].content);

const deps = (over: Partial<ChatDeps> = {}): ChatDeps => ({
  getLanState: () => ({ kind: 'closed' }),
  summon: vi.fn(async () => undefined),
  leaveGame: vi.fn(),
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-ktane-'));
  _setUserDataOverride(dir);
  const character = { id: CHAR, name: 'Sui', persona: { source: 'gremlin', expanded: 'PERSONA' }, metadata: {} };
  getCharacterSpy.mockImplementation(async () => structuredClone(character));
  patchCharacterSpy.mockImplementation(async (_id: string, fn: (c: typeof character) => typeof character) => fn(structuredClone(character)));
  createSpy.mockReset();
  streamSpy.mockReset();
  __resetKtaneForTests();
  initKtaneService({ pushState: () => {}, pushChatMessage: () => {} });
});
afterEach(async () => {
  await endKtaneSession(CHAR, 'user_end');
  await drainScopedWrites();
  __resetKtaneForTests();
  setCallActive(CHAR, false);
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

describe('KTANE expert mode on her turns', () => {
  it('nothing changes without a session', async () => {
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());
    expect(toolNames(req(0))).not.toContain('bomb_notes');
    expect(systemText(req(0))).not.toContain('BOMB DEFUSAL');
    expect(lastUserText(req(0))).not.toContain('your bomb notes');
    expect(req(0).thinking).toBeUndefined();
  });

  it('a session adds the manual, the notes and thinking; the tool rides last on every turn kind', async () => {
    await startKtaneSession(CHAR, 'panel', { onCall: true });
    setCallActive(CHAR, true);
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'what is the serial number?' }] });

    await sendChatMessage({ characterId: CHAR, text: 'ok i have a bomb', voiceCall: true }, deps());
    const r = req(0);
    expect(systemText(r)).toContain('# BOMB DEFUSAL SESSION');
    expect(systemText(r)).toContain('# BOMB DEFUSAL MANUAL');
    expect(toolNames(r).at(-1)).toBe('bomb_notes');
    expect(lastUserText(r)).toContain('[your bomb notes, bomb 1]');
    expect(r.thinking).toEqual({ type: 'adaptive' });
    expect(r.max_tokens).toBe(3000);

    await sendVoiceGreetingTurn(CHAR, []);
    const lists = createSpy.mock.calls.map((c) => JSON.stringify((c[0] as Req).tools));
    expect(lists).toHaveLength(2);
    expect(new Set(lists).size).toBe(1);
  });

  it('idle chatter is skipped while a bomb is on', async () => {
    await startKtaneSession(CHAR, 'panel', { onCall: true });
    setCallActive(CHAR, true);
    const res = await sendVoiceIdleTurn(CHAR, 30, []);
    expect(res.messages).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('a line plus notes ends the turn in one call and fills her notes', async () => {
    await startKtaneSession(CHAR, 'panel');
    createSpy.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'Serial AL5QF2, last digit even.', signature: 'sig' },
        { type: 'text', text: 'got it. which module first?' },
        { type: 'tool_use', id: 'tu_n', name: 'bomb_notes', input: { serial: 'AL5QF2', batteries: 2 } },
      ],
    });
    const result = await sendChatMessage({ characterId: CHAR, text: 'serial is AL5QF2, two batteries' }, deps());
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.replies.map((m) => m.text).join(' ')).toContain('which module first');
    expect(getKtaneState(CHAR)?.sheet).toMatchObject({ serial: 'AL5QF2', batteries: 2 });
  });

  it('notes with no line get one more hop for the line', async () => {
    await startKtaneSession(CHAR, 'panel');
    createSpy.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_n', name: 'bomb_notes', input: { module: 'wires', memo: '4 wires' } }],
    });
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'cut the second wire' }] });
    const result = await sendChatMessage({ characterId: CHAR, text: 'four wires: red red blue yellow' }, deps());
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(req(1).messages)).toContain('Noted. Now say your line');
    expect(result.replies.map((m) => m.text).join(' ')).toContain('cut the second wire');
    expect(getKtaneState(CHAR)?.sheet).toMatchObject({ module: 'wires', memo: '4 wires' });
  });
});
