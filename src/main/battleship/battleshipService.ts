/**
 * Battleship (Battleship) minigame service (main process): authoritative
 * game state + the character's shot picker.
 *
 * Two 10x10 grids per character (player + AI), 5 ships each placed randomly at
 * start. Players alternate firing (row, col); win when all opposing ships are
 * sunk.
 *
 * The AI's shot is chosen by the LLM from a `fire(row, col)` tool — no external
 * engine, no model download.
 *
 * Mutually exclusive with Minecraft summon via deps.isSummoned.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ChatMessage } from '../../shared/ipc';
import type {
  BATTLESHIPCell,
  BATTLESHIPGameState,
  BATTLESHIPGrid,
  BATTLESHIPGameStatus,
  BATTLESHIPPlacement,
  BATTLESHIPResult,
  BATTLESHIPShip,
  BATTLESHIPShipName,
  BATTLESHIPShotRecord,
} from '../../shared/battleshipIpc';
import {
  BATTLESHIP_ERR_MC_ACTIVE,
  placementCells,
  placementFits,
  randomFleetPlacement,
} from '../../shared/battleshipIpc';
import { buildLlmProvider } from '../llm';
import { loadAnalytics } from '../lazyAnalytics';
import { getCharacter } from '../characterStore';
import { loadConfig } from '../configStore';
import { accountSwitchingError, beginSessionStart, trackScopedWrite } from '../profile/scopeBarrier';
import { appendMemory } from '../../bot/brain/memory/memoryLog.js';
import { paths } from '../paths';
import { isCallActive } from '../voice/callState';
import { foldIfDue } from '../chat/continuity';
import { toMessages } from '../chat/transcript';
import { REMEMBER_TOOL } from '../chat/chatPrompts';
import { companionLanguageFor } from '../companionLanguage';
import { renderAdoptedLanguageNote, renderLanguageDirective } from '../../bot/brain/promptLibrary.js';
import type { LlmMessage } from '../llm/types';

const ROWS = 10;
const COLS = 10;
const SHIP_NAMES: BATTLESHIPShipName[] = ['carrier', 'battleship', 'cruiser', 'submarine', 'destroyer'];
const SHIP_SIZES: Record<BATTLESHIPShipName, number> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  destroyer: 2,
};

const sessions = new Map<string, Session>();
let deps: BATTLESHIPDeps | null = null;

export interface BATTLESHIPDeps {
  pushState: (state: BATTLESHIPGameState) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** True when the character has a live Minecraft session (mutually exclusive). */
  isSummoned: (characterId: string) => boolean;
}

export interface BATTLESHIPStartOpts {
  playerStarts?: boolean;
}

interface Session {
  gameId: string;
  characterId: string;
  playerGrid: BATTLESHIPGrid;     // player's own ships (AI shoots here)
  aiGrid: BATTLESHIPGrid;          // AI's own ships (hidden from renderer)
  aiVisibleGrid: BATTLESHIPGrid;   // player's view: hits/misses only
  turn: 'player' | 'ai';
  status: BATTLESHIPGameStatus;
  /** Who opens once the player confirms their fleet (placement phase). */
  pendingPlayerStarts: boolean;
  aiThinking: boolean;
  pendingAiMove: { row: number; col: number } | null;
  result: BATTLESHIPResult | null;
  history: BATTLESHIPShotRecord[];
  shotsFired: number;
  startedAt: number;
  turnCtrl: AbortController | null;
  turnSeq: number;
  /** When the current AI turn was armed (staleness check for a lost promise). */
  aiTurnStartedAt?: number;
  spoke: boolean;
  lastActivityAt: number;
}

export function initBATTLESHIPService(d: BATTLESHIPDeps): void {
  deps = d;
}

function requireDeps(): BATTLESHIPDeps {
  if (!deps) throw new Error('Battleship service not initialized');
  return deps;
}

function emptyGrid(): BATTLESHIPGrid {
  return {
    cells: Array.from({ length: ROWS }, () => Array(COLS).fill('empty')),
    ships: [],
  };
}

