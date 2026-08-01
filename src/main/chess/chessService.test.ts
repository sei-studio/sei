/**
 * Chess service state machine — the parts most likely to corrupt a game:
 *   - the AI move enters the presentation hold, presents as pendingAiMove
 *     when the turn ends, and only commits on ackReveal (the renderer quiet gate)
 *   - an illegal play() gets a retry tool_result, not a broken board
 *   - a player chat during the hold NEVER re-decides: the reply turn is told
 *     the queued move but is text-only (260730: play()/wait() revision on
 *     reply turns was dropped; a stray play() gets a terminal refusal)
 *   - a silent play() is a legitimate turn (no forced table-talk hop)
 *   - consecutive player messages coalesce into one reply turn
 *   - the move prompt states the player's last move in plain words
 *   - draw offers resolve through propose_draw
 *   - a summoned character cannot start a game (mutual exclusion)
 * The LLM, CCE engine, model store, and profile derivation are all mocked;
 * the board (chess.js), the session FSM queue, and the hold are real.
 * CHESS_TIMING is zeroed/stretched so turns present instantly and idle ticks
 * never fire mid-test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';
import { _setUserDataOverride } from '../paths';
import * as chatStore from '../chat/chatStore';
import type { ChatMessage } from '../../shared/ipc';
import type { ChessGameState } from '../../shared/chessIpc';

const { createSpy, getCharacterSpy, patchCharacterSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  patchCharacterSpy: vi.fn(),
}));
vi.mock('../chat/sdk', () => ({
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
vi.mock('./modelStore', () => ({
  ensureModel: vi.fn(async () => '/fake/model.onnx'),
  modelReady: vi.fn(async () => true),
}));
vi.mock('./chessProfile', () => ({
  getOrCreateChessProfile: vi.fn(async () => ({ elo: 900, styleNote: 'testy', source: 'auto' })),
}));
// The engine returns the first 4 legal moves as "candidates" — deterministic
// and always legal, like the real CCE output.
vi.mock('cce-1', () => ({
  CharacterChessEngine: {
    create: vi.fn(async () => ({
      candidateSet: vi.fn(async (fen: string) => {
        const chess = new Chess(fen);
        const legal = chess.moves({ verbose: true }).slice(0, 4);
        return {
          macro: { text: 'Material is even.' },
          candidates: legal.map((m) => ({
            uci: m.from + m.to + (m.promotion ?? ''),
            san: m.san,
            sentence: `You move ${m.san}.`,
            tags: [],
            line: null,
          })),
        };
      }),
      dispose: vi.fn(),
    })),
  },
}));

import {
  initChessService,
  startChess,
  playerMove,
  ackReveal,
  offerDraw,
  resign,
  handlePlayerChat,
  endChess,
  shutdownChess,
  hasChessCoordinates,
  CHESS_TIMING,
} from './chessService';

const CHAR = '66666666-6666-4666-8666-666666666666';
let dir: string;
let pushed: ChessGameState[];
let chatPushed: ChatMessage[];
let summoned: boolean;

function lastState(): ChessGameState {
  return pushed[pushed.length - 1];
}

interface PromptParams {
  system?: { text: string }[];
  messages?: unknown[];
  tools?: Array<{ name: string }>;
  stop_sequences?: string[];
}

/**
 * The whole prompt as one string: cached system blocks PLUS the messages tail.
 *
 * 260724 the chess prompt is deliberately split across both — the static
 * table-talk contract rides in the cached system blocks, the volatile per-turn
 * board view rides as the last user message (anything volatile in `system`
 * sits above every message in the cache prefix and makes the transcript
 * uncacheable). Tests assert on prompt CONTENT, so they read both halves and
 * stay indifferent to which side of the cache boundary a line landed on.
 */
function promptText(params: PromptParams): string {
  const sys = (params.system ?? []).map((b) => b.text).join('\n');
  const msgs = (params.messages ?? [])
    .map((m) => {
      const content = (m as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      }
      return '';
    })
    .join('\n');
  return `${sys}\n${msgs}`;
}

