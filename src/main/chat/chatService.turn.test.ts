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
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride, paths } from '../paths';

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
import { sendChatMessage, sendVoiceIdleTurn, sendCompanionVoiceTurn, cancelInflightTurn, CHAT_ABORTED } from './chatService';
import { setCallActive } from '../voice/callState';

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
  // callState is module-level; clear it so a test that opened a call never
  // leaks the flag into the next one.
  setCallActive(CHAR, false);
  await rm(dir, { recursive: true, force: true });
});

describe('sendChatMessage — parallel tool_use blocks', () => {
  it('answers every tool_use id in one tool_result turn (quit + launch in parallel)', async () => {
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'logging off — back when you reopen.' },
          { type: 'tool_use', id: 'tu_quit', name: 'quit_game', input: {} },
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

  it('does NOT run a second hop when quit rides with an already-spoken goodbye (double-goodbye guard)', async () => {
    // The model says its goodbye AND calls quit in one response. The old code ran
    // a second hop whose tool-note said "say goodbye if you have not already",
    // producing a redundant second farewell. The guard stops after the first hop.
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'aight, catch you later.' },
        { type: 'tool_use', id: 'tu_quit', name: 'quit_game', input: {} },
      ],
    });
    // A second resolve is staged but must never be consumed.
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'later, thanks for having me.' }] });

    const d = deps();
    const result = await sendChatMessage({ characterId: CHAR, text: 'you can head off' }, d);

    expect(createSpy).toHaveBeenCalledTimes(1); // no redundant second goodbye hop
    expect(d.leaveGame).toHaveBeenCalledTimes(1);
    // splitReply strips the trailing period under the default casual register.
    expect(result.replies.map((r) => r.text)).toEqual(['aight, catch you later']);
  });

  it('remember() on a voice turn appends to MEMORY.md and answers the tool_use', async () => {
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'oh a big exam, noted.' },
          { type: 'tool_use', id: 'tu_rem', name: 'remember', input: { text: 'player has a big exam on friday' } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'good luck friday.' }] });

    const result = await sendChatMessage(
      { characterId: CHAR, text: 'i have a big exam friday', voiceCall: true },
      deps(),
    );

    const mem = await readFile(path.join(paths.memoryDir(CHAR), 'MEMORY.md'), 'utf8');
    expect(mem).toContain('player has a big exam on friday');
    // The tool_use was answered (second hop ran) and the reply survived.
    const secondReq = createSpy.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> };
    const blocks = secondReq.messages[secondReq.messages.length - 1].content as Array<{ type: string; tool_use_id: string }>;
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['tu_rem']);
    expect(result.replies.length).toBeGreaterThan(0);
  });
});

