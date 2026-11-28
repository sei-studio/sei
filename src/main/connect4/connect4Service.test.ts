/**
 * Four in a Row service (261127): the character plays its own moves.
 *
 * Real board, real fsm.js queue, real board-turn runner (persona prompt,
 * thread, tool_result blocks), real chat store in a temp profile. Only the
 * provider is scripted (the service's test seam), plus the character/config
 * reads, analytics and the usage-limit popup.
 *
 * What is pinned:
 *   - rules: drop, four in a row in every direction, full column;
 *   - the character's column comes ONLY from its play() call: a rejected
 *     column goes back as an is_error tool_result, a turn without a legal
 *     move is retried and then stops in aiTurnFailed. No engine move, ever;
 *   - Try again runs the turn again;
 *   - fatal errors (auth) stop after one attempt;
 *   - a stale turn (game ended under it) never lands a move;
 *   - table talk is the move tool's say field and lands with the move, never
 *     without it; plain text on a move turn is private;
 *   - analytics shape (engine_moves always 0).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';
import { drainScopedWrites } from '../profile/scopeBarrier';
import type { ChatMessage } from '../../shared/ipc';
import type { CONNECT4GameState } from '../../shared/connect4Ipc';
import type { LlmCallParams, LlmProvider, LlmResult } from '../llm/types';

const { getCharacterSpy, popupSpy, captureSpy, foldSpy } = vi.hoisted(() => ({
  getCharacterSpy: vi.fn(),
  popupSpy: vi.fn(),
  captureSpy: vi.fn(),
  foldSpy: vi.fn(),
}));
vi.mock('../characterStore', () => ({ getCharacter: getCharacterSpy }));
vi.mock('../configStore', () => ({ loadConfig: vi.fn(async () => ({ preferred_name: 'Player' })) }));
vi.mock('../chat/usageLimit', () => ({ raiseUsageLimitPopup: popupSpy }));
vi.mock('../analytics', () => ({
  capture: captureSpy,
  captureSurfaceError: vi.fn(),
  surfaceErrorClass: () => 'unknown',
}));
vi.mock('../chat/continuity', async (orig) => ({
  ...(await orig<typeof import('../chat/continuity')>()),
  foldIfDue: foldSpy,
}));

import {
  initCONNECT4Service,
  startCONNECT4,
  playerMove,
  retryAiTurn,
  resign,
  rematch,
  endCONNECT4,
  handlePlayerChat,
  getCONNECT4State,
  isWinningPiece,
  winningLineText,
  dropRow,
  linesText,
  fourChancesText,
  connect4ChatFacts,
  __setConnect4TestHooks,
  __resetConnect4ForTests,
} from './connect4Service';
import { loadConfig } from '../configStore';

const CHAR = '44444444-4444-4444-8444-444444444444';
let dir: string;
let pushed: CONNECT4GameState[];
let chatPushed: ChatMessage[];
let calls: LlmCallParams[];
type FakeReply = { content: Array<Record<string, unknown>> };
type Reply = (p: LlmCallParams, i: number) => Promise<FakeReply> | FakeReply;
let reply: Reply;

function toolUse(name: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2, 8)}`) {
  return { type: 'tool_use' as const, id, name, input };
}
function text(t: string) {
  return { type: 'text' as const, text: t, citations: null };
}

const provider: LlmProvider = {
  kind: 'anthropic',
  model: 'test-model',
  backend: 'local' as LlmProvider['backend'],
  vision: 'no' as unknown as LlmProvider['vision'],
  streaming: false,
  async call(params) {
    // Snapshot: the runner keeps mutating its messages array.
    calls.push(JSON.parse(JSON.stringify(params)));
    const r = await reply(params, calls.length - 1);
    return {
      content: r.content,
      toolUses: [],
      text: '',
      usage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'end_turn',
    } as unknown as LlmResult;
  },
};

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const state = (): CONNECT4GameState => getCONNECT4State(CHAR)!;
const aiPieces = (s: CONNECT4GameState): number =>
  s.board.flat().filter((c) => c !== null && c !== s.playerColor).length;
const events = (name: string): Array<Record<string, unknown>> =>
  captureSpy.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, unknown>);

/** Every tool_use in a request is answered by a tool_result in the next message. */
function assertToolResultsPaired(p: LlmCallParams): void {
  const msgs = p.messages as Array<{ role: string; content: unknown }>;
  msgs.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    const ids = (m.content as Array<{ type: string; id?: string }>).filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (!ids.length) return;
    const next = msgs[i + 1];
    expect(next?.role).toBe('user');
    expect(Array.isArray(next?.content)).toBe(true);
    const resultIds = (next!.content as Array<{ type: string; tool_use_id?: string }>)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id);
    expect(resultIds).toEqual(ids);
  });
}

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

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-c4-'));
  _setUserDataOverride(dir);
  pushed = [];
  chatPushed = [];
  calls = [];
  initCONNECT4Service({
    pushState: (s) => pushed.push(s),
    pushChatMessage: (_id, m) => chatPushed.push(m),
    isSummoned: () => false,
  });
  __setConnect4TestHooks({ provider, sleep: async () => {} });
  getCharacterSpy.mockImplementation(async () => ({
    id: CHAR,
    name: 'Sui',
    persona: { source: 'teasing', expanded: 'PERSONA' },
    metadata: {},
  }));
  popupSpy.mockReset();
  popupSpy.mockImplementation(async () => null);
  captureSpy.mockReset();
  foldSpy.mockReset();
  foldSpy.mockImplementation(async () => {});
  reply = () => ({ content: [toolUse('play', { column: 4 })] });
});

