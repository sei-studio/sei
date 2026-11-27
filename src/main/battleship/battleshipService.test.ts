/**
 * Fleet Battle service (261127): the character places its own fleet and
 * calls its own shots.
 *
 * Real boards, real fsm.js queue, real board-turn runner (persona prompt,
 * thread, tool_result blocks), real chat store in a temp profile. Only the
 * provider is scripted (the service's test seam), plus the character/config
 * reads, analytics and the usage-limit popup.
 *
 * What is pinned:
 *   - the 400 this replaces: every tool_use in every request is answered by a
 *     tool_result block, including multi-hop turns (a re-fired cell, a
 *     remember() before the shot);
 *   - placement is the character's validated place_fleet() call; a bad fleet
 *     goes back to it, a turn without one stops in aiTurnFailed;
 *   - every shot is its fire() call; a cell already fired at (miss, hit or
 *     sunk) is rejected; no engine shot or placement, ever;
 *   - the stale-turn race, resign during placement, rematch alternating the
 *     first shooter, history `by`, the character winning;
 *   - the prompt never shows the character the player's ships.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';
import { drainScopedWrites } from '../profile/scopeBarrier';
import type { ChatMessage } from '../../shared/ipc';
import {
  battleshipCellName,
  fleetProblem,
  parseBattleshipCell,
  type BATTLESHIPGameState,
  type BATTLESHIPPlacement,
} from '../../shared/battleshipIpc';
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
  initBATTLESHIPService,
  startBATTLESHIP,
  placeFleet,
  playerMove,
  retryAiTurn,
  resign,
  rematch,
  endBATTLESHIP,
  handlePlayerChat,
  getBATTLESHIPState,
  __setBattleshipTestHooks,
  __resetBattleshipForTests,
  openHitsText,
  firedCellsText,
  chatFactsText,
  placementLean,
  openingLean,
} from './battleshipService';
import type { BATTLESHIPGrid, BATTLESHIPShip } from '../../shared/battleshipIpc';
import { loadConfig } from '../configStore';

const CHAR = '55555555-5555-4555-8555-555555555555';
let dir: string;
let chatPushed: ChatMessage[];
let calls: LlmCallParams[];
type FakeReply = { content: Array<Record<string, unknown>> };
type Reply = (p: LlmCallParams, i: number) => Promise<FakeReply> | FakeReply;
let reply: Reply;

function toolUse(name: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2, 8)}`) {
  return { type: 'tool_use', id, name, input };
}
function text(t: string) {
  return { type: 'text', text: t, citations: null };
}

const provider: LlmProvider = {
  kind: 'anthropic',
  model: 'test-model',
  backend: 'local' as LlmProvider['backend'],
  vision: 'no' as unknown as LlmProvider['vision'],
  streaming: false,
  async call(params) {
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

const state = (): BATTLESHIPGameState => getBATTLESHIPState(CHAR)!;
const events = (name: string): Array<Record<string, unknown>> =>
  captureSpy.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, unknown>);
const lastUserText = (p: LlmCallParams): string => JSON.stringify(p.messages[p.messages.length - 1]);
// The character owes its fleet while the game is in placement (no chat turns in these scripts).
const isPlaceTurn = (_p?: LlmCallParams): boolean => state()?.status === 'preparing';

/** The character's fleet as a place_fleet() input: rows A, C, E, G, I from column 1. */
const AI_FLEET = {
  ships: [
    { ship: 'carrier', start: 'A1', direction: 'right' },
    { ship: 'battleship', start: 'C1', direction: 'right' },
    { ship: 'cruiser', start: 'E1', direction: 'right' },
    { ship: 'submarine', start: 'G1', direction: 'right' },
    { ship: 'destroyer', start: 'I1', direction: 'right' },
  ],
};
/** Its cells, for the player's winning shots. */
const AI_SHIP_CELLS: Array<[number, number]> = [
  ...[0, 1, 2, 3, 4].map((c) => [0, c] as [number, number]),
  ...[0, 1, 2, 3].map((c) => [2, c] as [number, number]),
  ...[0, 1, 2].map((c) => [4, c] as [number, number]),
  ...[0, 1, 2].map((c) => [6, c] as [number, number]),
  ...[0, 1].map((c) => [8, c] as [number, number]),
];
/** The player's fleet: down columns 10, 8, 6, 4, 2 from row A. */
const PLAYER_FLEET: BATTLESHIPPlacement[] = [
  { name: 'carrier', row: 0, col: 9, horizontal: false },
  { name: 'battleship', row: 0, col: 7, horizontal: false },
  { name: 'cruiser', row: 0, col: 5, horizontal: false },
  { name: 'submarine', row: 0, col: 3, horizontal: false },
  { name: 'destroyer', row: 0, col: 1, horizontal: false },
];
const PLAYER_SHIP_CELLS: string[] = PLAYER_FLEET.flatMap((p) =>
  Array.from({ length: { carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 }[p.name] }, (_, i) =>
    battleshipCellName(p.row + i, p.col),
  ),
);

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

