/**
 * Connect 4 service state machine — CLONED from chessService.test.ts, the
 * parts most likely to corrupt a game:
 *   - the AI move enters the presentation hold, presents as pendingAiMove
 *     after prethink, and only commits on ackReveal (the renderer quiet gate)
 *   - an illegal play() gets a retry tool_result, not a broken board
 *   - a player chat during the hold NEVER re-decides: the reply turn knows
 *     the queued move and may revise it (play) or hold it back (wait)
 *   - a silent play() is a legitimate turn (no forced table-talk hop)
 *   - consecutive player messages coalesce into one reply turn
 *   - the move prompt states the player's last move in plain words
 *   - four in a row / forfeit end the game with the right result
 *   - a summoned character cannot start a game (mutual exclusion)
 *   - the character moves first when the player takes yellow
 * The LLM and profile derivation are mocked; the board (rules.ts), the
 * engine, the session FSM queue, and the hold are real. C4_TIMING is
 * zeroed/stretched so turns present instantly and idle ticks never fire
 * mid-test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';
import type { C4GameState } from '../../shared/connect4Ipc';

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
vi.mock('./connect4Profile', () => ({
  getOrCreateConnect4Profile: vi.fn(async () => ({ strength: 3, styleNote: 'testy', source: 'auto' })),
}));

import {
  initConnect4Service,
  startConnect4,
  playerMove,
  ackReveal,
  handlePlayerChat,
  endConnect4,
  shutdownConnect4,
  C4_TIMING,
} from './connect4Service';

const CHAR = '77777777-7777-4777-8777-777777777777';
let dir: string;
let pushed: C4GameState[];
let chatPushed: { text: string }[];
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

/** Standard move-turn mock: table talk + drop in `column` (1-based). */
function playMock(column: number, talk?: string) {
  return async (params: { tools?: { name: string }[] }) => {
    if (params.tools?.some((t) => t.name === 'play')) {
      return {
        content: [
          ...(talk ? [{ type: 'text', text: talk }] : []),
          { type: 'tool_use', id: `tu-${Math.random()}`, name: 'play', input: { column } },
        ],
        usage: {},
      };
    }
    return { content: [{ type: 'text', text: 'gg' }], usage: {} };
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-c4-'));
  _setUserDataOverride(dir);
  pushed = [];
  chatPushed = [];
  summoned = false;
  initConnect4Service({
    pushState: (s) => pushed.push(s),
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
  C4_TIMING.prethinkFloorMs = 0;
  C4_TIMING.prethinkCapMs = 0;
  C4_TIMING.obviousExtraMs = 0;
  C4_TIMING.idleMinMs = 120_000;
  C4_TIMING.idleMaxMs = 120_000;
  C4_TIMING.capMs = 45_000;
  C4_TIMING.capReplyCycles = 4;
});

afterEach(async () => {
  await endConnect4(CHAR);
  await shutdownConnect4();
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

describe('connect4 session lifecycle', () => {
  it('refuses to start while summoned in Minecraft', async () => {
    summoned = true;
    await expect(startConnect4(CHAR)).rejects.toThrow(/CONNECT4_MC_SESSION_ACTIVE/);
  });

  it('player drop -> AI decides -> pendingAiMove -> ack commits', async () => {
    createSpy.mockImplementation(playMock(1, 'bold opening'));

    const start = await startConnect4(CHAR, { playerColor: 'r' });
    expect(start.status).toBe('active');
    expect(start.turn).toBe('r');

    const moved = await playerMove(CHAR, 3);
    expect(moved.ok).toBe(true);
    expect(moved.state.board[0][3]).toBe('r');

    const pending = await waitFor(() => pushed.find((s) => s.pendingAiMove?.col === 0));
    expect(pending.aiThinking).toBe(true);
    // Board still shows only the player's move until the ack.
    expect(pending.history).toHaveLength(1);
    expect(pending.board[0][0]).toBeNull();

    const acked = await ackReveal(CHAR, 0);
    expect(acked.history.map((h) => h.col)).toEqual([3, 0]);
    expect(acked.board[0][0]).toBe('y');
    expect(acked.aiThinking).toBe(false);
    expect(acked.turn).toBe('r');
  });

  it('the character moves first when the player takes yellow', async () => {
    createSpy.mockImplementation(playMock(4));
    const start = await startConnect4(CHAR, { playerColor: 'y' });
    expect(start.turn).toBe('r'); // red = the character
    const pending = await waitFor(() => pushed.find((s) => s.pendingAiMove?.col === 3));
    const acked = await ackReveal(CHAR, pending.pendingAiMove!.col);
    expect(acked.board[0][3]).toBe('r');
    expect(acked.turn).toBe('y');
  });

  it('an illegal play() gets a retry and the game never corrupts', async () => {
    let calls = 0;
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        calls++;
        if (calls === 1) {
          return {
            content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { column: 99 } }],
            usage: {},
          };
        }
        return {
          content: [
            { type: 'text', text: 'let me try that again' },
            { type: 'tool_use', id: 'tu2', name: 'play', input: { column: 2 } },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startConnect4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    const pending = await waitFor(() => pushed.find((s) => s.pendingAiMove !== null));
    expect(pending.pendingAiMove!.col).toBe(1);
    expect(calls).toBe(2);
  });

  it('rejects a player drop into a full column', async () => {
    createSpy.mockImplementation(playMock(1));
    await startConnect4(CHAR, { playerColor: 'r' });
    // Fill column 6: player + acked AI drops would be slow; instead drop out
    // of range and into legality edges.
    const bad = await playerMove(CHAR, 9);
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('column full');
  });

  it('a chat during the hold never re-decides: the reply turn revises the queued move via play()', async () => {
    const moveSystems: string[] = [];
    createSpy.mockImplementation(
      async (params: { system?: { text: string }[]; messages?: unknown[] }) => {
        const sys = (params.system ?? []).map((b) => b.text).join('\n');
        if (sys.includes('The columns you are considering')) {
          moveSystems.push(sys);
          return {
            content: [
              { type: 'text', text: 'watch this' },
              { type: 'tool_use', id: `mv${moveSystems.length}`, name: 'play', input: { column: 1 } },
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
              { type: 'tool_use', id: 'rev1', name: 'play', input: { column: 5 } },
            ],
            usage: {},
          };
        }
        return { content: [{ type: 'text', text: 'hi back' }], usage: {} };
      },
    );

    await startConnect4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    await waitFor(() => (pushed.some((s) => s.pendingAiMove?.col === 0) ? true : undefined));

    // Player chats BEFORE the ack: the reply turn sees the queued move and
    // updates it in place. No rollback, no rerun.
    const res = await handlePlayerChat({ characterId: CHAR, text: 'that is a mistake' });
    expect(res).not.toBeNull();
    expect(res!.replies.map((r) => r.text)).toContain('changed my mind');

    const revised = await waitFor(() =>
      pushed.slice().reverse().find((s) => s.pendingAiMove?.col === 4),
    );
    expect(revised.history).toHaveLength(1); // nothing committed yet
    // The decision ran exactly once; the revision rode the reply turn.
    expect(moveSystems).toHaveLength(1);
    // The reply prompt named the queued move (column 1, 1-based).
    const replyCall = createSpy.mock.calls.find((c) =>
      JSON.stringify((c[0] as { system: unknown }).system).includes('already decided your move'),
    );
    expect(JSON.stringify((replyCall![0] as { system: unknown }).system)).toContain('column 1');

    const acked = await ackReveal(CHAR, 4);
    expect(acked.history.map((h) => h.col)).toEqual([3, 4]);
  });

  it('wait() holds the move back (pendingAiMove retracts) until a later play() releases it', async () => {
    createSpy.mockImplementation(
      async (params: { system?: { text: string }[]; messages?: unknown[] }) => {
        const sys = (params.system ?? []).map((b) => b.text).join('\n');
        const msgs = JSON.stringify(params.messages);
        if (sys.includes('The columns you are considering')) {
          return {
            content: [{ type: 'tool_use', id: 'mv1', name: 'play', input: { column: 1 } }],
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
              { type: 'tool_use', id: 'rel1', name: 'play', input: { column: 1 } },
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

    await startConnect4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    await waitFor(() => (pushed.some((s) => s.pendingAiMove?.col === 0) ? true : undefined));

    // "don't move yet" → wait(): the published move retracts, nothing commits.
    const r1 = await handlePlayerChat({ characterId: CHAR, text: 'wait, dont move yet' });
    expect(r1!.replies.map((r) => r.text)).toContain('fine, i will wait');
    const retracted = await waitFor(() => {
      const last = pushed[pushed.length - 1];
      return last.pendingAiMove === null && last.history.length === 1 ? last : undefined;
    });
    expect(retracted.aiThinking).toBe(true); // still its turn, still pondering

    // A stale ack for the retracted move must be ignored.
    const staleAck = await ackReveal(CHAR, 0);
    expect(staleAck.history).toHaveLength(1);

    // "ok go" → the reply turn releases with play(); the move re-presents.
    const r2 = await handlePlayerChat({ characterId: CHAR, text: 'ok go' });
    expect(r2!.replies.map((r) => r.text)).toContain('alright, now i move');
    const back = await waitFor(() =>
      pushed.slice().reverse().find((s) => s.pendingAiMove?.col === 0),
    );
    const acked = await ackReveal(CHAR, back.pendingAiMove!.col);
    expect(acked.history.map((h) => h.col)).toEqual([3, 0]);
  });

  it('a silent play() is a legitimate turn: no forced table-talk hop, no chat bubbles', async () => {
    let playCalls = 0;
    createSpy.mockImplementation(async (params: { system?: { text: string }[] }) => {
      const sys = (params.system ?? []).map((b) => b.text).join('\n');
      if (sys.includes('The columns you are considering')) {
        playCalls++;
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { column: 1 } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startConnect4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    const pending = await waitFor(() => pushed.find((s) => s.pendingAiMove?.col === 0));
    // One LLM call; the move presents wordlessly.
    expect(playCalls).toBe(1);
    expect(chatPushed).toHaveLength(0);
    const acked = await ackReveal(CHAR, pending.pendingAiMove!.col);
    expect(acked.history.map((h) => h.col)).toEqual([3, 0]);
  });

  it('the move prompt states the last move in plain words, never a grid dump', async () => {
    const systems: string[] = [];
    createSpy.mockImplementation(async (params: { system?: { text: string }[] }) => {
      const sys = (params.system ?? []).map((b) => b.text).join('\n');
      if (sys.includes('The columns you are considering')) {
        systems.push(sys);
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { column: 1 } }],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startConnect4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    await waitFor(() => pushed.find((s) => s.pendingAiMove?.col === 0));
    const sys = systems[0];
    // The player's move arrives translated (the hallucination fix)...
    expect(sys).toContain('Player just played: dropped in column 4, the center, on the floor');
    // ...no raw board serialization anywhere...
    expect(sys).not.toMatch(/\[\[|null|"board"/);
    // ...and the optional-talk contract is stated.
    expect(sys).toContain('Table talk is OPTIONAL');
    expect(sys).toContain('never dump grids');
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

    await startConnect4(CHAR, { playerColor: 'r' }); // player to move; AI is idle
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

  it('four in a row ends the game with the winning line', async () => {
    // AI stacks col 7 (harmless); player stacks col 1 to a vertical four.
    createSpy.mockImplementation(playMock(7));
    await startConnect4(CHAR, { playerColor: 'r' });
    for (let i = 0; i < 3; i++) {
      const moved = await playerMove(CHAR, 0);
      expect(moved.ok).toBe(true);
      const pending = await waitFor(() =>
        pushed.slice().reverse().find((s) => s.pendingAiMove !== null && s.history.length === i * 2 + 1),
      );
      await ackReveal(CHAR, pending.pendingAiMove!.col);
    }
    const winning = await playerMove(CHAR, 0);
    expect(winning.ok).toBe(true);
    const ended = await waitFor(() => pushed.find((s) => s.status === 'ended'));
    expect(ended.result?.winner).toBe('r');
    expect(ended.result?.reason).toBe('connect');
    expect(ended.result?.line).toHaveLength(4);
    expect(ended.result?.line?.every((c) => c.col === 0)).toBe(true);
  });

  it('forfeit ends the game in the player’s favor', async () => {
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'forfeit')) {
        return {
          content: [
            { type: 'text', text: 'i quit' },
            { type: 'tool_use', id: 'tu1', name: 'forfeit', input: {} },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });

    await startConnect4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    const ended = await waitFor(() => pushed.find((s) => s.status === 'ended'));
    expect(ended.result).toMatchObject({ winner: 'r', reason: 'forfeit' });
  });
});