function applyFleet(grid: BATTLESHIPGrid, fleet: ReadonlyArray<BATTLESHIPPlacement>): void {
  grid.ships = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      grid.cells[r][c] = 'empty';
    }
  }
  for (const placement of fleet) {
    const cells = placementCells(placement);
    for (const cell of cells) {
      grid.cells[cell.row][cell.col] = 'ship';
    }
    grid.ships.push({
      name: placement.name,
      size: SHIP_SIZES[placement.name],
      cells,
      sunk: false,
    });
  }
}

function placeShipsRandomly(grid: BATTLESHIPGrid): void {
  applyFleet(grid, randomFleetPlacement());
}

/** True when the fleet covers all five names exactly once, on the board, without overlaps. */
function isCompleteFleet(fleet: ReadonlyArray<BATTLESHIPPlacement>): boolean {
  if (fleet.length !== SHIP_NAMES.length) return false;
  const seen = new Set<BATTLESHIPPlacement['name']>();
  let occupied: Array<{ row: number; col: number }> = [];
  for (const placement of fleet) {
    if (seen.has(placement.name)) return false;
    seen.add(placement.name);
    if (!placementFits(placement, occupied)) return false;
    occupied = occupied.concat(placementCells(placement));
  }
  return SHIP_NAMES.every((name) => seen.has(name));
}

function visibleFromGrid(grid: BATTLESHIPGrid): BATTLESHIPGrid {
  return {
    cells: grid.cells.map((row) => row.map((cell) => (cell === 'ship' ? 'empty' : cell))),
    ships: [],
  };
}

function snapshot(s: Session): BATTLESHIPGameState {
  return {
    gameId: s.gameId,
    characterId: s.characterId,
    status: s.status,
    playerGrid: s.playerGrid,
    aiVisibleGrid: s.aiVisibleGrid,
    turn: s.turn,
    aiThinking: s.aiThinking,
    pendingAiMove: s.pendingAiMove,
    result: s.result,
    history: s.history,
    shotsFired: s.shotsFired,
  };
}

function push(s: Session): BATTLESHIPGameState {
  const state = snapshot(s);
  // A dead window must never be able to stall a turn: a throwing push used to
  // escape the AI turn's catch (the fallback pushed too) and leave the board
  // armed on the AI forever.
  try {
    requireDeps().pushState(state);
  } catch { /* window gone; the next getState reconciles */ }
  return state;
}

export function isBATTLESHIPActive(characterId: string): boolean {
  const s = sessions.get(characterId);
  return !!s && s.status !== 'ended';
}

export function getBATTLESHIPState(characterId: string): BATTLESHIPGameState | null {
  const s = sessions.get(characterId);
  return s ? snapshot(s) : null;
}

export async function startBATTLESHIP(
  characterId: string,
  opts?: BATTLESHIPStartOpts,
): Promise<BATTLESHIPGameState> {
  const d = requireDeps();
  if (d.isSummoned(characterId)) {
    throw new Error(`${BATTLESHIP_ERR_MC_ACTIVE}: disconnect the Minecraft session to play Battleship`);
  }
  const existing = sessions.get(characterId);
  if (existing && existing.status !== 'ended') {
    return snapshot(existing);
  }
  if (existing) sessions.delete(characterId);
  const startGuard = beginSessionStart();

  const playerStarts = opts?.playerStarts ?? true;

  const s: Session = {
    gameId: randomUUID(),
    characterId,
    playerGrid: emptyGrid(),
    aiGrid: emptyGrid(),
    aiVisibleGrid: emptyGrid(),
    turn: playerStarts ? 'player' : 'ai',
    status: 'preparing',
    pendingPlayerStarts: playerStarts,
    aiThinking: false,
    pendingAiMove: null,
    result: null,
    history: [],
    shotsFired: 0,
    startedAt: Date.now(),
    turnCtrl: null,
    turnSeq: 0,
    spoke: false,
    lastActivityAt: Date.now(),
  };
  // The player's own fleet is empty until they confirm their placement;
  // the AI's fleet is hidden and random.
  placeShipsRandomly(s.aiGrid);
  s.aiVisibleGrid = visibleFromGrid(s.aiGrid);
  sessions.set(characterId, s);

  if (!startGuard.stillValid()) {
    sessions.delete(characterId);
    throw accountSwitchingError();
  }
  push(s);

  void (async () => {
    try {
      const { capture } = await loadAnalytics();
      capture('battleship_game_started', {
        character_id: characterId,
        player_starts: playerStarts,
      });
    } catch { /* analytics is never load-bearing */ }
  })();

  return snapshot(s);
}