/**
 * The per-game session log (chessLog) closes asynchronously and endChess only
 * fires it off, so a write can still be in flight when the temp dir is removed
 * — an ENOTEMPTY that has nothing to do with the code under test. Retry briefly.
 */
async function rmTemp(target: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= 20) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chess-'));
  _setUserDataOverride(dir);
  pushed = [];
  chatPushed = [];
  summoned = false;
  initChessService({
    pushState: (s) => pushed.push(s),
    pushDownload: () => {},
    pushChatMessage: (_id, msg) => chatPushed.push(msg),
    isSummoned: () => summoned,
  });
  getCharacterSpy.mockImplementation(async () => ({
    id: CHAR,
    name: 'Marv',
    persona: { source: 'grumpy robot', expanded: 'PERSONA' },
    metadata: {},
  }));
  patchCharacterSpy.mockImplementation(async () => ({}));
  createSpy.mockReset();
  // Default LLM behavior: comment + no tools (used by reaction turns etc).
  createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'gg' }], usage: {} });
  // Presentation timing: keep idle ticks and the conversation cap out of the
  // way unless a test tightens them. (Decisions present instantly since
  // 260729 — the prethink delay is gone from the service itself.)
  CHESS_TIMING.idleMinMs = 120_000;
  CHESS_TIMING.idleMaxMs = 120_000;
  CHESS_TIMING.capMs = 45_000;
  CHESS_TIMING.capReplyCycles = 4;
});

afterEach(async () => {
  await endChess(CHAR);
  await shutdownChess();
  _setUserDataOverride(null);
  await rmTemp(dir);
});