afterEach(async () => {
  await endCONNECT4(CHAR);
  __resetConnect4ForTests();
  __setConnect4TestHooks({});
  await drainScopedWrites();
  _setUserDataOverride(null);
  await rmTemp(dir);
});

describe('Four in a Row rules', () => {
  const empty = (): Array<Array<'r' | 'y' | null>> => Array.from({ length: 6 }, () => Array(7).fill(null));
  it('finds four across, up, and both diagonals, and nothing for three', () => {
    const across = empty();
    for (let c = 1; c <= 4; c++) across[5][c] = 'r';
    expect(isWinningPiece(across, 5, 4)).toBe(true);
    expect(isWinningPiece(across, 5, 1)).toBe(true);
    const up = empty();
    for (let r = 2; r <= 5; r++) up[r][6] = 'y';
    expect(isWinningPiece(up, 2, 6)).toBe(true);
    const diag = empty();
    for (let i = 0; i < 4; i++) diag[5 - i][i] = 'r';
    expect(isWinningPiece(diag, 3, 2)).toBe(true);
    const anti = empty();
    for (let i = 0; i < 4; i++) anti[2 + i][i] = 'y';
    expect(isWinningPiece(anti, 5, 3)).toBe(true);
    expect(winningLineText(across, 5, 2)).toBe('4 across the bottom row, columns 2 to 5');
    expect(winningLineText(up, 2, 6)).toBe('4 stacked up column 7');
    expect(winningLineText(diag, 4, 1)).toBe('4 on a diagonal, columns 1 to 4');
    expect(winningLineText(anti, 3, 1)).toBe('4 on a diagonal, columns 1 to 4');
    const three = empty();
    for (let c = 0; c < 3; c++) three[5][c] = 'r';
    three[5][3] = 'y';
    expect(isWinningPiece(three, 5, 2)).toBe(false);
  });
});