/**
 * Confirm the player's own fleet and open the battle. `ships` is the fleet the
 * renderer drew (all five ships); `null` means "place it randomly". The phase
 * exists because the board used to be filled behind the player's back.
 */
export async function placeFleet(
  characterId: string,
  ships: BATTLESHIPPlacement[] | null,
): Promise<BATTLESHIPGameState> {
  const s = sessions.get(characterId);
  if (!s || s.status !== 'preparing') {
    throw new Error('no Battleship game is waiting for ship placement');
  }
  const fleet = ships ?? randomFleetPlacement();
  if (!isCompleteFleet(fleet)) {
    throw new Error('invalid Battleship fleet placement');
  }

  applyFleet(s.playerGrid, fleet);
  s.status = 'active';
  s.startedAt = Date.now();
  s.lastActivityAt = Date.now();
  s.turn = s.pendingPlayerStarts ? 'player' : 'ai';
  push(s);

  if (s.turn !== 'player') enqueueAiMove(s);
  return snapshot(s);
}

export async function playerMove(
  characterId: string,
  row: number,
  col: number,
): Promise<{ ok: boolean; error?: string; state: BATTLESHIPGameState }> {
  const s = sessions.get(characterId);
  if (!s || s.status !== 'active') {
    throw new Error('no active Battleship game');
  }
  rearmIfWedged(s);
  if (s.aiThinking || s.pendingAiMove || s.turn !== 'player') {
    return { ok: false, error: 'not your turn', state: snapshot(s) };
  }
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) {
    return { ok: false, error: 'out of bounds', state: snapshot(s) };
  }
  const already = s.aiVisibleGrid.cells[row][col];
  if (already === 'hit' || already === 'miss') {
    return { ok: false, error: 'already fired there', state: snapshot(s) };
  }
  applyPlayerShot(s, row, col);
  s.lastActivityAt = Date.now();
  s.turn = nextTurn(s);
  const state = push(s);
  if (checkGameOver(s)) return { ok: true, state: snapshot(s) };
  enqueueAiMove(s);
  return { ok: true, state };
}

export async function resign(characterId: string): Promise<BATTLESHIPGameState> {
  const s = requireActive(characterId);
  endSession(s, { winner: 'ai', reason: 'resign' });
  return snapshot(s);
}

export async function rematch(characterId: string): Promise<BATTLESHIPGameState> {
  const old = sessions.get(characterId);
  if (!old || old.status !== 'ended') throw new Error('no finished game to rematch');
  sessions.delete(characterId);
  return startBATTLESHIP(characterId, { playerStarts: old.turn === 'player' });
}

export async function endBATTLESHIP(characterId: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return;
  if (s.status !== 'ended') {
    endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
  }
  sessions.delete(characterId);
}

// ── analytics + continuity OUT ───────────────────────────────────────────────

function endSession(
  s: Session,
  result: BATTLESHIPResult,
  opts?: { silent?: boolean },
): void {
  s.turnSeq++;
  try { s.turnCtrl?.abort(); } catch { /* already done */ }
  s.turnCtrl = null;
  s.aiThinking = false;
  s.pendingAiMove = null;
  s.status = 'ended';
  s.result = result;
  push(s);

  const durationMs = Date.now() - s.startedAt;
  void (async () => {
    try {
      const { capture } = await loadAnalytics();
      capture('battleship_game_ended', {
        character_id: s.characterId,
        duration_ms: durationMs,
        shots: s.shotsFired,
        reason: result.reason,
        outcome: result.winner === null ? 'draw' : result.winner === 'player' ? 'player' : 'ai',
      });
    } catch { /* analytics is never load-bearing */ }
  })();

  // Continuity OUT: transcript play row, then foldIfDue.
  if (result.reason !== 'abandoned' || s.history.length > 0 || s.spoke) {
    void trackScopedWrite((async () => {
      let name = 'your companion';
      try {
        const c = await getCharacter(s.characterId);
        if (c?.name) name = c.name;
      } catch { /* generic name */ }
      const ev: ChatMessage = {
        id: randomUUID(),
        role: 'system',
        text: BATTLESHIPSummaryText(name, result, s.shotsFired, durationMs),
        ts: Date.now(),
        event: { kind: 'play', game: 'Battleship', durationMs },
      };
      try {
        const { appendMessage } = await import('../chat/chatStore');
        await appendMessage(s.characterId, ev);
        requireDeps().pushChatMessage(s.characterId, ev);
      } catch { /* best-effort */ }
      if (!opts?.silent) void foldIfDue(s.characterId, 'app').catch(() => {});
    })());
  }
}

