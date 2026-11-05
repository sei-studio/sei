/**
 * 261105 (T336): decorating her room together, on the real chat turn.
 *
 * Pins: decorate() rides the tool list only while her editor is open (the
 * same list on every turn kind), the per-turn note, her edits reaching the
 * editor as ops, the "answered" end of a clean decorate turn, the call
 * picture (only when the room changed), and that talk-box turns and live
 * lines land in her normal chat transcript.
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
import { __resetTogetherForTest, closeTogether, openTogether, setTogetherSink, syncTogether } from '../seilink/editorTogether';
import { liveLineNote } from '../seilink/editorTogether';
import { paletteWords } from '../../shared/seilinkDecorate';
import { swatchesFor } from '../../shared/seilinkEdit';
import type { SeilinkEditorEvent } from '../../shared/seilinkTogether';
import { roomChanges } from '../../shared/seilinkRoomDiff';

const CHAR = '66666666-6666-4666-8666-666666666666';
const FIXTURE = path.join(__dirname, '..', 'seilink', '__fixtures__', 'room-pack', 'room.json');
let dir: string;
let events: SeilinkEditorEvent[] = [];

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
  __resetTogetherForTest();
  events = [];
  setTogetherSink((e) => events.push(e));
});
afterEach(async () => {
  setRoomSource(null);
  setGameSurfaceProbe(null);
  setCallActive(CHAR, false);
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});


const TOKEN = 'tok_chat_together';
function savedRoom(): RoomContext {
  return devRoomSource(FIXTURE)!.getRoom(CHAR) as RoomContext;
}
function openEditor(onCall = false): RoomContext {
  const room = savedRoom();
  openTogether(TOKEN, CHAR, room, { now: Date.now(), onCall });
  return room;
}
/** The player changes the curtains in the editor (unsaved). */
function playerEdits(room: RoomContext, i = 2): RoomContext {
  const curtains = room.manifest.components.find((c) => c.id === 'curtains-plain')!;
  const tint = swatchesFor(curtains)[i];
  const next = { ...room, state: { ...room.state, slots: { ...room.state.slots, curtains: { id: 'curtains-plain', tint } } } };
  syncTogether(TOKEN, next, Date.now());
  return next;
}
const lastUserText = (r: Req): string => JSON.stringify(r.messages[r.messages.length - 1].content);
const hasRoomPicture = (r: Req): boolean =>
  r.messages.some((m) => m.role === 'assistant' && Array.isArray(m.content) && (m.content as Array<{ type: string; name?: string; id?: string }>).some((b) => b.type === 'tool_use' && b.name === 'look' && String(b.id).startsWith('toolu_room_')));