describe('Four in a Row turns', () => {
  it('the character drops where its play() call says, with its line', async () => {
    reply = () => ({
      content: [text('Red took the middle, so I need to stay close.'), toolUse('play', { column: 4, say: 'Bold opening.' })],
    });
    await startCONNECT4(CHAR, { playerColor: 'r' });
    const r = await playerMove(CHAR, 0);
    expect(r.ok).toBe(true);
    await waitFor(() => state().turn === 'r' && !state().aiThinking);
    const s = state();
    expect(s.board[5][3]).toBe('y'); // column 4 = index 3, bottom row
    expect(s.history.map((h) => h.column)).toEqual([0, 3]);
    // The system prompt carries the persona and the game contract.
    const sys = JSON.stringify(calls[0].system);
    expect(sys).toContain('PERSONA');
    expect(sys).toContain('FOUR IN A ROW');
    expect(sys).not.toMatch(/Connect ?4|Connect Four|Forza/);
    // The turn block shows the board as a grid and column by column.
    expect(JSON.stringify(calls[0].messages)).toContain('Each column from the bottom up: 1: R; 2: empty');
    await waitFor(() => chatPushed.find((m) => m.role === 'companion' && m.text === 'Bold opening'));
    // Plain text on a move turn is private working-out, never said.
    expect(chatPushed.filter((m) => m.role === 'companion').map((m) => m.text)).toEqual(['Bold opening']);
  });

  it('a full column goes back as an is_error tool_result and the model corrects itself', async () => {
    await startCONNECT4(CHAR, { playerColor: 'r' });
    // Both sides fill column 1; then the character tries it once more.
    let triedFull = false;
    reply = () => {
      if (dropRow(state().board, 0) !== -1) return { content: [toolUse('play', { column: 1 })] };
      if (!triedFull) {
        triedFull = true;
        return { content: [toolUse('play', { column: 1, say: 'Ugh.' }, 'tu_full')] };
      }
      return { content: [text('Column 1 is full, so 2.'), toolUse('play', { column: 2, say: 'Fine, here.' })] };
    };
    for (let i = 0; i < 3; i++) {
      expect((await playerMove(CHAR, 0)).ok).toBe(true);
      await waitFor(() => state().turn === 'r' && !state().aiThinking);
    }
    expect(dropRow(state().board, 0)).toBe(-1);
    expect((await playerMove(CHAR, 0)).ok).toBe(false); // the player is held to the same rule
    calls = [];
    await playerMove(CHAR, 6);
    await waitFor(() => state().moves === 8 && !state().aiThinking);
    expect(calls).toHaveLength(2);
    const msgs = calls[1].messages as Array<{ role: string; content: unknown }>;
    const last = msgs[msgs.length - 1] as {
      content: Array<{ type: string; tool_use_id: string; is_error?: boolean; content: string }>;
    };
    const tr = last.content.find((b) => b.type === 'tool_result')!;
    expect(tr.tool_use_id).toBe('tu_full');
    expect(tr.is_error).toBe(true);
    expect(tr.content).toMatch(/Column 1 is full/);
    for (const c of calls) assertToolResultsPaired(c);
    expect(state().board[5][1]).toBe('y');
    // Only the line of the call that landed is said; the rejected call's line is dropped.
    await waitFor(() => chatPushed.find((m) => m.text === 'Fine, here'));
    expect(chatPushed.find((m) => m.text === 'Ugh')).toBeUndefined();
    expect(chatPushed.find((m) => m.text.includes('Column 1 is full'))).toBeUndefined();
  });

  it('no move from the model means a clear failed state, never an engine move; Try again runs it again', async () => {
    reply = () => ({ content: [text('Hmm, let me think about this one.')] });
    await startCONNECT4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    await waitFor(() => state().aiTurnFailed);
    const s = state();
    expect(s.aiTurnFailed).toEqual({ reason: 'no_move', attempts: 3 });
    expect(s.aiThinking).toBe(false);
    expect(s.turn).toBe('y'); // still the character's move
    expect(aiPieces(s)).toBe(0); // nothing was played for it
    expect(s.moves).toBe(1);
    // Its talk from a turn with no move never reached the player.
    expect(chatPushed.filter((m) => m.role === 'companion')).toHaveLength(0);
    // The player cannot move in its place.
    expect((await playerMove(CHAR, 0)).ok).toBe(false);
    expect(events('connect4_turn_failed')[0]).toMatchObject({ reason: 'no_move', attempts: 3 });

    reply = () => ({ content: [toolUse('play', { column: 7 })] });
    await retryAiTurn(CHAR);
    await waitFor(() => state().turn === 'r' && !state().aiThinking);
    expect(state().aiTurnFailed).toBeNull();
    expect(state().board[5][6]).toBe('y');
  });

  it('illegal moves on every attempt end as illegal_move', async () => {
    reply = () => ({ content: [toolUse('play', { column: 9 })] });
    await startCONNECT4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    await waitFor(() => state().aiTurnFailed);
    expect(state().aiTurnFailed!.reason).toBe('illegal_move');
    expect(aiPieces(state())).toBe(0);
    // The retry note tells the next attempt why the last one did not count.
    const lastUser = JSON.stringify(calls[calls.length - 1].messages);
    expect(lastUser).toContain('Your last try did not count');
  });

  it('provider errors retry with backoff, then stop; auth stops at once', async () => {
    reply = () => {
      throw Object.assign(new Error('500 internal server error'), { status: 500 });
    };
    await startCONNECT4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    await waitFor(() => state().aiTurnFailed);
    expect(state().aiTurnFailed).toEqual({ reason: 'provider_error', attempts: 3 });
    expect(calls).toHaveLength(3);

    calls = [];
    reply = () => {
      throw Object.assign(new Error('401 invalid x-api-key'), { status: 401 });
    };
    await retryAiTurn(CHAR);
    await waitFor(() => state().aiTurnFailed);
    expect(state().aiTurnFailed).toEqual({ reason: 'auth', attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(aiPieces(state())).toBe(0);
  });

  it('a cloud usage limit raises the popup and stops in credit_wall', async () => {
    reply = () => {
      throw Object.assign(new Error('402 payment required'), { status: 402 });
    };
    popupSpy.mockImplementation(async () => 'depleted');
    await startCONNECT4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    await waitFor(() => state().aiTurnFailed);
    expect(state().aiTurnFailed!.reason).toBe('credit_wall');
    expect(popupSpy).toHaveBeenCalledWith(expect.anything(), 'connect4');
  });

  it('a move line that fails to land never costs the move or makes a second one', async () => {
    let failOnce = true;
    initCONNECT4Service({
      pushState: (st) => pushed.push(st),
      pushChatMessage: (_id, m) => {
        if (m.role === 'companion' && failOnce) {
          failOnce = false;
          throw new Error('disk full');
        }
        chatPushed.push(m);
      },
      isSummoned: () => false,
    });
    reply = () => ({ content: [toolUse('play', { column: 3, say: 'There.' })] });
    await startCONNECT4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 0);
    await waitFor(() => state().turn === 'r' && !state().aiThinking);
    expect(aiPieces(state())).toBe(1);
    expect(calls).toHaveLength(1);
    expect(state().aiTurnFailed).toBeNull();
  });

  it('a push that throws once the piece is down never moves a second time', async () => {
    let failOnce = true;
    initCONNECT4Service({
      pushState: (st) => {
        if (failOnce && st.history.some((h) => h.color === 'y')) {
          failOnce = false;
          throw new Error('window gone');
        }
        pushed.push(st);
      },
      pushChatMessage: (_id, m) => chatPushed.push(m),
      isSummoned: () => false,
    });
    reply = () => ({ content: [toolUse('play', { column: 3 })] });
    await startCONNECT4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 0);
    await waitFor(() => state().turn === 'r' && !state().aiThinking);
    expect(aiPieces(state())).toBe(1);
    expect(calls).toHaveLength(1);
    expect(state().aiTurnFailed).toBeNull();
  });

  it('a turn the game ended under never lands its move', async () => {
    let release!: () => void;
    reply = (_p, i) =>
      i === 0
        ? new Promise((res) => {
            release = () => res({ content: [toolUse('play', { column: 2, say: 'Got you.' })] });
          })
        : { content: [text('Gg.')] };
    await startCONNECT4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    await waitFor(() => calls.length === 1);
    await resign(CHAR);
    release();
    await new Promise((r) => setTimeout(r, 30));
    const s = state();
    expect(s.status).toBe('ended');
    expect(aiPieces(s)).toBe(0);
    expect(chatPushed.find((m) => m.text === 'Got you.')).toBeUndefined();
  });

  it('a rematch is a new game: the old turn cannot touch it', async () => {
    let release!: () => void;
    reply = (_p, i) =>
      i === 0
        ? new Promise((res) => {
            release = () => res({ content: [toolUse('play', { column: 2 })] });
          })
        : { content: [text('Again then.')] };
    await startCONNECT4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    await waitFor(() => calls.length === 1);
    await resign(CHAR);
    const next = await rematch(CHAR);
    expect(next.playerColor).toBe('r');
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(state().moves).toBe(0);
    expect(events('connect4_game_started').at(-1)).toMatchObject({ rematch: true });
  });

  it('chat during the game gets a reply that sees the board, and play() there does nothing', async () => {
    reply = (p) => {
      const last = JSON.stringify(p.messages[p.messages.length - 1]);
      if (last.includes('They just said to you') && last.includes('watch this')) {
        return { content: [text('Nice try.'), toolUse('play', { column: 1 })] };
      }
      return { content: [toolUse('play', { column: 5 })] };
    };
    await startCONNECT4(CHAR, { playerColor: 'r' });
    const res = await handlePlayerChat({ characterId: CHAR, text: 'watch this' });
    expect(res?.streamed).toBe(true);
    expect(res?.replies.map((m) => m.text)).toEqual(['Nice try']);
    expect(state().moves).toBe(0); // the chat turn's play() was refused
    const chatCall = calls[0];
    expect(JSON.stringify(chatCall.messages)).toContain('1 2 3 4 5 6 7');
  });

  it('a config read that throws fails the attempt (then Try again), never a turn stuck on thinking', async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error('config unreadable'));
    try {
      await startCONNECT4(CHAR, { playerColor: 'r' });
      await playerMove(CHAR, 3);
      await waitFor(() => state().aiTurnFailed);
      expect(state().aiThinking).toBe(false);
      expect(state().turn).toBe('y');
      expect(calls).toHaveLength(0); // no model call without a contract
    } finally {
      vi.mocked(loadConfig).mockImplementation(async () => ({ preferred_name: 'Player' }) as never);
    }
    reply = () => ({ content: [toolUse('play', { column: 2 })] });
    await retryAiTurn(CHAR);
    await waitFor(() => state().turn === 'r' && !state().aiThinking);
    expect(state().aiTurnFailed).toBeNull();
  });

  it('a chat reply after a failed move knows the move failed and points at Try again', async () => {
    reply = () => ({ content: [text('Hmm.')] });
    await startCONNECT4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 3);
    await waitFor(() => state().aiTurnFailed);
    calls = [];
    reply = () => ({ content: [text('Oops, my move broke.')] });
    await handlePlayerChat({ characterId: CHAR, text: 'your turn?' });
    const sent = JSON.stringify(calls[0].messages);
    expect(sent).toContain('your last try to move did not work');
    expect(sent).toContain('Try again');
  });

  it('a win ends the game with one play row and an ended event that counts LLM moves, never engine moves', async () => {
    // Character (yellow) stacks column 7; player (red) builds column 1.
    reply = () => ({ content: [toolUse('play', { column: 7 })] });
    await startCONNECT4(CHAR, { playerColor: 'r' });
    for (let i = 0; i < 3; i++) {
      await playerMove(CHAR, 0);
      await waitFor(() => state().turn === 'r' && !state().aiThinking);
    }
    await playerMove(CHAR, 0);
    expect(state().status).toBe('ended');
    expect(state().result).toEqual({ winner: 'r', reason: 'connect-four' });
    const ended = events('connect4_game_ended')[0];
    expect(ended).toMatchObject({ outcome: 'player', llm_moves: 3, engine_moves: 0, player_moves: 4, failed_turns: 0 });
    await drainScopedWrites();
    const row = await waitFor(() => chatPushed.find((m) => m.role === 'system' && m.event?.kind === 'play'));
    expect(row.text).toContain('Four in a Row');
    expect((row.event as { game: string }).game).toBe('Four in a Row');
    expect(foldSpy).toHaveBeenCalledWith(CHAR, 'PERSONA');
  });
});