function BATTLESHIPSummaryText(
  name: string,
  result: BATTLESHIPResult,
  shotCount: number,
  durationMs: number,
): string {
  if (result.reason === 'abandoned') {
    return `You and ${name} left a Battleship game unfinished.`;
  }
  if (result.winner === null) {
    return `You and ${name} drew a Battleship game after ${shotCount} shots.`;
  }
  const won = result.winner === 'player';
  return won
    ? `You beat ${name} at Battleship in ${shotCount} shots.`
    : `${name} beat you at Battleship in ${shotCount} shots.`;
}

// ── internals ────────────────────────────────────────────────────────────────

function requireActive(id: string): Session {
  const s = sessions.get(id);
  if (!s || s.status !== 'active') throw new Error('no active Battleship game');
  return s;
}

function shipAt(grid: BATTLESHIPGrid, row: number, col: number): BATTLESHIPShip | null {
  for (const ship of grid.ships) {
    if (ship.cells.some((cell) => cell.row === row && cell.col === col)) return ship;
  }
  return null;
}

function allShipsSunk(grid: BATTLESHIPGrid): boolean {
  return grid.ships.length > 0 && grid.ships.every((ship) => ship.sunk);
}

function applyPlayerShot(s: Session, row: number, col: number): void {
  s.shotsFired++;
  const ship = shipAt(s.aiGrid, row, col);
  if (ship) {
    s.aiGrid.cells[row][col] = 'hit';
    s.aiVisibleGrid.cells[row][col] = 'hit';
    const hitCells = ship.cells.filter((cell) =>
      s.aiGrid.cells[cell.row][cell.col] === 'hit',
    );
    if (hitCells.length === ship.cells.length) {
      ship.sunk = true;
      for (const cell of ship.cells) {
        s.aiGrid.cells[cell.row][cell.col] = 'sunk';
        s.aiVisibleGrid.cells[cell.row][cell.col] = 'sunk';
      }
      s.history.push({ row, col, hit: true, sunkShip: ship.name });
    } else {
      s.history.push({ row, col, hit: true, sunkShip: null });
    }
  } else {
    s.aiGrid.cells[row][col] = 'miss';
    s.aiVisibleGrid.cells[row][col] = 'miss';
    s.history.push({ row, col, hit: false, sunkShip: null });
  }
}

function applyAiShot(s: Session, row: number, col: number): void {
  const ship = shipAt(s.playerGrid, row, col);
  if (ship) {
    s.playerGrid.cells[row][col] = 'hit';
    const hitCells = ship.cells.filter((cell) =>
      s.playerGrid.cells[cell.row][cell.col] === 'hit',
    );
    if (hitCells.length === ship.cells.length) {
      ship.sunk = true;
      for (const cell of ship.cells) {
        s.playerGrid.cells[cell.row][cell.col] = 'sunk';
      }
      s.history.push({ row, col, hit: true, sunkShip: ship.name });
    } else {
      s.history.push({ row, col, hit: true, sunkShip: null });
    }
  } else {
    s.playerGrid.cells[row][col] = 'miss';
    s.history.push({ row, col, hit: false, sunkShip: null });
  }
}

function checkGameOver(s: Session): boolean {
  const aiSunk = allShipsSunk(s.aiGrid);
  const playerSunk = allShipsSunk(s.playerGrid);
  if (aiSunk && playerSunk) {
    endSession(s, { winner: null, reason: 'all-ships-sunk' });
    return true;
  }
  if (aiSunk) {
    endSession(s, { winner: 'player', reason: 'all-ships-sunk' });
    return true;
  }
  if (playerSunk) {
    endSession(s, { winner: 'ai', reason: 'all-ships-sunk' });
    return true;
  }
  return false;
}