describe('decorate() on her turns', () => {
  it('rides last, only while her editor is open, the same list on every voice turn kind', async () => {
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());
    expect(toolNames(req(0))).not.toContain('decorate');
    openEditor();
    await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());
    expect(toolNames(req(1)).at(-1)).toBe('decorate');
    expect(lastUserText(req(1))).toContain('decorating your room together');
    // Room for a lead line plus a five-change call, only while the editor is open.
    expect((req(0) as unknown as { max_tokens: number }).max_tokens).toBe(200);
    expect((req(1) as unknown as { max_tokens: number }).max_tokens).toBe(400);

    setCallActive(CHAR, true);
    createSpy.mockClear();
    await sendChatMessage({ characterId: CHAR, text: 'hi', voiceCall: true }, deps());
    await sendVoiceIdleTurn(CHAR, 30, []);
    await sendVoiceGreetingTurn(CHAR, []);
    const lists = createSpy.mock.calls.map((c) => JSON.stringify((c[0] as Req).tools));
    expect(new Set(lists).size).toBe(1);
    expect(lists[0]).toContain('"decorate"');
    closeTogether(TOKEN);
  });

  it('"make it cozier": her edits go to the editor, then her line about them, all in her chat', async () => {
    const room = openEditor();
    const curtains = room.manifest.components.find((c) => c.id === 'curtains-plain')!;
    const word = paletteWords(swatchesFor(curtains))[1].word;
    createSpy.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'ooh leave it to me' },
        {
          type: 'tool_use',
          id: 'tu_dec',
          name: 'decorate',
          input: { mode: 'apply', changes: [{ do: 'color', target: 'curtains', value: word }, { do: 'time', value: 'dusk' }] },
        },
      ],
    });
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'there, dusk and new curtains' }] });
    const pushed: ChatMessage[] = [];
    const result = await sendChatMessage({ characterId: CHAR, text: 'make it cozier' }, deps({ emitReply: (_id, m) => void pushed.push(m) }));
    // Two changes: a second hop, where she reads what landed and says so.
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(lastUserText(req(1))).toContain('Done, the room changed');
    const edits = events.find((e) => e.kind === 'edits');
    expect(edits).toMatchObject({ token: TOKEN, mode: 'apply', changes: 2 });
    expect(edits && edits.kind === 'edits' && edits.ops.map((o) => o.op)).toEqual(['slot_tint', 'time']);
    const said = [...pushed, ...result.replies].map((m) => m.text).join(' ');
    expect(said).toContain('leave it to me');
    expect(said).toContain('dusk and new curtains');
    const rows = await readRecent(CHAR, 10);
    expect(rows.map((m) => m.text)).toEqual(expect.arrayContaining(['make it cozier', 'ooh leave it to me', 'there, dusk and new curtains']));
    closeTogether(TOKEN);
  });

  it('one change she already answered for ends the turn in one call', async () => {
    const room = openEditor();
    const curtains = room.manifest.components.find((c) => c.id === 'curtains-plain')!;
    const word = paletteWords(swatchesFor(curtains))[1].word;
    createSpy.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: `sure, ${word} it is` },
        { type: 'tool_use', id: 'tu_dec', name: 'decorate', input: { mode: 'apply', changes: [{ do: 'color', target: 'curtains', value: word }] } },
      ],
    });
    const result = await sendChatMessage({ characterId: CHAR, text: `${word} curtains please` }, deps());
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.kind === 'edits')).toMatchObject({ mode: 'apply', changes: 1 });
    expect(result.replies.map((m) => m.text).join(' ')).toContain('it is');
    closeTogether(TOKEN);
  });

  it('a refused change gets a second hop with the real options', async () => {
    openEditor();
    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_dec', name: 'decorate', input: { changes: [{ do: 'add', target: 'grand piano' }] } }],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'no piano here, sadly' }] });
    const result = await sendChatMessage({ characterId: CHAR, text: 'add a piano' }, deps());
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(lastUserText(req(1))).toContain('not something this room has');
    expect(events.some((e) => e.kind === 'edits')).toBe(false);
    expect(result.replies.map((m) => m.text).join(' ')).toContain('no piano');
    closeTogether(TOKEN);
  });
});

describe('call pictures while the editor is open', () => {
  it('a picture on the next line only after the room changed, then not again until it changes', async () => {
    setCallActive(CHAR, true);
    const room = openEditor(true);
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'mm' }] });
    await sendChatMessage({ characterId: CHAR, text: 'what do you think', voiceCall: true }, deps());
    expect(hasRoomPicture(req(0))).toBe(false);
    const next = playerEdits(room);
    await sendChatMessage({ characterId: CHAR, text: 'and now?', voiceCall: true }, deps());
    expect(hasRoomPicture(req(1))).toBe(true);
    expect(lastUserText(req(1))).toContain('"type":"image"');
    // The change list rides in the text note too.
    const changed = roomChanges(room.manifest, room.state, next.manifest, next.state);
    expect(JSON.stringify(req(1).messages)).toContain(changed[0].text.slice(0, 20));
    await sendChatMessage({ characterId: CHAR, text: 'right?', voiceCall: true }, deps());
    expect(hasRoomPicture(req(2))).toBe(false);
    closeTogether(TOKEN);
  });
});

describe('live lines land in her chat', () => {
  it('the live note rides the desktop-line turn and the line is saved to her transcript', async () => {
    const room = openEditor();
    const next = playerEdits(room);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ooh, I like that colour' }] });
    const note = liveLineNote(roomChanges(room.manifest, room.state, next.manifest, next.state));
    const line = await sendDesktopLineTurn(CHAR, 'react', undefined, note);
    expect(line?.text).toBe('ooh, I like that colour');
    expect(lastUserText(req(0))).toContain('decorating your room while you watch');
    const rows = await readRecent(CHAR, 5);
    expect(rows.map((m) => m.text)).toContain('ooh, I like that colour');
    closeTogether(TOKEN);
  });
});