describe('Four in a Row chat replies after the 261128 eval', () => {
  const lastUser = (p: LlmCallParams): string => JSON.stringify(p.messages[p.messages.length - 1]);

  it('a line sent while its move runs is quoted, goes after the move, and gets the whose-turn fact', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    reply = async (p) => {
      if (lastUser(p).includes('They just said to you')) return { content: [text('sure, watch the middle')] };
      await gate;
      return { content: [toolUse('play', { column: 4, say: 'center or nothing' })] };
    };
    await startCONNECT4(CHAR, { playerColor: 'y' });
    await waitFor(() => calls.length >= 1); // its opening move is in flight
    const chat = handlePlayerChat({ characterId: CHAR, text: 'can you teach me as we go?' });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const res = await chat;
    expect(res?.replies.map((m) => m.text)).toEqual(['sure, watch the middle']);
    const chatCall = calls.find((c) => lastUser(c).includes('They just said to you'))!;
    const whole = JSON.stringify(chatCall.messages);
    const at = whole.indexOf('can you teach me as we go?');
    expect(whole.indexOf('you dropped a red piece in column 4')).toBeLessThan(at);
    expect(whole.indexOf('center or nothing')).toBeLessThan(at);
    const block = lastUser(chatCall);
    expect(block).toContain('Whose turn: theirs. You do not move until they do.');
    expect(block).toContain('They just said to you: \\"can you teach me as we go?\\". You have not answered this yet.');
    expect(JSON.stringify(chatCall.system)).toContain('never say which column you will play next');
  });

  it('on its own (failed) turn the chat reply gets the whose-turn fact', async () => {
    reply = () => ({ content: [text('thinking...')] });
    await startCONNECT4(CHAR, { playerColor: 'r' });
    await playerMove(CHAR, 0);
    await waitFor(() => state().aiTurnFailed);
    calls = [];
    reply = () => ({ content: [text('ugh')] });
    await handlePlayerChat({ characterId: CHAR, text: 'your go' });
    expect(lastUser(calls[0])).toContain('Whose turn: yours, but your last try to move did not work');
  });
});