function nextTurn(s: Session): 'player' | 'ai' {
  return s.turn === 'player' ? 'ai' : 'player';
}

// ── AI move (LLM picks row, col) ─────────────────────────────────────────────

/**
 * A cell the AI has not fired at yet. The AI's shot record IS the player's grid
 * ('hit' / 'miss' / 'sunk' were written by applyAiShot); 'ship' still reads as
 * an unfired cell because the player's fleet is hidden from the AI.
 *
 * aiVisibleGrid is the PLAYER's view of the AI's own board and must never be
 * used here: doing so made every AI turn accept a cell it had already bombed,
 * so the board never changed and the companion looked like it was not playing.
 */
function aiCanFireAt(s: Session, row: number, col: number): boolean {
  const cell = s.playerGrid.cells[row][col];
  return cell === 'empty' || cell === 'ship';
}

function aiLegalCells(s: Session): Array<{ row: number; col: number }> {
  const out: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (aiCanFireAt(s, r, c)) out.push({ row: r, col: c });
    }
  }
  return out;
}

const FIRE_TOOL = {
  name: 'fire',
  description:
    'Fire a shot at a cell on the player\'s 10x10 grid. Give row (0-9) and col (0-9). ' +
    'Only legal cells (not already fired at) may be targeted.',
  input_schema: {
    type: 'object' as const,
    properties: {
      row: { type: 'number', description: 'Row 0-9 (top to bottom).' },
      col: { type: 'number', description: 'Column 0-9 (left to right).' },
    },
    required: ['row', 'col'],
  },
};

const CONNECT4_MAX_HOPS = 5;
/** Hard wall-clock budget for one AI turn (the deadline race, not just an abort). */
const TURN_TIMEOUT_MS = 20_000;
/** Whole-turn ceiling: setup + provider call. Must exceed TURN_TIMEOUT_MS. */
const TURN_HARD_DEADLINE_MS = 28_000;

function enqueueAiMove(s: Session): void {
  if (s.status !== 'active' || s.turn !== 'ai') return;
  if (s.aiThinking) {
    // A turn that never settled must not block the next one forever: past its
    // own budget the flag is stale and this enqueue takes the turn over.
    const age = Date.now() - (s.aiTurnStartedAt ?? 0);
    if (age < TURN_HARD_DEADLINE_MS + 10_000) return;
    try { s.turnCtrl?.abort(); } catch { /* already done */ }
  }
  s.aiThinking = true;
  s.aiTurnStartedAt = Date.now();
  push(s);
  void runAiTurn(s);
}

/** Re-arm a wedged AI turn so a player click can never land on a dead board. */
function rearmIfWedged(s: Session): void {
  if (s.status !== 'active' || s.turn !== 'ai') return;
  if (s.aiThinking && Date.now() - (s.aiTurnStartedAt ?? 0) < TURN_HARD_DEADLINE_MS + 10_000) return;
  s.aiThinking = false;
  enqueueAiMove(s);
}

async function runAiTurn(s: Session): Promise<void> {
  // Setup (character read, config, chat history) can throw before the turn
  // guard is armed; catch it here so the board never freezes on the AI.
  const seq = s.turnSeq;
  // 261126: the whole turn is bounded, not just the provider call. A hung
  // history read sat before the LLM deadline and pinned aiThinking forever,
  // which made every later player move a silent no-op.
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  const hardDeadline = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => {
      const e = new Error(`Battleship turn exceeded ${TURN_HARD_DEADLINE_MS}ms`);
      e.name = 'TimeoutError';
      reject(e);
    }, TURN_HARD_DEADLINE_MS);
  });
  try {
    await Promise.race([runAiTurnUnsafe(s), hardDeadline]);
  } catch (err) {
    if (s.turnSeq !== seq) return;
    console.error(`[sei/battleship] AI turn failed: ${describeErr(err)}`);
    s.aiThinking = false;
    aiFallbackShot(s);
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
  }
  // Safety net: if the AI turn finished without firing and it's still the AI's
  // turn, fall back to a shot so the board never stalls on a yapping model.
  if (s.status === 'active' && s.turn === 'ai') {
    s.aiThinking = false;
    aiFallbackShot(s);
  }
}

