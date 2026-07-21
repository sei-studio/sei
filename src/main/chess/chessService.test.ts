/**
 * Chess service state machine — the parts most likely to corrupt a game:
 *   - the AI move enters the presentation hold, presents as pendingAiMove
 *     after prethink, and only commits on ackReveal (the renderer quiet gate)
 *   - an illegal play() gets a retry tool_result, not a broken board
 *   - a player chat during the hold NEVER re-decides: the reply turn knows
 *     the queued move and may revise it (play) or hold it back (wait)
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
  handlePlayerChat,
  endChess,
  shutdownChess,
  CHESS_TIMING,
} from './chessService';

const CHAR = '66666666-6666-4666-8666-666666666666';
let dir: string;
let pushed: ChessGameState[];
let chatPushed: { text: string }[];
let summoned: boolean;

function lastState(): ChessGameState {
  return pushed[pushed.length - 1];
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
    pushChatMessage: (_id, msg) => chatPushed.push(msg as { text: string }),
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
  // Presentation timing: present decisions instantly, keep idle ticks and the
  // conversation cap out of the way unless a test tightens them.
  CHESS_TIMING.prethinkFloorMs = 0;
  CHESS_TIMING.prethinkCapMs = 0;
  CHESS_TIMING.obviousExtraMs = 0;
  CHESS_TIMING.idleMinMs = 120_000;
  CHESS_TIMING.idleMaxMs = 120_000;
  CHESS_TIMING.capMs = 45_000;
  CHESS_TIMING.capReplyCycles = 4;
});

afterEach(async () => {
  await endChess(CHAR);
  await shutdownChess();
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
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

  it('a chat during the hold never re-decides: the reply turn revises the queued move via play()', async () => {
    const moveSystems: string[] = [];
    createSpy.mockImplementation(
      async (params: { system?: { text: string }[]; messages?: unknown[] }) => {
        const sys = (params.system ?? []).map((b) => b.text).join('\n');
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
        if (sys.includes('already decided your move')) {
          // Second hop of the same reply turn (after the revision tool_result):
          // end with no further tools.
          if (JSON.stringify(params.messages).includes('queued move is now')) {
            return { content: [], usage: {} };
          }
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

    // Player chats BEFORE the ack: the reply turn sees the queued move and
    // updates it in place. No rollback, no rerun.
    const res = await handlePlayerChat({ characterId: CHAR, text: 'that is a mistake' });
    expect(res).not.toBeNull();
    expect(res!.replies.map((r) => r.text)).toContain('changed my mind');

    const revised = await waitFor(() =>
      pushed.slice().reverse().find((s) => s.pendingAiMove?.san === 'c5'),
    );
    expect(revised.history).toHaveLength(1); // nothing committed yet
    // The decision ran exactly once; the revision rode the reply turn.
    expect(moveSystems).toHaveLength(1);
    // The reply prompt named the queued move.
    const replyCall = createSpy.mock.calls.find((c) =>
      JSON.stringify((c[0] as { system: unknown }).system).includes('already decided your move'),
    );
    expect(JSON.stringify((replyCall![0] as { system: unknown }).system)).toContain('e5');

    const acked = await ackReveal(CHAR, revised.pendingAiMove!.uci);
    expect(acked.history.map((h) => h.san)).toEqual(['e4', 'c5']);
  });

  it('wait() holds the move back (pendingAiMove retracts) until a later play() releases it', async () => {
    createSpy.mockImplementation(
      async (params: { system?: { text: string }[]; messages?: unknown[] }) => {
        const sys = (params.system ?? []).map((b) => b.text).join('\n');
        const msgs = JSON.stringify(params.messages);
        if (sys.includes('The moves you are considering')) {
          return {
            content: [{ type: 'tool_use', id: 'mv1', name: 'play', input: { move: 'e5' } }],
            usage: {},
          };
        }
        if (sys.includes('HOLDING it back')) {
          if (msgs.includes('It lands once this exchange goes quiet')) {
            return { content: [], usage: {} };
          }
          return {
            content: [
              { type: 'text', text: 'alright, now i move' },
              { type: 'tool_use', id: 'rel1', name: 'play', input: { move: 'e5' } },
            ],
            usage: {},
          };
        }
        if (sys.includes('already decided your move')) {
          if (msgs.includes('You hold')) {
            return { content: [], usage: {} };
          }
          return {
            content: [
              { type: 'text', text: 'fine, i will wait' },
              { type: 'tool_use', id: 'w1', name: 'wait', input: {} },
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

    // "don't move yet" → wait(): the published move retracts, nothing commits.
    const r1 = await handlePlayerChat({ characterId: CHAR, text: 'wait, dont move yet' });
    expect(r1!.replies.map((r) => r.text)).toContain('fine, i will wait');
    const retracted = await waitFor(() => {
      const last = pushed[pushed.length - 1];
      return last.pendingAiMove === null && last.history.length === 1 ? last : undefined;
    });
    expect(retracted.aiThinking).toBe(true); // still its turn, still pondering

    // A stale ack for the retracted move must be ignored.
    const staleAck = await ackReveal(CHAR, 'e7e5');
    expect(staleAck.history).toHaveLength(1);

    // "ok go" → the reply turn releases with play(); the move re-presents.
    const r2 = await handlePlayerChat({ characterId: CHAR, text: 'ok go' });
    expect(r2!.replies.map((r) => r.text)).toContain('alright, now i move');
    const back = await waitFor(() =>
      pushed.slice().reverse().find((s) => s.pendingAiMove?.san === 'e5'),
    );
    const acked = await ackReveal(CHAR, back.pendingAiMove!.uci);
    expect(acked.history.map((h) => h.san)).toEqual(['e4', 'e5']);
  });

  it('a silent play() is a legitimate turn: no forced table-talk hop, no chat bubbles', async () => {
    let playCalls = 0;
    createSpy.mockImplementation(async (params: { system?: { text: string }[] }) => {
      const sys = (params.system ?? []).map((b) => b.text).join('\n');
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

  it('the move prompt states the last moves in plain words, not raw SAN history', async () => {
    const systems: string[] = [];
    createSpy.mockImplementation(async (params: { system?: { text: string }[] }) => {
      const sys = (params.system ?? []).map((b) => b.text).join('\n');
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
    createSpy.mockImplementation(async (params: { system?: { text: string }[] }) => {
      const sys = (params.system ?? []).map((b) => b.text).join('\n');
      if (sys.includes("It is Player's move")) {
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
        systems.push((params.system ?? []).map((b) => b.text).join('\n'));
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
  });
});