describe('Four in a Row chat facts (lines, chances to make four)', () => {
  const B = (rows: string[]) =>
    rows.map((r) => r.split(' ').map((x) => (x === '.' ? null : x === 'R' ? 'r' : 'y'))) as Array<Array<'r' | 'y' | null>>;
  const sides = { ai: 'y' as const, player: 'Ren', me: 'Sui' };

  it('names both sides and says whether a line still has room', () => {
    const board = B([
      '. . . . . . .',
      '. . . . . . .',
      '. . . . . . .',
      '. . . Y . . .',
      '. . . R . . .',
      '. . Y R R Y .',
    ]);
    const lines = linesText(board, sides);
    expect(lines).toContain('2 stacked in column 4 (blocked, cannot become four)');
    expect(lines).toContain('2 on a diagonal going down from column 4 to 5 (room to make four)');
    expect(lines).toContain('- Your own red lines, for you to build on: 2 across the bottom row, columns 4 to 5 (blocked, cannot become four)');
    expect(lines).toContain('- My yellow lines, for you to block: no two in a line yet.');
    expect(fourChancesText(board, sides)).toBe(
      '- Chances to make four: none, nobody has three lined up with an open fourth space.',
    );
    const facts = connect4ChatFacts(board, sides);
    expect(facts).toContain('written the way you say them to Ren ("you" is Ren, "I" and "my" are you, Sui)');
    expect(facts).toContain('Ren plays red, so a tip for Ren never says to block a red line.');
  });

  it('lists a playable four and one that is not reachable yet, and diagonals', () => {
    const board = B([
      '. . . . . . .',
      '. . . . . . .',
      '. . . . . . .',
      '. . . . . . .',
      '. . Y R . . .',
      '. R R R Y Y .',
    ]);
    const chances = fourChancesText(board, sides);
    expect(chances).toContain('you (red) can make four right now in column 1');
    expect(chances).not.toContain('I (yellow)');
    const lines = linesText(board, sides);
    expect(lines).toContain('3 across the bottom row, columns 2 to 4 (room to make four)');
    expect(lines).toContain('2 on a diagonal going up from column 3 to 4 (room to make four)');
    const later = fourChancesText(
      B([
        '. . . . . . .',
        '. . . . . . .',
        '. . . . . . .',
        '. . . R . . .',
        '. . R Y . . .',
        '. R Y Y . . .',
      ]),
      sides,
    );
    expect(later).toContain('you (red) would make four in column 5, row 4 from the bottom, once that column fills up to it');
  });
});