async function runAiTurnUnsafe(s: Session): Promise<void> {
  const d = requireDeps();
  const character = await getCharacter(s.characterId);
  if (!character) {
    s.aiThinking = false;
    aiFallbackShot(s);
    return;
  }
  const config = await loadConfig();
  const playerName = (config.preferred_name ?? '').trim() || 'the player';
  const [{ history }] = await Promise.all([
    (async () => {
      const { readChatContext } = await import('../chat/continuity');
      return await readChatContext(s.characterId);
    })(),
  ]);

  // 261124: the games were the one surface with no language rule, so the
  // companion answered in whatever the transcript happened to be in.
  const lang = companionLanguageFor(character, config);
  const system = [
    `# Battleship (BATTLESHIP)`,
    `You are playing Battleship against ${playerName} inside the Sei app.`,
    `You are the AI; ${playerName} is the player.`,
    `You each have a hidden 10x10 grid with 5 ships: carrier (5), battleship (4), cruiser (3), submarine (3), destroyer (2).`,
    'You MUST call fire() exactly once every turn.',
    '',
    'BEFORE each shot, write ONE short line: a text message to the player about the game, reacting to their last shot, nudging them, groaning, gloating. One line, the length of a text message. Then call fire().',
    'The board shows your shot by itself, so NEVER describe or name the cell you are shooting at, in numbers or in words.',
    'Never open with "ok", "okay", "alright" or any variant. Never repeat the line you said last turn. If you have nothing specific to say, say nothing and just call fire().',
    '',
    'NEVER SAY COORDINATES OUT LOUD. Not the row, not the column, not "top left".',
    '',
    // 261124: the games were the one surface with no language rule, so the
    // companion answered in whatever the transcript happened to be in.
    renderLanguageDirective(lang.language),
    lang.adopted ? renderAdoptedLanguageNote(lang.language) : '',
  ].join('\n');

  // The AI's own view of the board it is shooting at: only its own hits and
  // misses are known, and the player's fleet reads as '.' exactly like a real
  // hidden grid.
  const boardText = s.playerGrid.cells
    .map((row) =>
      row.map((cell) => {
        if (cell === 'hit') return 'X';
        if (cell === 'miss') return 'o';
        if (cell === 'sunk') return '#';
        return '.';
      }).join(' '),
    )
    .join('\n');

  const legalCells = aiLegalCells(s);

  const messages: LlmMessage[] = [
    // Transcript rows carry roles the API does not know ('companion', plus
    // 'system' rows for play and call events), and a malformed role made the
    // whole game turn fail upstream. toMessages is the canonical mapper.
    ...toMessages(history ?? []),
    {
      role: 'user',
      content:
        `It is YOUR shot. Your view of the AI board (rows top to bottom, . = unknown, X = hit, o = miss, # = sunk):\n${boardText}\n\n` +
        `Legal cells: ${legalCells.map((cell) => `(${cell.row},${cell.col})`).join(', ')}. Call fire() with one of them.`,
    },
  ];

  const ctrl = new AbortController();
  s.turnCtrl = ctrl;
  const seq = s.turnSeq;
  const stale = () => s.turnSeq !== seq || ctrl.signal.aborted;
  /**
   * 261126: the board stalled on a turn whose provider call never settled (a
   * proxy 502 that keeps retrying, a fetch that ignores the abort signal). The
   * abort alone is not a deadline: the turn only ends when the call REJECTS, so
   * a hung call left aiThinking true forever and the board stuck mid-turn.
   * Race the call against a wall-clock deadline so the fallback shot always
   * happens.
   */
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      try { ctrl.abort(); } catch { /* already done */ }
      const e = new Error(`Battleship turn timed out after ${TURN_TIMEOUT_MS}ms`);
      e.name = 'TimeoutError';
      reject(e);
    }, TURN_TIMEOUT_MS);
  });

  let fired = false;
  // At most one line per turn, said right before the shot lands.
  let saidThisTurn = false;
  const spoken: ChatMessage[] = [];

  try {
    const llm = await buildLlmProvider();
    for (let hop = 0; hop < CONNECT4_MAX_HOPS && !stale(); hop++) {
      const res = await Promise.race([
        llm.call({
          maxTokens: 600,
          system,
          tools: [FIRE_TOOL, REMEMBER_TOOL],
          messages,
          timeoutMs: TURN_TIMEOUT_MS,
          signal: ctrl.signal,
        }),
        deadline,
      ]);

      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      // 261126: the AI turn used to be a black box. Log what the model actually
      // said so a dead board can be debugged from the terminal (Ouen's ask).
      logAiOutput(hop, res.content);

      // Battleship AI used to be silent (the board shows the move). 261126: one
      // short line per turn, spoken BEFORE the shot is applied, exactly like
      // Forza 4. Never more than one message: repeating it was the yapping.
      const line = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .split(/\n+/)
        .map((t) => t.trim())
        .find((t) => t.length > 0);
      if (line && !saidThisTurn) {
        saidThisTurn = true;
        await speak(s, line, spoken);
      }

      if (!toolUses.length) {
        // Prose only. Give the model one more hop to actually fire (some
        // providers answer with the line first and the tool call next).
        messages.push({ role: 'assistant', content: res.content as unknown as string });
        if (hop >= 1) break;
        continue;
      }

      messages.push({ role: 'assistant', content: res.content as unknown as string });
      const results: Array<string> = [];
      for (const tu of toolUses) {
        let note: string;
        if (tu.name === 'fire') {
          const input = tu.input as { row?: number; col?: number } | undefined;
          const rawRow = input?.row;
          const rawCol = input?.col;
          if (
            typeof rawRow !== 'number' || typeof rawCol !== 'number' ||
            !Number.isFinite(rawRow) || !Number.isFinite(rawCol) ||
            !Number.isInteger(rawRow) || !Number.isInteger(rawCol) ||
            rawRow < 0 || rawRow >= ROWS || rawCol < 0 || rawCol >= COLS ||
            !aiCanFireAt(s, rawRow, rawCol)
          ) {
            note = `(${rawRow},${rawCol}) is not a legal cell here. Legal cells: ${legalCells.map((cell) => `(${cell.row},${cell.col})`).join(', ')}. Call fire() again.`;
          } else if (fired) {
            note = 'You already fired your shot this turn.';
          } else {
            fired = true;
            applyAiShot(s, rawRow, rawCol);
            const state = push(s);
            s.shotsFired++;
            if (checkGameOver(s)) {
              // game over already ended the session
            } else {
              s.turn = 'player';
              s.aiThinking = false;
              push(s);
            }
            note = `You fire at (${rawRow},${rawCol}). The result shows on the board; do not call fire() again this turn.`;
          }
        } else if (tu.name === 'remember') {
          const memText = String((tu.input as { text?: string })?.text ?? '').trim();
          if (memText) {
            try {
              const written = await appendMemory(
                path.join(paths.memoryDir(s.characterId), 'MEMORY.md'),
                memText,
                undefined,
                { section: 'app' },
              );
              note =
                written === 0
                  ? 'You already saved that a moment ago; nothing new was written. Continue.'
                  : 'Saved. Continue; do not mention saving it.';
            } catch {
              note = 'Could not save it. Continue.';
            }
          } else {
            note = 'Nothing saved; the text was empty.';
          }
        } else {
          note = `The tool "${tu.name}" does nothing on this turn and never will. Do not call it again.`;
        }
        results.push(note);
      }
      messages.push({ role: 'user', content: results.join('\n') });

      if (fired) break;
    }

    if (stale()) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }

    if (!fired && s.status === 'active') {
      aiFallbackShot(s);
    }
  } catch (err) {
    if (s.turnSeq !== seq) return;
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.error(`[sei/battleship] AI turn timed out, firing a fallback shot`);
    } else if (!ctrl.signal.aborted) {
      console.error(`[sei/battleship] AI turn failed: ${describeErr(err)}`);
    }
    // The companion never blocks the board: on a failed or timed-out turn it
    // fires at a free cell and hands the turn back to the player.
    s.aiThinking = false;
    aiFallbackShot(s);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (s.turnCtrl === ctrl) s.turnCtrl = null;
    s.aiThinking = false;
  }
}

