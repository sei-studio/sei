/**
 * 261104 SeiLink: the room line and look() on the chat surfaces.
 *
 * Pins where the line goes per surface (typed chat: place + time in the
 * status block; a call: place only, the time stays in the uncached clock
 * stamp), that games and companions without a room get neither the line nor
 * the tool, and that look() answers with the list plus a picture beside the
 * tool_result, on the typed hop loop and on the single-shot voice turns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';

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
import type { ChatMessage } from '../../shared/ipc';
import { DESKTOP_LINE_NOTES, readRecent, sendChatMessage, sendDesktopLineTurn, sendVoiceIdleTurn, sendVoiceGreetingTurn } from './chatService';
import { setCallActive } from '../voice/callState';
import { devRoomSource, setGameSurfaceProbe, setRoomSource, type RoomContext, type RoomSource } from '../seilink/roomContext';

const CHAR = '66666666-6666-4666-8666-666666666666';
const FIXTURE = path.join(__dirname, '..', 'seilink', '__fixtures__', 'room-pack', 'room.json');
let dir: string;

type Req = {
  system: Array<{ type: string; text: string }>;
  tools?: Array<{ name: string }>;
  messages: Array<{ role: string; content: unknown }>;
};
const req = (i: number): Req => createSpy.mock.calls[i][0] as Req;
const statusBlock = (r: Req): string => r.system[r.system.length - 1].text;
const toolNames = (r: Req): string[] => (r.tools ?? []).map((t) => t.name);
const TIME_WORDS = /It's (daytime|night|dusk|dawn)\./;

/** The fixture room with its time following the clock (the fixture pins night). */
function autoRoomSource(): RoomSource {
  return {
    getRoom: () => {
      const ctx = devRoomSource(FIXTURE)!.getRoom(CHAR) as RoomContext;
      return { ...ctx, state: { ...ctx.state, time: 'auto' } };
    },
    onChange: () => () => {},
  };
}

const deps = (over: Partial<ChatDeps> = {}): ChatDeps => ({
  getLanState: () => ({ kind: 'closed' }),
  summon: vi.fn(async () => undefined),
  leaveGame: vi.fn(),
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-room-'));
  _setUserDataOverride(dir);
  const character = { id: CHAR, name: 'Sui', persona: { source: 'gremlin', expanded: 'PERSONA' }, metadata: {} };
  getCharacterSpy.mockImplementation(async () => structuredClone(character));
  patchCharacterSpy.mockImplementation(async (_id: string, fn: (c: typeof character) => typeof character) => fn(structuredClone(character)));
  createSpy.mockReset();
  streamSpy.mockReset();
  setRoomSource(devRoomSource(FIXTURE));
});
afterEach(async () => {
  setRoomSource(null);
  setGameSurfaceProbe(null);
  setCallActive(CHAR, false);
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

describe('room line placement', () => {
  it('typed chat: place and time in the status block, look() offered', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'in my room, why' }] });
    await sendChatMessage({ characterId: CHAR, text: 'where are you?' }, deps());
    const r = req(0);
    // The fixture pins night; the line keeps the time only when the clock agrees.
    expect(statusBlock(r)).toContain("You're in your bedroom.");
    expect(r.system.slice(0, -1).map((b) => b.text).join('\n')).not.toContain("You're in your bedroom");
    expect(toolNames(r)).toContain('look');
    expect(toolNames(r).indexOf('look')).toBe(toolNames(r).indexOf('remember') + 1);
  });

  it('typed chat with a clock-following room carries the time word', async () => {
    setRoomSource(autoRoomSource());
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'here' }] });
    await sendChatMessage({ characterId: CHAR, text: 'where are you?' }, deps());
    expect(statusBlock(req(0))).toMatch(/You're in your bedroom\. It's (daytime|night|dusk|dawn)\.\n/);
  });

  it('voice call: place only in the cached status block, the clock stays in the tail', async () => {
    setRoomSource(autoRoomSource());
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'my room' }] });
    await sendChatMessage({ characterId: CHAR, text: 'where are you?', voiceCall: true }, deps());
    const r = req(0);
    expect(statusBlock(r)).toContain("You're in your bedroom.\n");
    expect(statusBlock(r)).not.toMatch(TIME_WORDS);
    expect(JSON.stringify(r.messages[r.messages.length - 1].content)).toContain('[now: ');
    expect(toolNames(r)).toContain('look');
  });

  it('absent in a game (bot session) and on chess / Draw! / Backseat', async () => {
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps({ isInGame: () => true }));
    expect(statusBlock(req(0))).not.toContain('bedroom');
    expect(toolNames(req(0))).not.toContain('look');

    setGameSurfaceProbe(() => true);
    await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());
    expect(statusBlock(req(1))).not.toContain('bedroom');
    expect(toolNames(req(1))).not.toContain('look');
  });

  it('absent without a room: the prompt and tools are what they were', async () => {
    setRoomSource(null);
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());
    expect(statusBlock(req(0))).not.toContain('bedroom');
    expect(toolNames(req(0))).toEqual(['launch', 'quit_game', 'remember', 'web_search', 'visit']);
  });

  it('every voice turn kind sends the same tool list while she has a room', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'hey' }] });
    await sendChatMessage({ characterId: CHAR, text: 'hi', voiceCall: true }, deps());
    await sendVoiceIdleTurn(CHAR, 30, []);
    await sendVoiceGreetingTurn(CHAR, []);
    const lists = createSpy.mock.calls.map((c) => JSON.stringify((c[0] as Req).tools));
    expect(new Set(lists).size).toBe(1);
    expect(lists[0]).toContain('"look"');
  });
});