function lastToolResult(p: LlmCallParams): { tool_use_id: string; is_error?: boolean; content: string } {
  const msgs = p.messages as Array<{ role: string; content: unknown }>;
  const last = msgs[msgs.length - 1].content as Array<{ type: string; tool_use_id: string; is_error?: boolean; content: string }>;
  return last.find((b) => b.type === 'tool_result')!;
}

/** Start, let the character place AI_FLEET, place the player's fleet, wait for the battle. */
async function startBattle(opts?: { playerStarts?: boolean }): Promise<void> {
  await startBATTLESHIP(CHAR, opts);
  await placeFleet(CHAR, PLAYER_FLEET);
  await waitFor(() => state().status === 'active');
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

let shots: string[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-bs-'));
  _setUserDataOverride(dir);
  chatPushed = [];
  calls = [];
  initBATTLESHIPService({
    pushState: () => {},
    pushChatMessage: (_id, m) => chatPushed.push(m),
    isSummoned: () => false,
  });
  __setBattleshipTestHooks({ provider, sleep: async () => {} });
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
  // Default script: place AI_FLEET, then fire down a fixed list of cells.
  shots = ['J10', 'J9', 'J8', 'J7', 'J6', 'J5', 'J4', 'J3', 'J2', 'J1'];
  reply = (p) => {
    if (isPlaceTurn(p)) return { content: [toolUse('place_fleet', AI_FLEET)] };
    // After the list: the first cell (row by row) this scripted model has not tried.
    const next =
      shots.shift() ??
      state().playerGrid.cells.flatMap((row, r) => row.map((c, col) => (c === 'empty' || c === 'ship' ? battleshipCellName(r, col) : null))).find(Boolean)!;
    return { content: [toolUse('fire', { cell: next })] };
  };
});

afterEach(async () => {
  await endBATTLESHIP(CHAR);
  __resetBattleshipForTests();
  __setBattleshipTestHooks({});
  await drainScopedWrites();
  _setUserDataOverride(null);
  await rmTemp(dir);
});

describe('Fleet Battle rules helpers', () => {
  it('reads cells the way people write them', () => {
    expect(parseBattleshipCell('B7')).toEqual({ row: 1, col: 6 });
    expect(parseBattleshipCell(' b 7 ')).toEqual({ row: 1, col: 6 });
    expect(parseBattleshipCell('7B')).toEqual({ row: 1, col: 6 });
    expect(parseBattleshipCell('J10')).toEqual({ row: 9, col: 9 });
    expect(parseBattleshipCell('K1')).toBeNull();
    expect(parseBattleshipCell('A11')).toBeNull();
    expect(parseBattleshipCell('A0')).toBeNull();
    expect(parseBattleshipCell(3)).toBeNull();
    expect(battleshipCellName(9, 9)).toBe('J10');
  });

  it('says why a fleet is not legal', () => {
    expect(fleetProblem(PLAYER_FLEET)).toBeNull();
    expect(fleetProblem(PLAYER_FLEET.slice(1))).toMatch(/carrier is missing/);
    expect(fleetProblem([...PLAYER_FLEET, PLAYER_FLEET[4]])).toMatch(/more than once/);
    const off = PLAYER_FLEET.map((p) => (p.name === 'carrier' ? { ...p, row: 7 } : p));
    expect(fleetProblem(off)).toMatch(/carrier runs off the board/);
    const overlap = PLAYER_FLEET.map((p) => (p.name === 'destroyer' ? { ...p, col: 3 } : p));
    expect(fleetProblem(overlap)).toMatch(/overlap at/);
  });
});