/**
 * Fire for the companion when the LLM turn produced nothing (error, timeout,
 * no tool call). Never re-enqueues: a failing model must not spin in a retry
 * loop while the player stares at a dead board.
 */
function chooseFallbackShot(
  s: Session,
  legal: ReadonlyArray<{ row: number; col: number }>,
): { row: number; col: number } | null {
  if (!legal.length) return null;
  const free = new Set(legal.map((cell) => cell.row * COLS + cell.col));
  const isFree = (row: number, col: number): boolean =>
    row >= 0 && row < ROWS && col >= 0 && col < COLS && free.has(row * COLS + col);
  const pick = (
    cells: ReadonlyArray<{ row: number; col: number }>,
  ): { row: number; col: number } =>
    cells[Math.floor(Math.random() * cells.length)] ?? legal[0];

  // Hunt/target: a cell NEXT TO one of our hits first, so a wounded ship gets
  // finished instead of the board being sprayed at random.
  const wounded: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = s.playerGrid.cells[r][c];
      if (cell !== 'hit') continue;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (isFree(r + dr, c + dc)) wounded.push({ row: r + dr, col: c + dc });
      }
    }
  }
  if (wounded.length) return pick(wounded);

  // Nothing wounded: sweep one parity of the board (a 10x10 grid holds every
  // ship of length 2+ on both parities, and a checkerboard halves the misses).
  const parity = legal.filter((cell) => (cell.row + cell.col) % 2 === 0);
  return pick(parity.length ? parity : legal);
}

