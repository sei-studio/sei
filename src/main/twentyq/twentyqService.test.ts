/**
 * 20 Questions service flow — CLONED test structure from
 * connect4Service.test.ts, adapted to the party-tier shape (no hold, no
 * reveal-ack, chat IS the game loop):
 *   - the kickoff turn opens a round; keeper rounds pick a secret first
 *   - ask() delivers the question as a chat line and burns a slot
 *   - guess() burns a slot, marks the pending guess, reveal() claims it only
 *     after the player replied
 *   - an illegal/unknown tool call gets a corrective tool_result, not a
 *     corrupted round (and a same-turn second ask is refused)
 *   - slot exhaustion ends the round deterministically in service code
 *   - keeper secrets NEVER appear in a snapshot until the round is over
 *   - consecutive player messages coalesce into one reply turn
 *   - forfeit hands the round to the player; the session survives rounds
 *   - session end appends the 'play' transcript event
 * The LLM and the secret picker are mocked; the rules, the session FSM
 * queue, and the chat store are real. TQ_TIMING keeps idle ticks away.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';
import type { ChatMessage } from '../../shared/ipc';
import type { TQGameState } from '../../shared/twentyqIpc';

const { createSpy, getCharacterSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
}));
vi.mock('../chat/sdk', () => ({
  CHAT_TIMEOUT_MS: 30_000,
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));
vi.mock('../characterStore', () => ({
  getCharacter: getCharacterSpy,
}));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Player' })),
}));
vi.mock('./secret', () => ({
  generateSecret: vi.fn(async () => 'a lighthouse'),
}));

import {
  initTwentyQService,
  startTwentyQ,
  newRoundTwentyQ,
  getTwentyQState,
  handlePlayerChat,
  endTwentyQ,
  shutdownTwentyQ,
  TQ_TIMING,
} from './twentyqService';

const CHAR = '88888888-8888-4888-8888-888888888888';
let dir: string;
let pushed: TQGameState[];
let chatPushed: ChatMessage[];
let summoned: boolean;

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wait until no turn is running (kickoff done, board quiet). */
async function waitSettled(): Promise<void> {
  await waitFor(() => {
    const last = pushed[pushed.length - 1];
    return last && !last.aiBusy ? true : undefined;
  });
}

type MockParams = { system?: { text: string }[]; tools?: { name: string }[]; messages?: unknown[] };

const toolNames = (p: MockParams): string[] => (p.tools ?? []).map((t) => t.name);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-tq-'));
  _setUserDataOverride(dir);
  pushed = [];
  chatPushed = [];
  summoned = false;
  initTwentyQService({
    pushState: (s) => pushed.push(s),
    pushChatMessage: (_id, msg) => chatPushed.push(msg),
    isSummoned: () => summoned,
  });
  getCharacterSpy.mockImplementation(async () => ({
    id: CHAR,
    name: 'Marv',
    persona: { source: 'grumpy robot', expanded: 'PERSONA' },
    metadata: {},
  }));
  createSpy.mockReset();
  // Default LLM behavior: one short line, no tools (kickoffs, reactions).
  createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'gg' }], usage: {} });
  // Keep idle ticks out of the way.
  TQ_TIMING.idleMinMs = 120_000;
  TQ_TIMING.idleMaxMs = 120_000;
});

