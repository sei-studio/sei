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
  BATTLESHIPResult,
  BATTLESHIPShip,
  BATTLESHIPShipName,
  BATTLESHIPShotRecord,
} from '../../shared/battleshipIpc';
import { BATTLESHIP_ERR_MC_ACTIVE } from '../../shared/battleshipIpc';
import { buildLlmProvider } from '../llm';
import { loadAnalytics } from '../lazyAnalytics';
import { getCharacter } from '../characterStore';
import { loadConfig } from '../configStore';
import { accountSwitchingError, beginSessionStart, trackScopedWrite } from '../profile/scopeBarrier';
import { appendMemory } from '../../bot/brain/memory/memoryLog.js';
import { paths } from '../paths';
import { isCallActive } from '../voice/callState';
import { foldIfDue } from '../chat/continuity';
import { REMEMBER_TOOL } from '../chat/chatPrompts';
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
  aiThinking: boolean;
  pendingAiMove: { row: number; col: number } | null;
  result: BATTLESHIPResult | null;
  history: BATTLESHIPShotRecord[];
  shotsFired: number;
  startedAt: number;
  turnCtrl: AbortController | null;
  turnSeq: number;
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

function placeShipsRandomly(grid: BATTLESHIPGrid): void {
  grid.ships = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      grid.cells[r][c] = 'empty';
    }
  }
  for (const name of SHIP_NAMES) {
    const size = SHIP_SIZES[name];
    let placed = false;
    for (let attempt = 0; attempt < 200 && !placed; attempt++) {
      const horizontal = Math.random() < 0.5;
      const r = Math.floor(Math.random() * ROWS);
      const c = Math.floor(Math.random() * COLS);
      const cells: Array<{ row: number; col: number }> = [];
      let ok = true;
      for (let i = 0; i < size; i++) {
        const rr = horizontal ? r : r + i;
        const cc = horizontal ? c + i : c;
        if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || grid.cells[rr][cc] !== 'empty') {
          ok = false;
          break;
        }
        cells.push({ row: rr, col: cc });
      }
      if (!ok) continue;
      for (const cell of cells) {
        grid.cells[cell.row][cell.col] = 'ship';
      }
      grid.ships.push({ name, size, cells, sunk: false });
      placed = true;
    }
    if (!placed) {
      for (let r = 0; r < ROWS && !placed; r++) {
        for (let c = 0; c <= COLS - SHIP_SIZES[name] && !placed; c++) {
          let ok = true;
          for (let i = 0; i < SHIP_SIZES[name]; i++) {
            if (grid.cells[r][c + i] !== 'empty') { ok = false; break; }
          }
          if (!ok) continue;
          const cells: Array<{ row: number; col: number }> = [];
          for (let i = 0; i < SHIP_SIZES[name]; i++) {
            grid.cells[r][c + i] = 'ship';
            cells.push({ row: r, col: c + i });
          }
          grid.ships.push({ name, size: SHIP_SIZES[name], cells, sunk: false });
          placed = true;
        }
      }
    }
  }
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
  requireDeps().pushState(state);
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
    status: 'active',
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
  placeShipsRandomly(s.playerGrid);
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
const TURN_TIMEOUT_MS = 90_000;

function enqueueAiMove(s: Session): void {
  if (s.status !== 'active' || s.turn !== 'ai') return;
  if (s.aiThinking) return;
  s.aiThinking = true;
  push(s);
  void runAiTurn(s);
}

async function runAiTurn(s: Session): Promise<void> {
  const d = requireDeps();
  const character = await getCharacter(s.characterId);
  if (!character) {
    s.aiThinking = false;
    s.turn = 'player';
    push(s);
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

  const system = [
    `# Battleship (BATTLESHIP)`,
    `You are playing Battleship against ${playerName} inside the Sei app.`,
    `You are the AI; ${playerName} is the player.`,
    `You each have a hidden 10x10 grid with 5 ships: carrier (5), battleship (4), cruiser (3), submarine (3), destroyer (2).`,
    'Every plain-text line you write is spoken out loud at the board, exactly as written.',
    '',
    'TALK ABOUT THE GAME. React to their last shot, say what you are going for, needle them, complain, gloat. Keep it short — one line. Never open with "ok", "okay", "alright", or any variant. If you have nothing specific to say, say nothing at all.',
    '',
    'NEVER SAY COORDINATES OUT LOUD. Point at cells in words instead ("top left", "center", "bottom right").',
    '',
    'Do not announce the cell you are about to fire at: the board shows it by itself.',
  ].join('\n');

  // Build a player-visible board (hits/misses only on AI grid; player's own grid hidden from AI view text).
  const boardText = s.aiVisibleGrid.cells
    .map((row, r) =>
      row.map((cell, c) => {
        if (cell === 'hit') return 'X';
        if (cell === 'miss') return 'o';
        if (cell === 'sunk') return '#';
        return '.';
      }).join(' '),
    )
    .join('\n');

  const legalCells: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = s.aiVisibleGrid.cells[r][c];
      if (cell === 'empty') legalCells.push({ row: r, col: c });
    }
  }

  const messages: LlmMessage[] = [
    ...(history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text })),
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
  const timeout = setTimeout(() => ctrl.abort(), TURN_TIMEOUT_MS);

  const spoken: ChatMessage[] = [];
  let fired = false;

  try {
    const llm = await buildLlmProvider();
    for (let hop = 0; hop < CONNECT4_MAX_HOPS && !stale(); hop++) {
      const res = await llm.call({
        maxTokens: 160,
        system,
        tools: [FIRE_TOOL, REMEMBER_TOOL],
        messages,
        timeoutMs: 90_000,
        signal: ctrl.signal,
      });

      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) await speak(s, text, spoken);

      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) break;

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
            rawRow < 0 || rawRow >= ROWS || rawCol < 0 || rawCol >= COLS ||
            s.aiVisibleGrid.cells[rawRow][rawCol] !== 'empty'
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
      const cell = legalCells[0];
      if (cell) {
        applyAiShot(s, cell.row, cell.col);
        s.shotsFired++;
        const state = push(s);
        if (!checkGameOver(s)) {
          s.turn = 'player';
          s.aiThinking = false;
          push(s);
        }
      }
    }
  } catch (err) {
    if (ctrl.signal.aborted || s.turnSeq !== seq) return;
    console.error(`[sei/battleship] AI turn failed: ${describeErr(err)}`);
    s.aiThinking = false;
    push(s);
  } finally {
    clearTimeout(timeout);
    if (s.turnCtrl === ctrl) s.turnCtrl = null;
    s.aiThinking = false;
    if (s.status === 'active' && s.turn === 'ai') {
      void enqueueAiMove(s);
    }
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