function aiFallbackShot(s: Session): void {
  if (s.status !== 'active' || s.turn !== 'ai') return;
  const target = chooseFallbackShot(s, aiLegalCells(s));
  if (!target) {
    s.aiThinking = false;
    push(s);
    return;
  }
  applyAiShot(s, target.row, target.col);
  s.shotsFired++;
  s.aiThinking = false;
  push(s);
  if (!checkGameOver(s)) {
    s.turn = 'player';
    push(s);
  }
}

async function speak(
  s: Session,
  text: string,
  spoken: ChatMessage[],
): Promise<void> {
  const d = requireDeps();
  const parts = text.split(/\n+/).filter(Boolean);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const msg: ChatMessage = {
      id: randomUUID(),
      role: 'companion',
      text: trimmed,
      ts: Date.now(),
      ...(isCallActive(s.characterId) ? { voice: true } : {}),
    };
    spoken.push(msg);
    try {
      const { appendMessage } = await import('../chat/chatStore');
      await appendMessage(s.characterId, msg);
      d.pushChatMessage(s.characterId, msg);
      s.lastActivityAt = Date.now();
      s.spoke = true;
    } catch { /* best-effort */ }
  }
}

/** One line per LLM hop: what the model chose and what (if anything) it said. */
function logAiOutput(
  hop: number,
  content: ReadonlyArray<{ type: string; text?: string; name?: string; input?: unknown }>,
): void {
  const text = content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!.trim())
    .join(' ')
    .slice(0, 160);
  const tools = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => `${b.name}(${JSON.stringify(b.input ?? {})})`)
    .join(' ');
  console.log(
    `[sei/battleship] ai hop=${hop} tools=${tools || 'none'} text=${text ? JSON.stringify(text) : 'none'}`,
  );
}

function describeErr(err: unknown): string {
  const e = err as Error & { status?: number; cause?: Error };
  let out = `${e.name ?? 'Error'}: ${e.message}`;
  if (e.status !== undefined) out += ` status=${e.status}`;
  for (let c = e.cause; c; c = c.cause as Error | undefined) {
    out += ` <- ${c.name ?? 'Error'}: ${c.message}`;
  }
  return out;
}

// ── account switch + shutdown ────────────────────────────────────────────────

export function endAllBATTLESHIP(reason: string): void {
  for (const s of [...sessions.values()]) {
    if (s.status !== 'ended') {
      endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
    }
    sessions.delete(s.characterId);
  }
}

export async function shutdownBATTLESHIP(): Promise<void> {
  for (const s of sessions.values()) {
    if (s.status !== 'ended') {
      endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
    }
    try { s.turnCtrl?.abort(); } catch { /* already down */ }
  }
  sessions.clear();
}