describe('silence-by-convention + idle nudge (260707)', () => {
  it('a "(silence)" reply ends the turn with no reply persisted', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '(silence)' }] });

    const result = await sendChatMessage({ characterId: CHAR, text: 'brb grabbing water', voiceCall: true }, deps());

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.replies).toEqual([]);
  });

  it('"(staying silent)" and friends are parsed out too', async () => {
    // Includes the embellished forms captured from a real Sui/Marv transcript
    // (260707): trailing clause after the keyword, and bare "(nothing)".
    for (const filler of [
      '(staying silent)',
      '[stays quiet]',
      '*remains silent*',
      '(says nothing)',
      '(staying silent, letting it rest)',
      '(saying nothing, the thread has landed)',
      '(nothing)',
    ]) {
      createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: filler }] });
      const result = await sendChatMessage({ characterId: CHAR, text: 'ok', voiceCall: true }, deps());
      expect(result.replies, filler).toEqual([]);
    }
  });

  it('typed chat keeps a filler-shaped roleplay beat (the drop is voice-only)', async () => {
    // No voiceCall flag: the "(silence)" convention is never prompted in text
    // chat, so an in-character "*stays silent*" is a real reply and must land
    // as a bubble instead of being silently discarded.
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '*stays silent*' }] });

    const result = await sendChatMessage({ characterId: CHAR, text: 'say nothing then' }, deps());

    expect(result.replies.map((r) => r.text)).toEqual(['*stays silent*']);
  });

  it('the idle nudge never preempts an in-flight turn', async () => {
    setCallActive(CHAR, true);
    let release: (v: unknown) => void = () => {};
    createSpy.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const pending = sendChatMessage({ characterId: CHAR, text: 'hey', voiceCall: true }, deps());
    // Wait for the real turn to actually reach the LLM (holds the inflight slot).
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    const nudge = await sendVoiceIdleTurn(CHAR, 30, []);
    expect(nudge).toEqual({ messages: [] }); // skipped — a real turn is running
    expect(createSpy).toHaveBeenCalledTimes(1); // the nudge never called the LLM

    release({ content: [{ type: 'text', text: 'yo.' }] });
    const result = await pending;
    expect(result.replies.length).toBeGreaterThan(0); // the real turn was untouched
  });

  it('the idle nudge bails without an LLM call when no call is active (hang-up race)', async () => {
    // No setCallActive: the renderer timer fired just after hang-up. The nudge
    // must not run a paid turn or persist an unheard voice line.
    const nudge = await sendVoiceIdleTurn(CHAR, 30, []);

    expect(nudge).toEqual({ messages: [] });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('idle nudge honors a "(silence)" reply: nothing persisted or returned', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '(silence)' }] });

    const result = await sendVoiceIdleTurn(CHAR, 42, []);

    expect(result).toEqual({ messages: [] });
    expect(createSpy).toHaveBeenCalledTimes(1);
    // The quiet-duration hint reached the model.
    const req = createSpy.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(req.messages)).toContain('quiet for about 42 seconds');
  });

  it('idle nudge surfaces end_call: the goodbye is returned AND endCall is flagged', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: "well, i'll let you go!" },
        { type: 'tool_use', id: 'tu_end', name: 'end_call', input: {} },
      ],
    });

    const result = await sendVoiceIdleTurn(CHAR, 90, []);

    expect(result.endCall).toBe(true);
    // The spoken goodbye still comes back so the renderer can speak it first.
    expect(result.messages.map((m) => m.text)).toEqual(["well, i'll let you go!"]);
    expect(createSpy).toHaveBeenCalledTimes(1); // no tool loop on a nudge
  });
});

// 260708: while one companion was in the player's world, a call-only companion
// was told "no world open" (openWorldDetected hardcoded false) and its launch()
// calls were dropped (single-shot turns run no tool loop) — it could only join
// once the in-game sibling disconnected. These pin the fix: live LAN truth in
// the prompt, and launch() honored via the caller's onLaunch.
describe('call-only companion: world truth + single-shot launch honor (260708)', () => {
  it('companion reaction turn tells the model the world IS open and honors launch()', async () => {
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'hopping in.' },
        { type: 'tool_use', id: 'tu_l', name: 'launch', input: { game: 'minecraft' } },
      ],
    });
    const onLaunch = vi.fn();

    const replies = await sendCompanionVoiceTurn(CHAR, {
      speakerName: 'Sui',
      text: 'get in here marv',
      peers: ['Sui'],
      openWorldDetected: true,
      onLaunch,
    });

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(replies.map((r) => r.text)).toEqual(['hopping in']);
    const req = createSpy.mock.calls[0][0] as { system: unknown };
    expect(JSON.stringify(req.system)).toContain('an open Minecraft world is detected');
    expect(JSON.stringify(req.system)).not.toContain('no open Minecraft world is detected');
  });

  it('companion reaction turn without a launch() call never fires onLaunch', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'lol true' }] });
    const onLaunch = vi.fn();

    await sendCompanionVoiceTurn(CHAR, {
      speakerName: 'Sui',
      text: 'this game is chaos',
      peers: ['Sui'],
      openWorldDetected: true,
      onLaunch,
    });

    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('companion reaction turn defaults to world-closed framing when no state is passed', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'yeah' }] });

    await sendCompanionVoiceTurn(CHAR, { speakerName: 'Sui', text: 'hm', peers: ['Sui'] });

    const req = createSpy.mock.calls[0][0] as { system: unknown };
    expect(JSON.stringify(req.system)).toContain('no open Minecraft world is detected');
  });

  it('idle nudge honors launch() through opts.onLaunch', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: "i'm gonna hop into the world." },
        { type: 'tool_use', id: 'tu_l', name: 'launch', input: { game: 'minecraft' } },
      ],
    });
    const onLaunch = vi.fn();

    const result = await sendVoiceIdleTurn(CHAR, 60, ['Sui'], { openWorldDetected: true, onLaunch });

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(result.messages.length).toBe(1);
    const req = createSpy.mock.calls[0][0] as { system: unknown };
    expect(JSON.stringify(req.system)).toContain('an open Minecraft world is detected');
  });
});