describe('look()', () => {
  it('typed chat: the lead line lands first, the picture rides beside the tool_result', async () => {
    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'hold on lemme look' },
          { type: 'tool_use', id: 'tu_look', name: 'look', input: {} },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'purple curtains and my trophy' }] });
    const pushed: ChatMessage[] = [];
    const result = await sendChatMessage(
      { characterId: CHAR, text: "what's in your room?" },
      deps({ emitReply: (_id, msg) => void pushed.push(msg) }),
    );
    expect(createSpy).toHaveBeenCalledTimes(2);
    const last = req(1).messages[req(1).messages.length - 1];
    expect(last.role).toBe('user');
    // The Anthropic backend (the mocked SDK): the picture inside the tool_result.
    const blocks = last.content as Array<{ type: string; tool_use_id?: string; content?: Array<{ type: string; text?: string; source?: { media_type: string } }> }>;
    expect(blocks.map((b) => b.type)).toEqual(['tool_result']);
    expect(blocks[0].tool_use_id).toBe('tu_look');
    expect(blocks[0].content!.map((b) => b.type)).toEqual(['text', 'image']);
    expect(blocks[0].content![0].text).toContain('Sei 2026 trophy');
    expect(blocks[0].content![1].source?.media_type).toBe('image/jpeg');
    expect(pushed.map((m) => m.text).join(' ')).toContain('hold on lemme look');
    expect(result.replies.map((m) => m.text).join(' ')).toContain('purple curtains');
  });

  it('single-shot voice turn: one follow-up call with the picture', async () => {
    setCallActive(CHAR, true);
    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'let me look around.' },
          { type: 'tool_use', id: 'tu_l', name: 'look', input: {} },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'my lamp is on.' }] });
    const result = await sendVoiceIdleTurn(CHAR, 30, []);
    expect(createSpy).toHaveBeenCalledTimes(2);
    const last = req(1).messages[req(1).messages.length - 1];
    const blocks = last.content as Array<{ type: string; content?: Array<{ type: string }> }>;
    expect(blocks.map((b) => b.type)).toEqual(['tool_result']);
    expect(blocks[0].content!.map((b) => b.type)).toEqual(['text', 'image']);
    const spoken = result.messages.map((m) => m.text).join(' ');
    expect(spoken).toContain('let me look around');
    expect(spoken).toContain('my lamp is on');
  });
});

describe('desktop lines (M4)', () => {
  it('a poke reply: her room line, the note after the breakpoint, saved to her chat', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hey, that tickles' }] });
    const line = await sendDesktopLineTurn(CHAR, 'poke');
    expect(line?.text).toBe('hey, that tickles');
    const r = req(0);
    expect(statusBlock(r)).toContain("You're in your bedroom.");
    expect(JSON.stringify(r.messages[r.messages.length - 1].content)).toContain(DESKTOP_LINE_NOTES.poke.slice(0, 60));
    const rows = await readRecent(CHAR, 5);
    expect(rows.map((m) => m.text)).toContain('hey, that tickles');
    expect(rows.every((m) => m.voice !== true)).toBe(true);
  });

  it('261105: the face tag her line led with comes back for her desktop face (dev flag only)', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '[smug] told you the lamp goes there' }] });
    const plain = await sendDesktopLineTurn(CHAR, 'poke');
    expect(plain).toMatchObject({ text: 'told you the lamp goes there', face: null });
    const { __setFacesEnabledForTest } = await import('../facepack/facepackDev');
    __setFacesEnabledForTest(true);
    try {
      createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '[smug] told you the lamp goes there' }] });
      expect(await sendDesktopLineTurn(CHAR, 'poke')).toMatchObject({ text: 'told you the lamp goes there', face: 'smug' });
    } finally {
      __setFacesEnabledForTest(null);
    }
  });

  it('an idle (silence) is not shown or saved', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '(silence)' }] });
    expect(await sendDesktopLineTurn(CHAR, 'idle')).toBeNull();
    expect(await readRecent(CHAR, 5)).toEqual([]);
  });

  it('no line (and no model call) while she has no room: a game surface, or none at all', async () => {
    setGameSurfaceProbe(() => true);
    expect(await sendDesktopLineTurn(CHAR, 'idle')).toBeNull();
    setGameSurfaceProbe(null);
    setRoomSource(null);
    expect(await sendDesktopLineTurn(CHAR, 'poke')).toBeNull();
    expect(createSpy).not.toHaveBeenCalled();
  });
});