describe('Fleet Battle placement', () => {
  it('the character places its own fleet; a bad one goes back to it as a tool error', async () => {
    let placeCalls = 0;
    reply = (p) => {
      if (!isPlaceTurn(p)) return { content: [toolUse('fire', { cell: 'J10' })] };
      placeCalls++;
      if (placeCalls === 1) {
        const bad = { ships: AI_FLEET.ships.map((sh) => (sh.ship === 'destroyer' ? { ...sh, start: 'A4' } : sh)) };
        return { content: [text('Hiding my boats.'), toolUse('place_fleet', bad, 'tu_bad')] };
      }
      return { content: [toolUse('place_fleet', AI_FLEET)] };
    };
    await startBATTLESHIP(CHAR);
    expect(state().status).toBe('preparing');
    await waitFor(() => state().aiFleet === 'ready');
    expect(calls).toHaveLength(2);
    const tr = lastToolResult(calls[1]);
    expect(tr.tool_use_id).toBe('tu_bad');
    expect(tr.is_error).toBe(true);
    expect(tr.content).toMatch(/destroyer and the carrier overlap at A4/);
    for (const c of calls) assertToolResultsPaired(c);
    // The battle waits for the player's fleet.
    expect(state().status).toBe('preparing');
    // The character's ships are never in the player's view before the end.
    expect(state().aiVisibleGrid.ships).toHaveLength(0);
    expect(state().aiVisibleGrid.cells.flat().every((c) => c === 'empty')).toBe(true);
    await placeFleet(CHAR, PLAYER_FLEET);
    expect(state().status).toBe('active');
    expect(state().turn).toBe('player');
    await expect(placeFleet(CHAR, PLAYER_FLEET)).rejects.toThrow();
    expect(events('battleship_fleet_placed').map((e) => e.by).sort()).toEqual(['ai', 'player']);
  });

  it('no fleet from the model stops in a clear failed state; Try again places it', async () => {
    reply = () => ({ content: [text('Let me think about where to hide them.')] });
    await startBATTLESHIP(CHAR);
    await placeFleet(CHAR, PLAYER_FLEET);
    await waitFor(() => state().aiTurnFailed);
    expect(state().aiFleet).toBe('failed');
    expect(state().aiTurnFailed).toEqual({ reason: 'no_move', attempts: 3 });
    expect(state().status).toBe('preparing'); // no fleet was made up for it
    expect(events('battleship_turn_failed')[0]).toMatchObject({ turn_kind: 'place', reason: 'no_move' });

    reply = (p) =>
      isPlaceTurn(p) ? { content: [toolUse('place_fleet', AI_FLEET)] } : { content: [toolUse('fire', { cell: 'J10' })] };
    await retryAiTurn(CHAR);
    await waitFor(() => state().status === 'active');
    expect(state().aiTurnFailed).toBeNull();
    expect(state().aiFleet).toBe('ready');
  });

  it('a config read that throws fails the placement (then Try again), never a turn stuck on thinking', async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error('config unreadable'));
    try {
      await startBATTLESHIP(CHAR);
      await placeFleet(CHAR, PLAYER_FLEET);
      await waitFor(() => state().aiTurnFailed);
      expect(state().aiFleet).toBe('failed');
      expect(state().aiThinking).toBe(false);
    } finally {
      vi.mocked(loadConfig).mockImplementation(async () => ({ preferred_name: 'Player' }) as never);
    }
  });

  it('a chat reply after a failed turn knows it failed and points at Try again', async () => {
    reply = () => ({ content: [text('Let me think.')] });
    await startBATTLESHIP(CHAR);
    await placeFleet(CHAR, PLAYER_FLEET);
    await waitFor(() => state().aiTurnFailed);
    calls = [];
    reply = () => ({ content: [text('Ugh, something broke.')] });
    await handlePlayerChat({ characterId: CHAR, text: 'ready?' });
    const sent = JSON.stringify(calls[0].messages);
    expect(sent).toContain('they can press Try again');
  });

  it('resign is allowed during placement', async () => {
    await startBATTLESHIP(CHAR);
    await resign(CHAR);
    expect(state().status).toBe('ended');
    expect(state().result).toMatchObject({ winner: 'ai', reason: 'resign' });
    expect(events('battleship_game_ended')[0]).toMatchObject({ ended_in: 'preparing', outcome: 'ai' });
  });
});