// 260708: on a group call a model sometimes ECHOES the transcript's attribution
// convention and writes a line FOR the other companion inside its own reply
// (live capture: Marv's reply opened with "(Sui, on the call): oh let's go..."
// — spoken in Marv's voice, and a ghost Sui line entered the transcript). The
// prefix is injected only on heard lines, so a reply part carrying it is always
// fabricated dialogue and is dropped on the voice paths.
describe('peer-impersonation drop (260708)', () => {
  it('a voice reply line written in a peer\'s voice is dropped; the real line lands', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: "(Sui, on the call): let's gooo\nalright, heading in" }],
    });

    const result = await sendChatMessage({ characterId: CHAR, text: 'you two ready?', voiceCall: true }, deps());

    expect(result.replies.map((r) => r.text)).toEqual(['alright, heading in']);
  });

  it('a reaction turn consisting ONLY of a fabricated peer line returns nothing', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: '(Sui, on the call): i would never say that' }],
    });

    const replies = await sendCompanionVoiceTurn(CHAR, {
      speakerName: 'Sui',
      text: 'marv tell them',
      peers: ['Sui'],
    });

    expect(replies).toEqual([]);
  });

  it('typed chat keeps such a line (the drop is voice-only)', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: '(Sui, on the call): hey' }],
    });

    const result = await sendChatMessage({ characterId: CHAR, text: 'what did sui say?' }, deps());

    expect(result.replies.map((r) => r.text)).toEqual(['(Sui, on the call): hey']);
  });
});

// 260708 (demo directive): an agentic character (proactiveness 2) must always
// have something to say on an idle call — its nudge note asks for a topic
// outright and offers NO silence option, so quiet stretches reliably become
// conversation. Lower dials keep the original take-it-or-leave-it note.
describe('idle nudge — proactiveness-keyed note (260708)', () => {
  it('proactiveness 2 gets the keep-alive note with no silence option', async () => {
    character.metadata = { proactiveness: 2 };
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok so weird thought.' }] });

    const result = await sendVoiceIdleTurn(CHAR, 12, ['Marv']);

    expect(result.messages.length).toBe(1);
    const req = createSpy.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    const body = JSON.stringify(req.messages);
    expect(body).toContain('Keep the call alive');
    expect(body).toContain('rope the other companions');
    expect(body).not.toContain('reply with exactly (silence)');
  });

  it('default proactiveness keeps the original note with silence sanctioned', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '(silence)' }] });

    await sendVoiceIdleTurn(CHAR, 12, []);

    const req = createSpy.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    const body = JSON.stringify(req.messages);
    expect(body).toContain('reply with exactly (silence)');
    expect(body).not.toContain('Keep the call alive');
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

describe('transcript stop sequences (260722 — TTS prompt leak)', () => {
  // Live capture: a voice-call reply turn continued the transcript past its own
  // lines (a fabricated "Human: ..." player turn plus an invented direction)
  // and the continuation was persisted and spoken by TTS. The structural guard
  // is request-level stop_sequences on EVERY turn runner that persists or
  // speaks reply text: generation ends the moment the model starts writing the
  // other side's line-start markers, so the leak text is never produced.
  it('sendChatMessage requests carry TRANSCRIPT_STOP_SEQUENCES', async () => {
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'hey' }], usage: {} });
    await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());
    expect(createSpy).toHaveBeenCalled();
    for (const call of createSpy.mock.calls) {
      const req = call[0] as { stop_sequences?: string[] };
      expect(req.stop_sequences).toEqual(
        expect.arrayContaining(['\nHuman:', '\nAssistant:', '\nPlayer:']),
      );
    }
  });

  it('voice idle nudges and companion turns carry them too (spoken paths)', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'yo' }], usage: {} });
    await sendVoiceIdleTurn(CHAR, 30, []);
    await sendCompanionVoiceTurn(CHAR, { speakerName: 'Sui', text: 'hey marv', peers: ['Sui'], depth: 0 });
    expect(createSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of createSpy.mock.calls) {
      const req = call[0] as { stop_sequences?: string[] };
      expect(req.stop_sequences).toEqual(expect.arrayContaining(['\nHuman:', '\nPlayer:']));
    }
  });
});