describe('chess session lifecycle', () => {
  it('refuses to start while summoned in Minecraft', async () => {
    summoned = true;
    await expect(startChess(CHAR)).rejects.toThrow(/CHESS_MC_SESSION_ACTIVE/);
  });

  it('player move -> AI decides -> pendingAiMove -> ack commits', async () => {
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      // The move turn offers the play tool; reply with commentary + e7e5.
      if (params.tools?.some((t) => t.name === 'play')) {
        return {
          content: [
            { type: 'text', text: 'bold opening' },
            { type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    const start = await startChess(CHAR, { playerColor: 'w' });
    expect(start.status).toBe('active');
    expect(start.turn).toBe('w');

    const moved = await playerMove(CHAR, 'e2e4');
    expect(moved.ok).toBe(true);

    const pending = await waitFor(() =>
      pushed.find((s) => s.pendingAiMove?.san === 'e5') ? pushed.find((s) => s.pendingAiMove?.san === 'e5') : undefined,
    );
    expect(pending.aiThinking).toBe(true);
    // Board still shows only the player's move until the ack.
    expect(pending.fen).toContain(' b ');
    expect(pending.history).toHaveLength(1);

    const acked = await ackReveal(CHAR, pending.pendingAiMove!.uci);
    expect(acked.history.map((h) => h.san)).toEqual(['e4', 'e5']);
    expect(acked.aiThinking).toBe(false);
    expect(acked.turn).toBe('w');
  });

  it('an illegal play() gets a retry and the game never corrupts', async () => {
    let calls = 0;
    createSpy.mockImplementation(async (params: { tools?: { name: string }[]; messages?: unknown[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        calls++;
        if (calls === 1) {
          return {
            content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'Qh5' } }], // illegal for black
            usage: {},
          };
        }
        return {
          content: [
            { type: 'text', text: 'let me try that again' },
            { type: 'tool_use', id: 'tu2', name: 'play', input: { move: 'c7c5' } },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    const pending = await waitFor(() => pushed.find((s) => s.pendingAiMove !== null));
    expect(pending.pendingAiMove!.san).toBe('c5');
    expect(calls).toBe(2);
  });

  it('a chat during the hold never re-decides: the reply turn is text-only and the queued move survives a stray play()', async () => {
    const moveSystems: string[] = [];
    createSpy.mockImplementation(
      async (params: PromptParams) => {
        const sys = promptText(params);
        const msgs = JSON.stringify(params.messages);
        if (sys.includes('The moves you are considering')) {
          moveSystems.push(sys);
          return {
            content: [
              { type: 'text', text: 'watch this' },
              { type: 'tool_use', id: `mv${moveSystems.length}`, name: 'play', input: { move: 'e5' } },
            ],
            usage: {},
          };
        }
        if (sys.includes('your move is already chosen')) {
          // Second hop of the same reply turn (after the terminal refusal):
          // end with no further tools, as the note instructs.
          if (msgs.includes('does nothing on this turn')) {
            return { content: [{ type: 'text', text: 'anyway, we will see' }], usage: {} };
          }
          // The model tries to revise anyway (the old 260714 behavior).
          return {
            content: [
              { type: 'text', text: 'changed my mind' },
              { type: 'tool_use', id: 'rev1', name: 'play', input: { move: 'c7c5' } },
            ],
            usage: {},
          };
        }
        return { content: [{ type: 'text', text: 'hi back' }], usage: {} };
      },
    );

    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await waitFor(() => (pushed.some((s) => s.pendingAiMove?.san === 'e5') ? true : undefined));

    // Player chats BEFORE the ack: the reply turn is told the queued move,
    // its stray play() is refused terminally, and the move stays e5.
    const res = await handlePlayerChat({ characterId: CHAR, text: 'that is a mistake' });
    expect(res).not.toBeNull();
    expect(res!.replies.map((r) => r.text)).toContain('changed my mind');
    expect(res!.replies.map((r) => r.text)).toContain('anyway, we will see');

    // The decision ran exactly once and was never revised.
    expect(moveSystems).toHaveLength(1);
    const last = lastState();
    expect(last.pendingAiMove?.san).toBe('e5');
    expect(last.history).toHaveLength(1); // nothing committed yet
    // The reply prompt named the queued move (so the reply cannot contradict
    // it) and asked for text only.
    const replyCall = createSpy.mock.calls.find((c) =>
      promptText(c[0] as PromptParams).includes('your move is already chosen'),
    );
    expect(promptText(replyCall![0] as PromptParams)).toContain('e5');
    expect(promptText(replyCall![0] as PromptParams)).toContain('NO tool call is needed or possible');

    const acked = await ackReveal(CHAR, last.pendingAiMove!.uci);
    expect(acked.history.map((h) => h.san)).toEqual(['e4', 'e5']);
  });

  it('a silent play() is a legitimate turn: no forced table-talk hop, no chat bubbles', async () => {
    let playCalls = 0;
    createSpy.mockImplementation(async (params: PromptParams) => {
      const sys = promptText(params);
      if (sys.includes('The moves you are considering')) {
        playCalls++;
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    const pending = await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    // One LLM call; the move presents wordlessly.
    expect(playCalls).toBe(1);
    expect(chatPushed).toHaveLength(0);
    const acked = await ackReveal(CHAR, pending.pendingAiMove!.uci);
    expect(acked.history.map((h) => h.san)).toEqual(['e4', 'e5']);
  });

  it('an idle tick that answers with the "(silence)" sentinel persists and pushes nothing', async () => {
    // The live leak (260721): a quiet-table tick prompted "silence is normal"
    // and the model WROTE the placeholder instead of staying quiet; the raw
    // "(silence)" row landed in chat.jsonl and on screen. The sentinel must be
    // no message at all: no push, no history row.
    CHESS_TIMING.idleMinMs = 40;
    CHESS_TIMING.idleMaxMs = 40;
    let idleTurns = 0;
    createSpy.mockImplementation(async (params: PromptParams) => {
      const sys = promptText(params);
      if (sys.includes('Nothing has happened for about')) {
        idleTurns++;
        // Case + trailing punctuation variant, as models emit it.
        return { content: [{ type: 'text', text: '(Silence).' }], usage: {} };
      }
      return { content: [], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' }); // player to move; the AI idles
    await waitFor(() => (idleTurns >= 1 ? true : undefined));
    await new Promise((r) => setTimeout(r, 100));

    // Companion rows only: a straggling async "game unfinished" SYSTEM row
    // from the previous test's teardown can land here (pre-existing).
    expect(chatPushed.filter((m) => m.role === 'companion')).toHaveLength(0);
    const rows = await chatStore.readAll(CHAR);
    expect(rows.filter((m) => m.role === 'companion')).toHaveLength(0);
  });

  it('the move prompt states the last moves in plain words, not raw SAN history', async () => {
    const systems: string[] = [];
    createSpy.mockImplementation(async (params: PromptParams) => {
      const sys = promptText(params);
      if (sys.includes('The moves you are considering')) {
        systems.push(sys);
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    const sys = systems[0];
    // The player's move arrives translated (the hallucination fix)...
    expect(sys).toContain('Player just played: e4, pawn to e4');
    // ...raw history and the old forced-talk nudge are gone...
    expect(sys).not.toContain('Moves so far');
    expect(sys).toContain('Table talk is OPTIONAL');
    // ...and material talk is guarded against piece confabulation.
    expect(sys).toContain('never name specific pieces');
  });

  it('consecutive player messages coalesce into one reply turn', async () => {
    let replyTurns = 0;
    createSpy.mockImplementation(async (params: PromptParams) => {
      const sys = promptText(params);
      if (sys.includes("it is Player's move")) {
        replyTurns++;
        await new Promise((r) => setTimeout(r, 100)); // keep the turn in flight
        return { content: [{ type: 'text', text: 'yo' }], usage: {} };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' }); // player to move; AI is idle
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

  it('declining a player draw offer by moving clears the offer', async () => {
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        return {
          content: [
            { type: 'text', text: 'no draw. we play.' },
            { type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await offerDraw(CHAR);
    await playerMove(CHAR, 'e2e4');
    const pending = await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    expect(pending.drawOffer).toBe('player'); // still standing until the move lands
    const acked = await ackReveal(CHAR, pending.pendingAiMove!.uci);
    expect(acked.drawOffer).toBeNull(); // the move IS the decline
  });

  it("moving past the AI's draw offer declines it and the rerun prompt says so", async () => {
    const systems: string[] = [];
    let playCalls = 0;
    createSpy.mockImplementation(async (params: { tools?: { name: string }[]; system?: { text: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        playCalls++;
        systems.push(promptText(params));
        if (playCalls === 1) {
          // Offer a draw, then (same turn, next hop) play the move.
          return {
            content: [
              { type: 'text', text: 'how about a draw' },
              { type: 'tool_use', id: 'tu1', name: 'propose_draw', input: {} },
            ],
            usage: {},
          };
        }
        const move = playCalls === 2 ? 'e5' : 'Nc6';
        return {
          content: [
            { type: 'text', text: 'fine.' },
            { type: 'tool_use', id: `tu${playCalls}`, name: 'play', input: { move } },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    const pending = await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    expect(pending.drawOffer).toBe('ai');
    await ackReveal(CHAR, pending.pendingAiMove!.uci);

    // The player answers the offer by just playing on.
    const moved = await playerMove(CHAR, 'g1f3');
    expect(moved.ok).toBe(true);
    expect(moved.state.drawOffer).toBeNull();
    await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'Nc6'));
    expect(systems[systems.length - 1]).toContain('declined');
  });

  it('propose_draw accepts a standing player offer and ends the game', async () => {
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        return {
          content: [
            { type: 'text', text: 'fine, a draw' },
            { type: 'tool_use', id: 'tu', name: 'propose_draw', input: {} },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await offerDraw(CHAR);
    await playerMove(CHAR, 'e2e4');
    const ended = await waitFor(() => pushed.find((s) => s.status === 'ended'));
    expect(ended.result).toEqual({ winner: null, reason: 'draw-agreed' });
    // The draw leaves a history summary row in the transcript.
    const row = await waitFor(() => chatPushed.find((m) => m.event?.kind === 'play'));
    // 260728: every game surface writes the same sentence, results excluded.
    // See src/main/chat/playSummary.ts for why the outcome was dropped.
    expect(row.text).toBe('You and Marv played Chess for a few seconds.');
  });
});

describe('chess history summary row', () => {
  // Mirrors the watch session-end transcript row: every finished game leaves a
  // system message (event.kind 'play') whose text is the human-readable line.

  it('checkmate writes the summary row naming the winner and move count', async () => {
    let moveTurns = 0;
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        moveTurns++;
        // Fool's mate: 1. f3 e5 2. g4 Qh4#
        const move = moveTurns === 1 ? 'e5' : 'Qh4';
        return {
          content: [{ type: 'tool_use', id: `tu${moveTurns}`, name: 'play', input: { move } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'f2f3');
    const p1 = await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    await ackReveal(CHAR, p1.pendingAiMove!.uci);
    await playerMove(CHAR, 'g2g4');
    const p2 = await waitFor(() =>
      pushed.slice().reverse().find((s) => s.pendingAiMove?.san === 'Qh4#'),
    );
    const acked = await ackReveal(CHAR, p2.pendingAiMove!.uci);
    expect(acked.status).toBe('ended');
    expect(acked.result).toEqual({ winner: 'b', reason: 'checkmate' });

    const row = await waitFor(() => chatPushed.find((m) => m.event?.kind === 'play'));
    expect(row.role).toBe('system');
    expect(row.event).toEqual({
      kind: 'play',
      game: 'Chess',
      durationMs: expect.any(Number),
      // Replay payload (260724): the recorded moves let the renderer rebuild
      // and scrub the finished game from the transcript row.
      chess: {
        moves: [
          { san: 'f3', uci: 'f2f3' },
          { san: 'e5', uci: 'e7e5' },
          { san: 'g4', uci: 'g2g4' },
          { san: 'Qh4#', uci: 'd8h4' },
        ],
        playerColor: 'w',
        result: { winner: 'b', reason: 'checkmate' },
        aiElo: expect.any(Number),
      },
    });
    expect(row.text).toBe('You and Marv played Chess for a few seconds.');
  });

  it('player resign writes the summary row with the companion as winner', async () => {
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    const pending = await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    await ackReveal(CHAR, pending.pendingAiMove!.uci);

    const resigned = await resign(CHAR);
    expect(resigned.result).toEqual({ winner: 'b', reason: 'resign' });

    const row = await waitFor(() => chatPushed.find((m) => m.event?.kind === 'play'));
    expect(row.text).toBe('You and Marv played Chess for a few seconds.');
  });

  it('closing an in-progress game writes the unfinished row; a moveless close leaves none', async () => {
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    // No moves played: closing leaves no transcript row at all.
    await startChess(CHAR, { playerColor: 'w' });
    await endChess(CHAR);
    await new Promise((r) => setTimeout(r, 50));
    expect(chatPushed.filter((m) => m.event?.kind === 'play')).toHaveLength(0);

    // Moves on the board: closing records the unfinished game.
    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    await endChess(CHAR);
    const row = await waitFor(() => chatPushed.find((m) => m.event?.kind === 'play'));
    expect(row.text).toBe('You and Marv left a chess game unfinished.');
  });

  it('app shutdown mid-game records the unfinished game', async () => {
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    await shutdownChess();
    const row = await waitFor(() => chatPushed.find((m) => m.event?.kind === 'play'));
    expect(row.text).toBe('You and Marv left a chess game unfinished.');
  });

  it('a moveless game WITH table talk still records the unfinished row (stale-context fix)', async () => {
    // 260722: a 0-move abandoned game used to leave no transcript marker even
    // when chat happened during it, so later plain-chat turns read the stale
    // game talk as a live game ("the board's still waiting").
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'hi back' }], usage: {} });
    await startChess(CHAR, { playerColor: 'w' });
    const r = await handlePlayerChat({ characterId: CHAR, text: 'hey marv' });
    expect(r!.replies.map((m) => m.text)).toContain('hi back');
    await endChess(CHAR);
    const row = await waitFor(() => chatPushed.find((m) => m.event?.kind === 'play'));
    expect(row.text).toBe('You and Marv left a chess game unfinished.');
  });
});

describe('prompt truth and pacing (260722 commentary fixes)', () => {
  it('every chess prompt carries the table-talk contract (no move narration, spoken-aloud rule)', async () => {
    const systems: string[] = [];
    createSpy.mockImplementation(async (params: PromptParams) => {
      const sys = promptText(params);
      if (sys.includes('# CHESS GAME')) systems.push(sys);
      if (sys.includes('The moves you are considering')) {
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'yo' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await handlePlayerChat({ characterId: CHAR, text: 'ready?' }); // chat-reply prompt
    await playerMove(CHAR, 'e2e4'); // move prompt
    await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    expect(systems.length).toBeGreaterThanOrEqual(2);
    for (const sys of systems) {
      expect(sys).toContain('NEVER SAY COORDINATES OR NOTATION');
      expect(sys).toContain('Do not announce the move you are about to play');
      expect(sys).toContain('SPOKEN OUT LOUD');
      // Chess talk itself is WANTED (260724): the old contract banned plans,
      // piece talk and analysis on top of notation, which left mood-only filler.
      expect(sys).toContain('TALK ABOUT THE CHESS');
    }
    // The move prompt additionally forbids revealing the picked move.
    const moveSys = systems.find((t) => t.includes('The moves you are considering'))!;
    expect(moveSys).toContain('Never reveal or describe the move you are about to play');
  });

  it('every chess LLM request pins transcript stop sequences and the own-lines-only rule (260722 TTS prompt leak)', async () => {
    // Live capture (260722, voice call): a chat-reply turn kept generating past
    // Lyra's own lines — a fabricated player turn ("Human: [22 Jul 11:32]
    // *plays Nc6*") followed by an invented game direction "(Lyra, it is now
    // your turn to move...)" — and speak() persisted and TTS'd the whole
    // continuation as her voice. The fix is structural, not an output scrub:
    // stop_sequences end generation the instant the model starts writing the
    // other side of the transcript, and the table-talk contract forbids
    // writing anyone else's lines or turn directions in the first place.
    const reqs: PromptParams[] = [];
    createSpy.mockImplementation(
      async (params: PromptParams) => {
        reqs.push(params);
        const sys = promptText(params);
        if (sys.includes('The moves you are considering')) {
          return {
            content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } }],
            usage: {},
          };
        }
        return { content: [{ type: 'text', text: 'yo' }], usage: {} };
      },
    );

    await startChess(CHAR, { playerColor: 'w' });
    await handlePlayerChat({ characterId: CHAR, text: 'good move' }); // chat-reply turn
    await playerMove(CHAR, 'e2e4'); // move turn
    await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));

    expect(reqs.length).toBeGreaterThanOrEqual(2);
    for (const req of reqs) {
      // The request may never let the model write the player's next turn or
      // the app's own nudge convention.
      expect(req.stop_sequences).toEqual(
        expect.arrayContaining(['\nHuman:', '\nPlayer:', '\n(game)']),
      );
      const sys = promptText(req);
      expect(sys).toContain('Write ONLY your own lines');
      expect(sys).toContain('never "Human:" / "Player:" lines');
    }
  });

  it('a stray wait() on a reply turn gets the terminal refusal and never touches the queued move', async () => {
    // 260730: wait() is no longer a tool at all. A model that recalls it from
    // an older game hits the unknown-tool fallthrough, which must read as
    // FINAL (the live "not available right now" wording read as transient and
    // produced retry loops) and must leave the presented move in place.
    const notes: string[] = [];
    createSpy.mockImplementation(
      async (params: PromptParams) => {
        const sys = promptText(params);
        const msgs = JSON.stringify(params.messages);
        if (sys.includes('The moves you are considering')) {
          return {
            content: [{ type: 'tool_use', id: 'mv1', name: 'play', input: { move: 'e5' } }],
            usage: {},
          };
        }
        if (sys.includes('your move is already chosen')) {
          if (msgs.includes('does nothing on this turn')) {
            notes.push(msgs);
            return { content: [], usage: {} };
          }
          return {
            content: [{ type: 'tool_use', id: 'w1', name: 'wait', input: {} }],
            usage: {},
          };
        }
        return { content: [{ type: 'text', text: 'hi back' }], usage: {} };
      },
    );

    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await waitFor(() => (pushed.some((s) => s.pendingAiMove?.san === 'e5') ? true : undefined));
    await handlePlayerChat({ characterId: CHAR, text: 'wait, dont move yet' });
    // The refusal reached the model, was terminal, and the move never retracted.
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('Do not call it again');
    const last = lastState();
    expect(last.pendingAiMove?.san).toBe('e5');
    const acked = await ackReveal(CHAR, last.pendingAiMove!.uci);
    expect(acked.history.map((h) => h.san)).toEqual(['e4', 'e5']);
  });

  it('a decided move presents immediately: no artificial delay after the decision', async () => {
    // 260729: the sampled prethink delay is gone; the only wait the player
    // sees is the real engine + LLM latency.
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    const pending = await waitFor(
      () => pushed.find((s) => s.pendingAiMove?.san === 'e5'),
      2_000,
    );
    expect(pending.pendingAiMove!.san).toBe('e5');
  });
});

describe('continuity, caching and the coordinate ban (260724)', () => {
  /** Drive a short real game so there is a move record to inspect. */
  async function playOpening(): Promise<PromptParams[]> {
    const reqs: PromptParams[] = [];
    createSpy.mockImplementation(async (params: PromptParams) => {
      reqs.push(params);
      const p = promptText(params);
      if (p.includes('The moves you are considering')) {
        // Pick whatever the mock engine offered first for this position.
        const m = /^1\. (\S+):/m.exec(p.slice(p.indexOf('The moves you are considering')));
        return {
          content: [{ type: 'tool_use', id: `t${reqs.length}`, name: 'play', input: { move: m![1] } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'yo' }], usage: {} };
    });
    const start = await startChess(CHAR, { playerColor: 'w' });
    let fen = start.fen;
    // Three full moves, each picked from what is actually legal now — the mock
    // engine answers with the first legal move, which can block a fixed script.
    for (let i = 0; i < 3; i++) {
      const legal = new Chess(fen).moves({ verbose: true })[0];
      const seen = pushed.length; // only look at states pushed AFTER this move
      const r = await playerMove(CHAR, legal.from + legal.to + (legal.promotion ?? ''));
      expect(r.ok).toBe(true);
      const p = await waitFor(() => pushed.slice(seen).find((s) => s.pendingAiMove));
      const acked = await ackReveal(CHAR, p.pendingAiMove!.uci);
      fen = acked.fen;
    }
    return reqs;
  }

  it('carries the whole game as one conversation: every ply and the moves she also considered', async () => {
    const reqs = await playOpening();
    // One more turn so the thread has caught up with the last committed ply
    // (a move turn is built before its own move lands), and so this also covers
    // a chat-reply turn carrying the full record.
    await handlePlayerChat({ characterId: CHAR, text: 'how are we doing' });
    const last = promptText(reqs[reqs.length - 1]);
    // Move 1 is still visible at move 4 — the old prompt kept a 2-ply keyhole.
    expect(last).toContain('(game) Move 1: they played');
    expect(last).toContain('(game) Move 2: they played');
    expect(last).toContain('(game) Move 3: they played');
    // Every committed ply is in there, both sides, in order.
    const recorded = [...last.matchAll(/\(game\) Move \d+: (you|they) played/g)];
    expect(recorded).toHaveLength(lastState().history.length);
    // Her own plies carry the alternatives she passed over, so a later turn can
    // answer "why didn't you take with the other knight" instead of guessing.
    expect(last).toMatch(/\(game\) Move 1: you played .*\(you were also considering /);
  });

  it('puts the cache breakpoint before the volatile turn block, never inside system', async () => {
    const reqs = await playOpening();
    for (const req of reqs) {
      // Nothing volatile may live in `system`: it sits above every message in
      // the cache prefix and would make the whole transcript uncacheable.
      const sys = (req.system ?? []).map((b) => b.text).join('\n');
      expect(sys).toContain('# CHESS GAME'); // the STATIC contract does live there
      expect(sys).not.toContain('The moves you are considering');
      expect(sys).not.toContain('Game state:');

      // The last message is the volatile turn block and carries NO breakpoint;
      // the breakpoint sits on an earlier, byte-stable message.
      const msgs = (req.messages ?? []) as Array<{ content: unknown }>;
      const marked = msgs.filter((m) =>
        Array.isArray(m.content) &&
        (m.content as Array<{ cache_control?: unknown }>).some((b) => b.cache_control),
      );
      expect(marked.length).toBeLessThanOrEqual(1);
      if (marked.length === 1) expect(marked[0]).not.toBe(msgs[msgs.length - 1]);
    }
  });

  it('offers an identical tool array on every turn kind (tools head the cache prefix)', async () => {
    const reqs = await playOpening();
    await handlePlayerChat({ characterId: CHAR, text: 'nice one' });
    const shapes = new Set(reqs.map((r) => (r.tools ?? []).map((t) => t.name).join(',')));
    expect(shapes.size).toBe(1);
    expect([...shapes][0]).toContain('play');
    // 260730: wait() is gone (reply turns are text-only).
    expect([...shapes][0]).not.toContain('wait');
  });

  it('drops a spoken line containing a square or notation, and keeps ordinary chess talk', async () => {
    createSpy.mockImplementation(async (params: PromptParams) => {
      const p = promptText(params);
      if (p.includes('The moves you are considering')) {
        return {
          content: [
            { type: 'text', text: 'i think i have to play exd5 here' },
            { type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'your knight has been annoying me all game' }], usage: {} };
    });
    await startChess(CHAR, { playerColor: 'w' });
    await handlePlayerChat({ characterId: CHAR, text: 'hey' });
    await playerMove(CHAR, 'e2e4');
    const p = await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    await ackReveal(CHAR, p.pendingAiMove!.uci);

    const said = chatPushed.map((m) => m.text);
    // Notation is thrown away rather than mangled...
    expect(said).not.toContain('i think i have to play exd5 here');
    // ...but chess talk in plain words is exactly what the contract asks for.
    expect(said).toContain('your knight has been annoying me all game');
  });

  it('caps a turn at a couple of bubbles even when the model writes five', async () => {
    createSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'one\ntwo\nthree\nfour\nfive' }],
      usage: {},
    });
    await startChess(CHAR, { playerColor: 'w' });
    await handlePlayerChat({ characterId: CHAR, text: 'hey' });
    expect(chatPushed.length).toBeLessThanOrEqual(3);
  });
});

describe('hasChessCoordinates', () => {
  it('catches squares, notation and castling', () => {
    for (const t of [
      'e4', 'i think i have to play exd5 here', 'Nf3 was a mistake', 'Qxd5+ and you are done',
      'O-O then', '0-0-0 lol', 'the pawn on d5 is dead', 'Rae1', 'e8=Q#',
    ]) {
      expect(hasChessCoordinates(t), t).toBe(true);
    }
  });

  it('leaves ordinary chess talk alone', () => {
    for (const t of [
      'your knight has been annoying me all game',
      'i think im getting squeezed here',
      'you really just gave me that rook',
      'that bishop has been staring at me the whole time',
      'this is going badly for me and i know it',
      'nehehe',
      'the pawn in front of your king is lonely',
      'ok wait how does castling work again',
    ]) {
      expect(hasChessCoordinates(t), t).toBe(false);
    }
  });
});
