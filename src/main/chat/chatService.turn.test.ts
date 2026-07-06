/**
 * Chat turn correctness — the tool-use hop loop and the last_chatted stamp.
 *
 * Pins two invariants of sendChatMessage:
 *   - Every tool_use block in an assistant turn gets a matching tool_result in
 *     the next user message. With launch + quit both offered, the model can
 *     call them in parallel ("say bye and log off, then hop back in") — an
 *     unanswered tool_use id makes the follow-up create() 400.
 *   - The last_chatted stamp goes through patchCharacter (260705: fresh read
 *     inside the store's lock), never the turn's opening snapshot — that
 *     snapshot is seconds stale by the time the reply lands; spreading it
 *     would silently revert an edit saved mid-reply (and sync the revert to
 *     the cloud). Mirrors the last_launched stamp in botSupervisor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';

const { createSpy, getCharacterSpy, patchCharacterSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  patchCharacterSpy: vi.fn(),
}));
vi.mock('./sdk', () => ({
  CHAT_TIMEOUT_MS: 30_000,
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));
vi.mock('../characterStore', () => ({
  getCharacter: getCharacterSpy,
  patchCharacter: patchCharacterSpy,
}));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Player' })),
}));

import type { ChatDeps } from './chatService';
import { sendChatMessage, cancelInflightTurn, CHAT_ABORTED } from './chatService';

const CHAR = '55555555-5555-4555-8555-555555555555';
let dir: string;
let character: { id: string; name: string; persona: { source: string; expanded: string }; metadata: Record<string, unknown> };

const deps = (): ChatDeps => ({
  getLanState: () => ({ kind: 'closed' }),
  summon: vi.fn(async () => undefined),
  leaveGame: vi.fn(),
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-turn-'));
  _setUserDataOverride(dir);
  character = {
    id: CHAR,
    name: 'Marv',
    persona: { source: 'grumpy robot', expanded: 'ORIGINAL PERSONA' },
    metadata: {},
  };
  // Every read returns the CURRENT character — like the store, not a snapshot.
  getCharacterSpy.mockImplementation(async () => structuredClone(character));
  // patchCharacter fake mirrors the real contract: read the CURRENT character,
  // apply the updater, PERSIST the result back to the store (so later reads
  // see it), and hand it back (recorded in mock.results).
  patchCharacterSpy.mockReset();
  patchCharacterSpy.mockImplementation(
    async (_id: string, updater: (c: typeof character) => typeof character) => {
      character = updater(structuredClone(character));
      return structuredClone(character);
    },
  );
  createSpy.mockReset();
});
afterEach(async () => {
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

describe('sendChatMessage — parallel tool_use blocks', () => {
  it('answers every tool_use id in one tool_result turn (quit + launch in parallel)', async () => {
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'logging off — back when you reopen.' },
          { type: 'tool_use', id: 'tu_quit', name: 'quit', input: {} },
          { type: 'tool_use', id: 'tu_launch', name: 'launch', input: { game: 'minecraft' } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok, gone for real.' }] });

    const d = deps();
    const result = await sendChatMessage({ characterId: CHAR, text: 'say bye and log off, then hop back in' }, d);

    expect(createSpy).toHaveBeenCalledTimes(2);
    // The second hop's request must carry one tool_result per tool_use id —
    // anything less is a guaranteed 400 from the API.
    const secondReq = createSpy.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const resultTurn = secondReq.messages[secondReq.messages.length - 1];
    expect(resultTurn.role).toBe('user');
    const blocks = resultTurn.content as Array<{ type: string; tool_use_id: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'tool_result']);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['tu_quit', 'tu_launch']);

    expect(d.leaveGame).toHaveBeenCalledTimes(1);
    expect(result.replies.length).toBeGreaterThan(0);
  });

  it('still runs the single-tool loop unchanged', async () => {
    createSpy
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'launch', input: { game: 'minecraft' } }],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'world is closed — open to LAN first.' }] });

    const result = await sendChatMessage({ characterId: CHAR, text: 'hop in' }, deps());

    const secondReq = createSpy.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> };
    const blocks = secondReq.messages[secondReq.messages.length - 1].content as Array<{ tool_use_id: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool_use_id).toBe('tu_1');
    expect(result.launch).toEqual({ game: 'minecraft', status: 'lan-not-open' });
  });
});

describe('sendChatMessage — last_chatted stamp', () => {
  it('re-reads the character before stamping, so an edit saved mid-reply survives', async () => {
    // The player saves a persona edit WHILE the reply is generating: mutate the
    // store inside the mocked LLM call, i.e. after the turn's opening snapshot.
    createSpy.mockImplementationOnce(async () => {
      character = { ...character, persona: { ...character.persona, expanded: 'EDITED WHILE REPLYING' } };
      return { content: [{ type: 'text', text: 'hey.' }] };
    });

    await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());

    expect(patchCharacterSpy).toHaveBeenCalledTimes(1);
    const saved = (await patchCharacterSpy.mock.results[0].value) as {
      persona: { expanded: string };
      last_chatted?: string;
    };
    expect(saved.persona.expanded).toBe('EDITED WHILE REPLYING');
    expect(saved.last_chatted).toBeTruthy();
  });
});

describe('cancelInflightTurn (260705 — reset-memory interrupt)', () => {
  it('aborts the in-flight turn: CHAT_ABORTED surfaces, nothing persists after the wipe', async () => {
    // Park the LLM call on a deferred so the cancel can land mid-turn.
    let release!: (v: { content: Array<{ type: string; text: string }> }) => void;
    createSpy.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const turn = sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());
    const settled = expect(turn).rejects.toThrow(CHAT_ABORTED);
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    // Reset memory fires the external interrupt, then the LLM resolves anyway —
    // the reply must be dropped, not appended to the freshly wiped transcript.
    cancelInflightTurn(CHAR);
    release({ content: [{ type: 'text', text: 'too late — the wipe already ran' }] });
    await settled;

    // The success-path tail never ran: no reply persisted, no last_chatted stamp.
    const { readAll } = await import('./chatStore');
    const rows = await readAll(CHAR);
    expect(rows.filter((m) => m.role === 'companion')).toHaveLength(0);
    expect(patchCharacterSpy).not.toHaveBeenCalled();
  });
});