describe('Fleet Battle shots', () => {
  it('a re-fired cell and a remember() hop both answer with tool_result blocks (the old 400)', async () => {
    await startBattle();
    calls = [];
    let n = 0;
    reply = () => {
      n++;
      if (n === 1) return { content: [toolUse('fire', { cell: 'J10' })] };
      // Second turn: remember first, then the same cell again, then a new one.
      if (n === 2) return { content: [toolUse('remember', { text: 'They opened in the corner.' }, 'tu_mem')] };
      if (n === 3) return { content: [text('Again!'), toolUse('fire', { cell: 'J10' }, 'tu_dup')] };
      return { content: [text('J10 is used, H5 then.'), toolUse('fire', { cell: 'H5', say: 'Fine, fine.' })] };
    };
    await playerMove(CHAR, 9, 9);
    await waitFor(() => state().turn === 'player' && !state().aiThinking);
    await playerMove(CHAR, 9, 8);
    await waitFor(() => state().aiShots === 2 && state().turn === 'player' && !state().aiThinking);
    expect(calls).toHaveLength(4);
    for (const c of calls) assertToolResultsPaired(c);
    const dup = lastToolResult(calls[3]);
    expect(dup.tool_use_id).toBe('tu_dup');
    expect(dup.is_error).toBe(true);
    expect(dup.content).toMatch(/already fired at J10/);
    const aiShots = state().history.filter((h) => h.by === 'ai').map((h) => battleshipCellName(h.row, h.col));
    expect(aiShots).toEqual(['J10', 'H5']);
    expect(state().history.map((h) => h.by)).toEqual(['player', 'ai', 'player', 'ai']);
    await waitFor(() => chatPushed.find((m) => m.text === 'Fine, fine'));
    // Private working-out and the rejected call's text never reach the player.
    expect(chatPushed.filter((m) => m.role === 'companion').map((m) => m.text)).toEqual(['Fine, fine']);
  });

  it('a sunk cell cannot be fired at again', async () => {
    // Sink the player's destroyer (B2..A2 = col 1, rows 0-1), then aim at it once more.
    shots = ['A2', 'B2'];
    await startBattle();
    for (let i = 0; i < 2; i++) {
      await playerMove(CHAR, 9, 9 - i);
      await waitFor(() => state().turn === 'player' && !state().aiThinking);
    }
    expect(state().playerGrid.cells[0][1]).toBe('sunk');
    calls = [];
    reply = (_p, i) =>
      i === 0 ? { content: [toolUse('fire', { cell: 'A2' }, 'tu_sunk')] } : { content: [toolUse('fire', { cell: 'E5' })] };
    await playerMove(CHAR, 9, 7);
    await waitFor(() => state().aiShots === 3 && state().turn === 'player' && !state().aiThinking);
    const tr = lastToolResult(calls[1]);
    expect(tr.tool_use_id).toBe('tu_sunk');
    expect(tr.is_error).toBe(true);
    expect(state().playerGrid.cells[4][4]).toBe('miss');
  });

  it('the shot prompt shows the player board without their ships', async () => {
    await startBattle();
    calls = [];
    await playerMove(CHAR, 9, 9);
    await waitFor(() => state().turn === 'player' && !state().aiThinking);
    const block = lastUserText(calls[0]);
    const theirs = block.slice(block.indexOf('Their board'), block.indexOf('Your own board'));
    // Grid rows look like "A   . . S"; no ship letter may appear in their rows.
    const rows = theirs.split('\\n').filter((l) => /^[A-J]  /.test(l));
    expect(rows).toHaveLength(10);
    expect(rows.join('')).not.toMatch(/S/);
    expect(block).toContain('Your own board');
  });

  it('the player cannot fire during the character turn or at a cell twice', async () => {
    let release!: () => void;
    await startBattle();
    reply = (_p, i) =>
      i === 0
        ? new Promise((res) => {
            release = () => res({ content: [toolUse('fire', { cell: 'J10' })] });
          })
        : { content: [toolUse('fire', { cell: 'J9' })] };
    calls = [];
    await playerMove(CHAR, 0, 9);
    await waitFor(() => calls.length === 1);
    expect((await playerMove(CHAR, 1, 9)).ok).toBe(false);
    release();
    await waitFor(() => state().turn === 'player' && !state().aiThinking);
    expect((await playerMove(CHAR, 0, 9)).error).toBe('already fired there');
  });

  it('no shot from the model means a failed state, never an engine shot; Try again fires', async () => {
    await startBattle();
    reply = () => ({ content: [text('Hmm, where are they hiding...')] });
    await playerMove(CHAR, 9, 9);
    await waitFor(() => state().aiTurnFailed);
    expect(state().aiTurnFailed!.reason).toBe('no_move');
    expect(state().aiShots).toBe(0);
    expect(state().playerGrid.cells.flat().filter((c) => c === 'miss' || c === 'hit')).toHaveLength(0);
    expect(chatPushed.filter((m) => m.role === 'companion')).toHaveLength(0);
    reply = () => ({ content: [toolUse('fire', { cell: 'D4' })] });
    await retryAiTurn(CHAR);
    await waitFor(() => state().turn === 'player' && !state().aiThinking);
    expect(state().aiShots).toBe(1);
  });

  it('auth errors stop after one attempt', async () => {
    await startBattle();
    calls = [];
    reply = () => {
      throw Object.assign(new Error('401 invalid x-api-key'), { status: 401 });
    };
    await playerMove(CHAR, 9, 9);
    await waitFor(() => state().aiTurnFailed);
    expect(state().aiTurnFailed).toEqual({ reason: 'auth', attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it('a shot the game ended under never lands', async () => {
    let release!: () => void;
    await startBattle();
    reply = (_p, i) =>
      i === 0
        ? new Promise((res) => {
            release = () => res({ content: [toolUse('fire', { cell: 'A10', say: 'Gotcha.' })] });
          })
        : { content: [text('Gg.')] };
    calls = [];
    await playerMove(CHAR, 9, 9);
    await waitFor(() => calls.length === 1);
    await resign(CHAR);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(state().aiShots).toBe(0);
    expect(state().playerGrid.cells[0][9]).toBe('ship');
    expect(chatPushed.find((m) => m.text.startsWith('Gotcha'))).toBeUndefined();
  });

  it('fire() in a chat reply does nothing', async () => {
    await startBattle();
    reply = () => ({ content: [text('Watch this'), toolUse('fire', { cell: 'B2' })] });
    const res = await handlePlayerChat({ characterId: CHAR, text: 'nervous?' });
    expect(res?.streamed).toBe(true);
    expect(res?.replies.map((m) => m.text)).toEqual(['Watch this']);
    expect(state().aiShots).toBe(0);
    expect(state().turn).toBe('player');
  });

  it('the character wins by sinking every ship; the ended event counts only its own moves', async () => {
    shots = [...PLAYER_SHIP_CELLS];
    await startBattle({ playerStarts: false });
    // The player only misses: rows J and H hold no ships.
    const misses: Array<[number, number]> = [
      ...Array.from({ length: 10 }, (_, c) => [9, c] as [number, number]),
      ...Array.from({ length: 10 }, (_, c) => [7, c] as [number, number]),
    ].slice(0, PLAYER_SHIP_CELLS.length - 1);
    for (const [r, c] of misses) {
      await waitFor(() => state().turn === 'player' && !state().aiThinking);
      expect((await playerMove(CHAR, r, c)).ok).toBe(true);
    }
    await waitFor(() => state().status === 'ended');
    expect(state().result).toEqual({ winner: 'ai', reason: 'all-ships-sunk' });
    expect(state().aiShots).toBe(PLAYER_SHIP_CELLS.length);
    // The end reveals the character's fleet to the player.
    expect(state().aiVisibleGrid.ships).toHaveLength(5);
    const ended = events('battleship_game_ended')[0];
    // llm_moves = its placement + every shot.
    expect(ended).toMatchObject({ outcome: 'ai', engine_moves: 0, llm_moves: PLAYER_SHIP_CELLS.length + 1, failed_turns: 0 });
    const row = await waitFor(() => chatPushed.find((m) => m.role === 'system' && m.event?.kind === 'play'));
    expect((row.event as { game: string }).game).toBe('Fleet Battle');
  });

  it('the player wins by sinking every ship; rematch flips who fires first', async () => {
    await startBattle();
    for (const [r, c] of AI_SHIP_CELLS) {
      await waitFor(() => state().turn === 'player' && !state().aiThinking);
      expect((await playerMove(CHAR, r, c)).ok).toBe(true);
    }
    expect(state().result).toEqual({ winner: 'player', reason: 'all-ships-sunk' });
    expect(state().playerShots).toBe(AI_SHIP_CELLS.length);
    expect(state().aiShots).toBe(AI_SHIP_CELLS.length - 1);
    const next = await rematch(CHAR);
    expect(next.playerStarts).toBe(false);
    expect(next.status).toBe('preparing');
    expect(events('battleship_game_started').at(-1)).toMatchObject({ rematch: true, player_starts: false });
    await placeFleet(CHAR, PLAYER_FLEET);
    await waitFor(() => state().status === 'active' && state().aiShots === 1);
    expect(state().history[0].by).toBe('ai');
  });
});

// ── 261128 eval fixes: what the character is shown (display only, never a move) ──

function gridWith(marks: Record<string, 'hit' | 'miss' | 'sunk' | 'ship'>): BATTLESHIPGrid {
  const cells = Array.from({ length: 10 }, () => Array<BATTLESHIPGrid['cells'][number][number]>(10).fill('empty'));
  for (const [name, v] of Object.entries(marks)) {
    const c = parseBattleshipCell(name)!;
    cells[c.row][c.col] = v;
  }
  return { cells, ships: [] };
}

/** The grid rows ("A  . . X") of a JSON-encoded prompt text. */
const gridRows = (json: string): string[] => json.split('\\n').filter((l) => /^[A-J]  /.test(l));

describe('Fleet Battle prompt facts', () => {
  it('open hits list only unsunk hits, each with the neighbours not fired at', () => {
    const g = gridWith({ A2: 'hit', A1: 'miss', E5: 'hit', E6: 'hit', E4: 'miss', H8: 'sunk', H9: 'sunk' });
    expect(openHitsText(g)).toBe(
      'Your open hits, on ships not sunk yet: A2 (next to it, not fired yet: B2, A3); ' +
        'E5 (next to it, not fired yet: D5, F5); E6 (next to it, not fired yet: D6, F6, E7).',
    );
    expect(openHitsText(gridWith({ H8: 'sunk', C3: 'miss' }))).toMatch(/^Your open hits: none/);
  });

  it('the fired set is listed, and past half the board the open cells instead', () => {
    expect(firedCellsText(gridWith({}))).toBe('');
    expect(firedCellsText(gridWith({ C3: 'miss', A1: 'hit', J10: 'sunk' }))).toBe(
      'Cells you already fired at (never again): A1, C3, J10.',
    );
    const marks: Record<string, 'miss'> = {};
    for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) if (!(r === 9 && c >= 7)) marks[battleshipCellName(r, c)] = 'miss';
    expect(firedCellsText(gridWith(marks))).toBe(
      'You fired at 97 cells. The only cells you have not fired at: J8, J9, J10.',
    );
  });

  it('chat facts say who sank what and the last shots from its own side', () => {
    const ship = (name: BATTLESHIPShip['name'], sunk: boolean): BATTLESHIPShip => ({ name, size: 2, cells: [], sunk });
    const text = chatFactsText({
      theirShips: [ship('carrier', false), ship('destroyer', true)],
      yourShips: [ship('battleship', true), ship('cruiser', false)],
      history: [
        { by: 'ai', row: 0, col: 0, hit: false, sunkShip: null },
        { by: 'player', row: 4, col: 4, hit: true, sunkShip: null },
        { by: 'ai', row: 1, col: 1, hit: true, sunkShip: null },
        { by: 'ai', row: 1, col: 2, hit: true, sunkShip: 'destroyer' },
        { by: 'player', row: 5, col: 4, hit: true, sunkShip: 'battleship' },
      ],
      turn: 'ai',
    });
    expect(text).toContain('You sank 1 of 2 (destroyer) of their ships. They sank 1 of 2 (battleship) of yours.');
    expect(text).toContain('Your last shots at their ships, newest first: B3 sank their destroyer, B2 hit.');
    expect(text).toContain('Their last shots at your ships, newest first: F5 sank your battleship, E5 hit.');
    expect(text).toContain('Next shot: yours.');
  });

  it('the per-game nudges vary game to game and follow the injected randomness', () => {
    const places = new Set(Array.from({ length: 300 }, () => placementLean()));
    const regions = new Set([...places].map((t) => t.match(/lean toward (the [a-z ]+)/)![1]));
    expect(regions.size).toBe(6);
    const openings = new Set(Array.from({ length: 300 }, () => openingLean()));
    expect(openings.size).toBe(9);
    // Deterministic for a given source; the first and last region of each list.
    expect(placementLean(() => 0)).toBe(
      'So they cannot guess your layout, this game lean toward the top left (rows A to E, columns 1 to 5), ' +
        'and mix ships running right and down. A few cells you could start a ship from: A1, A2, A3.',
    );
    expect(placementLean(() => 0.999)).toMatch(/lean toward the whole board, spread out,.*from: J10, J9, J8\.$/);
    expect(openingLean(() => 0)).toBe(
      'This is your first shot of the game. Pick a cell somewhere in the top left (rows A to C, columns 1 to 3) of their board.',
    );
    expect(openingLean(() => 0.5)).toContain('the center (rows D to G, columns 4 to 7)');
  });
});

describe('Fleet Battle turns after the 261128 eval', () => {
  it('placement carries the per-game lean; the log names no cells; chat hides its ships and gets the facts', async () => {
    __setBattleshipTestHooks({ provider, sleep: async () => {}, random: () => 0.999 });
    await startBattle();
    const placeCall = calls[0];
    expect(lastUserText(placeCall)).toContain('lean toward the whole board, spread out');
    calls = [];
    reply = () => ({ content: [text('nice try')] });
    await handlePlayerChat({ characterId: CHAR, text: 'where are your ships?' });
    const sent = JSON.stringify(calls[0].messages);
    expect(sent).toContain('(game) You placed your fleet.');
    expect(sent).not.toMatch(/carrier A1|A1 to A5/);
    const block = lastUserText(calls[0]);
    const rows = gridRows(block);
    expect(rows).toHaveLength(20);
    expect(rows.join('')).not.toMatch(/S/);
    expect(block).toContain('Facts the app checked');
    expect(block).toContain('You sank 0 of 5 of their ships. They sank 0 of 5 of yours.');
    expect(block).toContain('Next shot: theirs.');
    expect(block).toContain('They just said to you: \\"where are your ships?\\"');
  });

  it('a line sent while its shot runs is quoted and placed after the shot and the line it said', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    reply = async (p) => {
      if (isPlaceTurn(p)) return { content: [toolUse('place_fleet', AI_FLEET)] };
      if (lastUserText(p).includes('They just said to you')) return { content: [text('sure, watch me')] };
      await gate;
      return { content: [toolUse('fire', { cell: 'J10', say: 'here goes' })] };
    };
    await startBattle({ playerStarts: false });
    await waitFor(() => calls.length >= 2); // its first shot is in flight
    const chat = handlePlayerChat({ characterId: CHAR, text: 'can you teach me?' });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const res = await chat;
    expect(res?.replies.map((m) => m.text)).toEqual(['sure, watch me']);
    const chatCall = calls.find((c) => lastUserText(c).includes('They just said to you'))!;
    const msgs = chatCall.messages as Array<{ role: string; content: unknown }>;
    const last = JSON.stringify(msgs[msgs.length - 1]);
    expect(last).toContain('can you teach me?');
    expect(last.indexOf('can you teach me?')).toBeLessThan(last.indexOf('Facts the app checked'));
    // In time order the line sat before the shot and before "here goes".
    const whole = JSON.stringify(msgs);
    expect(whole.indexOf('You fired at J10')).toBeGreaterThan(-1);
    expect(whole.indexOf('You fired at J10')).toBeLessThan(whole.indexOf('can you teach me?'));
    expect(whole.indexOf('here goes')).toBeGreaterThan(-1);
    expect(whole.indexOf('here goes')).toBeLessThan(whole.indexOf('can you teach me?'));
    expect(whole.split('can you teach me?')).toHaveLength(3); // once in the thread, once quoted
  });

  it('move turns show the opening nudge first, then open hits and the fired set', async () => {
    __setBattleshipTestHooks({ provider, sleep: async () => {}, random: () => 0 });
    shots = ['A2', 'C9'];
    await startBattle({ playerStarts: false });
    await waitFor(() => state().turn === 'player' && !state().aiThinking);
    const first = lastUserText(calls[calls.length - 1]);
    expect(first).toContain('This is your first shot of the game. Pick a cell somewhere in the top left');
    expect(first).not.toContain('Your open hits');
    await playerMove(CHAR, 9, 9);
    await waitFor(() => state().turn === 'player' && !state().aiThinking);
    const second = lastUserText(calls[calls.length - 1]);
    expect(second).not.toContain('first shot of the game');
    expect(second).toContain('Your open hits, on ships not sunk yet: A2 (next to it, not fired yet: B2, A1, A3).');
    expect(second).toContain('Cells you already fired at (never again): A2.');
    expect(state().aiShots).toBe(2); // C9 was its own call, nothing chosen for it
  });
});