afterEach(async () => {
  await endTwentyQ(CHAR);
  await shutdownTwentyQ();
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

describe('twentyq session lifecycle', () => {
  it('refuses to start while summoned in Minecraft', async () => {
    summoned = true;
    await expect(startTwentyQ(CHAR)).rejects.toThrow(/TWENTYQ_MC_SESSION_ACTIVE/);
  });

  it('guesser: kickoff invites, then ask() delivers the question and burns a slot', async () => {
    createSpy.mockImplementation(async (params: MockParams) => {
      if (toolNames(params).includes('ask')) {
        // Second hop of the same turn (after the delivery tool_result): stop.
        if (JSON.stringify(params.messages).includes('delivered')) {
          return { content: [], usage: {} };
        }
        return {
          content: [
            { type: 'text', text: 'hmm. let me think' },
            { type: 'tool_use', id: 'tu1', name: 'ask', input: { question: 'Is it alive?' } },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'think of something!' }], usage: {} };
    });

    const start = await startTwentyQ(CHAR, { mode: 'guesser' });
    expect(start.status).toBe('active');
    expect(start.mode).toBe('guesser');
    expect(start.round).toBe(1);
    // Kickoff spoke the invite (no game tools on that turn).
    await waitFor(() => chatPushed.find((m) => m.text === 'think of something!'));
    await waitSettled();

    const res = await handlePlayerChat({ characterId: CHAR, text: 'ok I am ready' });
    expect(res).not.toBeNull();
    // Banter first, then the canonical question line.
    expect(res!.replies.map((m) => m.text)).toEqual(['hmm. let me think', 'Is it alive?']);

    const state = getTwentyQState(CHAR)!;
    expect(state.questionsUsed).toBe(1);
    expect(state.log).toEqual([{ kind: 'question', text: 'Is it alive?' }]);
    expect(chatPushed.some((m) => m.text === 'Is it alive?')).toBe(true);
  });

  it('guesser: guess() marks the moment; reveal() after the confirm wins the round; new round keeps the score', async () => {
    createSpy.mockImplementation(async (params: MockParams) => {
      const names = toolNames(params);
      const msgs = JSON.stringify(params.messages);
      if (names.includes('reveal')) {
        if (msgs.includes('The round is yours')) return { content: [], usage: {} };
        return {
          content: [
            { type: 'text', text: 'I KNEW IT' },
            { type: 'tool_use', id: 'rv1', name: 'reveal', input: { secret: 'a hedgehog' } },
          ],
          usage: {},
        };
      }
      if (names.includes('guess')) {
        if (msgs.includes('Guess announced')) return { content: [], usage: {} };
        return {
          content: [
            { type: 'text', text: 'it all adds up' },
            { type: 'tool_use', id: 'g1', name: 'guess', input: { answer: 'a hedgehog' } },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startTwentyQ(CHAR, { mode: 'guesser' });
    await waitSettled();

    const r1 = await handlePlayerChat({ characterId: CHAR, text: 'ready. hint: it is spiky' });
    expect(r1!.replies.map((m) => m.text)).toContain('My guess: a hedgehog.');
    let state = getTwentyQState(CHAR)!;
    expect(state.questionsUsed).toBe(1);
    expect(state.log[0]).toMatchObject({ kind: 'guess', text: 'a hedgehog' });
    expect(state.roundOver).toBe(false);

    const r2 = await handlePlayerChat({ characterId: CHAR, text: 'YES that is it' });
    expect(r2!.replies.map((m) => m.text)).toContain('I KNEW IT');
    state = getTwentyQState(CHAR)!;
    expect(state.roundOver).toBe(true);
    expect(state.result).toMatchObject({
      winner: 'character',
      reason: 'guessed',
      secret: 'a hedgehog',
      round: 1,
    });
    expect(state.score).toEqual({ player: 0, character: 1 });

    // New round: fresh pips, same session, score carries.
    const next = await newRoundTwentyQ(CHAR);
    expect(next.round).toBe(2);
    expect(next.questionsUsed).toBe(0);
    expect(next.log).toEqual([]);
    expect(next.roundOver).toBe(false);
    expect(next.result).toBeNull();
    expect(next.score).toEqual({ player: 0, character: 1 });
    await waitSettled(); // round 2 kickoff runs
  });

  it('an unknown tool gets a corrective note and a same-turn second ask is refused', async () => {
    let hops = 0;
    const notes: string[] = [];
    createSpy.mockImplementation(async (params: MockParams) => {
      if (!toolNames(params).includes('ask')) {
        return { content: [{ type: 'text', text: 'gg' }], usage: {} };
      }
      hops++;
      const msgs = JSON.stringify(params.messages);
      if (hops === 1) {
        // A keeper-mode tool, illegal for the guesser.
        return {
          content: [{ type: 'tool_use', id: 'x1', name: 'answer', input: { reply: 'Yes.', verdict: 'yes' } }],
          usage: {},
        };
      }
      if (hops === 2) {
        notes.push(msgs);
        return {
          content: [
            { type: 'tool_use', id: 'a1', name: 'ask', input: { question: 'Is it alive?' } },
            { type: 'tool_use', id: 'a2', name: 'ask', input: { question: 'Is it big?' } },
          ],
          usage: {},
        };
      }
      notes.push(msgs);
      return { content: [], usage: {} };
    });

    await startTwentyQ(CHAR, { mode: 'guesser' });
    await waitSettled();
    await handlePlayerChat({ characterId: CHAR, text: 'ready' });

    const state = getTwentyQState(CHAR)!;
    // Only the FIRST ask landed; the stacked second was refused.
    expect(state.questionsUsed).toBe(1);
    expect(state.log).toEqual([{ kind: 'question', text: 'Is it alive?' }]);
    expect(notes[0]).toContain('not hiding anything');
    expect(notes[1]).toContain('still unanswered');
  });

  it('guesser: burning all 20 slots loses the round to the player, with a reaction turn', async () => {
    let q = 0;
    createSpy.mockImplementation(async (params: MockParams) => {
      if (toolNames(params).includes('ask')) {
        if (JSON.stringify(params.messages).includes('delivered')) return { content: [], usage: {} };
        q++;
        return {
          content: [{ type: 'tool_use', id: `q${q}`, name: 'ask', input: { question: `Question ${q}?` } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startTwentyQ(CHAR, { mode: 'guesser' });
    await waitSettled();
    for (let i = 0; i < 20; i++) {
      await handlePlayerChat({ characterId: CHAR, text: 'nope' });
    }
    expect(getTwentyQState(CHAR)!.questionsUsed).toBe(20);
    expect(getTwentyQState(CHAR)!.roundOver).toBe(false); // question 20 still out

    // The reply to the 20th question closes the round deterministically.
    await handlePlayerChat({ characterId: CHAR, text: 'nope, that was your last one' });
    const ended = await waitFor(() =>
      pushed.slice().reverse().find((s) => s.roundOver && s.result?.reason === 'out-of-questions'),
    );
    expect(ended.result).toMatchObject({ winner: 'player', reason: 'out-of-questions' });
    expect(ended.score).toEqual({ player: 1, character: 0 });
    // The sore-loser reaction turn spoke.
    await waitFor(() => (chatPushed.some((m) => m.text === 'gg') ? true : undefined));
  });

  it('keeper: the secret never leaks into snapshots; answers burn player slots; a named guess ends it honestly', async () => {
    let answered = false;
    createSpy.mockImplementation(async (params: MockParams) => {
      const names = toolNames(params);
      const msgs = JSON.stringify(params.messages);
      if (names.includes('answer')) {
        if (!answered) {
          if (msgs.includes('Answer delivered')) {
            answered = true;
            return { content: [], usage: {} };
          }
          return {
            content: [{ type: 'tool_use', id: 'an1', name: 'answer', input: { reply: 'Towering.', verdict: 'yes' } }],
            usage: {},
          };
        }
        if (msgs.includes('takes the round')) return { content: [], usage: {} };
        return {
          content: [
            { type: 'text', text: 'well played' },
            { type: 'tool_use', id: 'rv1', name: 'reveal', input: { secret: 'a lighthouse', player_got_it: true } },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'I have something in mind' }], usage: {} };
    });

    await startTwentyQ(CHAR, { mode: 'keeper' });
    await waitSettled();

    const r1 = await handlePlayerChat({ characterId: CHAR, text: 'is it tall?' });
    expect(r1!.replies.map((m) => m.text)).toContain('Towering.');
    let state = getTwentyQState(CHAR)!;
    expect(state.questionsUsed).toBe(1);
    expect(state.log[0]).toMatchObject({ kind: 'answer', text: 'Towering.', verdict: 'yes' });

    // Secrecy invariant: no live snapshot ever carried the secret.
    for (const s of pushed.filter((s) => !s.roundOver)) {
      expect(JSON.stringify(s)).not.toContain('lighthouse');
    }

    const r2 = await handlePlayerChat({ characterId: CHAR, text: 'is it a lighthouse??' });
    expect(r2!.replies.map((m) => m.text)).toContain('well played');
    state = getTwentyQState(CHAR)!;
    expect(state.roundOver).toBe(true);
    expect(state.result).toMatchObject({ winner: 'player', reason: 'guessed', secret: 'a lighthouse' });
    expect(state.score).toEqual({ player: 1, character: 0 });
  });

  it('forfeit hands the round to the player and the session survives', async () => {
    createSpy.mockImplementation(async (params: MockParams) => {
      if (toolNames(params).includes('forfeit')) {
        if (JSON.stringify(params.messages).includes('You give up')) return { content: [], usage: {} };
        return {
          content: [
            { type: 'text', text: 'i refuse to play this cursed round' },
            { type: 'tool_use', id: 'f1', name: 'forfeit', input: {} },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startTwentyQ(CHAR, { mode: 'guesser' });
    await waitSettled();
    await handlePlayerChat({ characterId: CHAR, text: 'ready' });

    const state = getTwentyQState(CHAR)!;
    expect(state.status).toBe('active'); // round over, session alive
    expect(state.roundOver).toBe(true);
    expect(state.result).toMatchObject({ winner: 'player', reason: 'gave-up' });
    const next = await newRoundTwentyQ(CHAR);
    expect(next.round).toBe(2);
    await waitSettled();
  });

  it('consecutive player messages coalesce into one reply turn', async () => {
    let replyTurns = 0;
    createSpy.mockImplementation(async (params: MockParams) => {
      if (toolNames(params).includes('ask')) {
        replyTurns++;
        await new Promise((r) => setTimeout(r, 100)); // keep the turn in flight
        return { content: [{ type: 'text', text: 'yo' }], usage: {} };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startTwentyQ(CHAR, { mode: 'guesser' });
    await waitSettled();
    const p1 = handlePlayerChat({ characterId: CHAR, text: 'one' });
    // Give the first dispatch a beat to start, then stack two more sends.
    await new Promise((r) => setTimeout(r, 30));
    const p2 = handlePlayerChat({ characterId: CHAR, text: 'two' });
    const p3 = handlePlayerChat({ characterId: CHAR, text: 'three' });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    // First send got its own turn; the two stacked sends shared ONE turn.
    expect(replyTurns).toBe(2);
    expect(r2!.replies).toEqual(r3!.replies);
    expect(r1!.replies.map((m) => m.text)).toContain('yo');
  });

  it('closing the session appends the play transcript event', async () => {
    createSpy.mockImplementation(async (params: MockParams) => {
      const names = toolNames(params);
      const msgs = JSON.stringify(params.messages);
      // Stop once any tool_result landed this turn.
      if (msgs.includes('The round is yours') || msgs.includes('Guess announced') || msgs.includes('already over')) {
        return { content: [], usage: {} };
      }
      if (names.includes('reveal')) {
        return {
          content: [{ type: 'tool_use', id: 'rv1', name: 'reveal', input: { secret: 'a hedgehog' } }],
          usage: {},
        };
      }
      if (names.includes('guess')) {
        return {
          content: [{ type: 'tool_use', id: 'g1', name: 'guess', input: { answer: 'a hedgehog' } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startTwentyQ(CHAR, { mode: 'guesser' });
    await waitSettled();
    await handlePlayerChat({ characterId: CHAR, text: 'ready' });
    await handlePlayerChat({ characterId: CHAR, text: 'yes!' });
    expect(getTwentyQState(CHAR)!.roundOver).toBe(true);

    await endTwentyQ(CHAR);
    const ev = await waitFor(() =>
      chatPushed.find((m) => (m as ChatMessage & { event?: { kind: string } }).event?.kind === 'play'),
    );
    expect((ev as ChatMessage & { event: { game: string; durationMs: number } }).event.game).toBe('20 Questions');
    expect(getTwentyQState(CHAR)).toBeNull();
  });
});
