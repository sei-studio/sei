import type { MinigameTurnFailure } from './minigameTurn';

/**
 * Fleet Battle minigame (internal id BATTLESHIP) IPC contract. The
 * user-facing and model-facing name is "Fleet Battle".
 *
 * Two 10x10 grids (player + character), 5 ships each. The game opens in
 * `preparing`: the player places their own fleet (or rolls a random one) and
 * confirms while the character places its own with a `place_fleet` tool call;
 * the battle opens once both fleets are ready. Then the two alternate shots
 * and win when every opposing ship is sunk.
 *
 * Every shot of the character's is its own `fire(cell)` tool call (cells are
 * named like the board labels: row A-J, column 1-10). The engine only
 * enforces the rules and never shoots or places ships for it: a turn the
 * character could not finish stops in `aiTurnFailed` until the player presses
 * Try again (BATTLESHIP:retry).
 *
 * Mutually exclusive with Minecraft summon per character.
 */

export type BATTLESHIPShipName =
  | 'carrier'
  | 'battleship'
  | 'cruiser'
  | 'submarine'
  | 'destroyer';

export interface BATTLESHIPShip {
  name: BATTLESHIPShipName;
  size: number;
  cells: Array<{ row: number; col: number }>;
  sunk: boolean;
}

export type BATTLESHIPCell =
  | 'empty'
  | 'ship'
  | 'hit'
  | 'miss'
  | 'sunk';

export interface BATTLESHIPGrid {
  cells: BATTLESHIPCell[][];
  ships: BATTLESHIPShip[];
}

export interface BATTLESHIPShotRecord {
  /** 261127: who fired. history holds both sides' shots in order. */
  by: 'player' | 'ai';
  row: number;
  col: number;
  hit: boolean;
  sunkShip: BATTLESHIPShipName | null;
}

export type BATTLESHIPEndReason =
  | 'all-ships-sunk'
  | 'resign'
  | 'abandoned';

export interface BATTLESHIPResult {
  winner: 'player' | 'ai' | null;
  reason: BATTLESHIPEndReason;
}

export type BATTLESHIPGameStatus = 'preparing' | 'active' | 'ended';

export interface BATTLESHIPGameState {
  gameId: string;
  characterId: string;
  status: BATTLESHIPGameStatus;
  playerGrid: BATTLESHIPGrid;
  aiVisibleGrid: BATTLESHIPGrid; // hits/misses only from player's view
  turn: 'player' | 'ai';
  aiThinking: boolean;
  pendingAiMove: { row: number; col: number } | null;
  result: BATTLESHIPResult | null;
  history: BATTLESHIPShotRecord[];
  /** Total shots, both sides (playerShots + aiShots). */
  shotsFired: number;
  playerShots: number;
  aiShots: number;
  /** Who fires first once both fleets are ready (alternates on rematch). */
  playerStarts: boolean;
  /** True once the player confirmed their fleet. */
  playerFleetPlaced: boolean;
  /**
   * The character's own fleet placement (a tool call at game start):
   * 'placing' while it decides, 'ready' once a valid fleet is on its board,
   * 'failed' when it could not place one (aiTurnFailed says why).
   */
  aiFleet: 'placing' | 'ready' | 'failed';
  /** 261127: the character's turn (placement or shot) could not be finished. */
  aiTurnFailed: MinigameTurnFailure | null;
}

export const BATTLESHIP_ERR_MC_ACTIVE =
  'battleship:mc-active';

export const SHIP_SIZES: Record<BATTLESHIPShipName, number> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  destroyer: 2,
};

export const BATTLESHIP_ROWS = 10;
export const BATTLESHIP_COLS = 10;
export const BATTLESHIP_SHIP_NAMES: BATTLESHIPShipName[] =
  ['carrier', 'battleship', 'cruiser', 'submarine', 'destroyer'];

/** One ship of the player's fleet, as placed on their own grid. */
export interface BATTLESHIPPlacement {
  name: BATTLESHIPShipName;
  row: number;
  col: number;
  horizontal: boolean;
}

/** The cells a ship occupies, top-left anchored at (row, col). */
export function placementCells(
  p: BATTLESHIPPlacement,
): Array<{ row: number; col: number }> {
  const size = SHIP_SIZES[p.name];
  const cells: Array<{ row: number; col: number }> = [];
  for (let i = 0; i < size; i++) {
    cells.push({
      row: p.horizontal ? p.row : p.row + i,
      col: p.horizontal ? p.col + i : p.col,
    });
  }
  return cells;
}

/** True when the ship sits on the board and misses every occupied cell. */
export function placementFits(
  p: BATTLESHIPPlacement,
  occupied: ReadonlyArray<{ row: number; col: number }>,
): boolean {
  return placementCells(p).every(
    (c) =>
      c.row >= 0 &&
      c.row < BATTLESHIP_ROWS &&
      c.col >= 0 &&
      c.col < BATTLESHIP_COLS &&
      !occupied.some((o) => o.row === c.row && o.col === c.col),
  );
}

/** Every cell covered by the fleet (assumes it is already valid). */
export function fleetCells(
  fleet: ReadonlyArray<BATTLESHIPPlacement>,
): Array<{ row: number; col: number }> {
  return fleet.flatMap((p) => placementCells(p));
}

/**
 * A fresh random fleet for the PLAYER's "Random" button, one ship of each
 * name. Never used for the character's fleet (it places its own).
 */
export function randomFleetPlacement(): BATTLESHIPPlacement[] {
  // One pass can paint itself into a corner (rare, but the old single pass
  // then returned a 4-ship fleet that the confirm step rejected). Retry the
  // whole fleet until all five fit.
  for (let tries = 0; tries < 50; tries++) {
    const fleet = randomFleetOnce();
    if (fleet.length === BATTLESHIP_SHIP_NAMES.length) return fleet;
  }
  return randomFleetOnce();
}

function randomFleetOnce(): BATTLESHIPPlacement[] {
  const fleet: BATTLESHIPPlacement[] = [];
  let occupied: Array<{ row: number; col: number }> = [];
  for (const name of BATTLESHIP_SHIP_NAMES) {
    const size = SHIP_SIZES[name];
    for (let attempt = 0; attempt < 400; attempt++) {
      const horizontal = Math.random() < 0.5;
      const row = Math.floor(
        Math.random() * (horizontal ? BATTLESHIP_ROWS : BATTLESHIP_ROWS - size + 1),
      );
      const col = Math.floor(
        Math.random() * (horizontal ? BATTLESHIP_COLS - size + 1 : BATTLESHIP_COLS),
      );
      const candidate: BATTLESHIPPlacement = { name, row, col, horizontal };
      if (!placementFits(candidate, occupied)) continue;
      fleet.push(candidate);
      occupied = occupied.concat(placementCells(candidate));
      break;
    }
  }
  return fleet;
}

/**
 * window.sei surface (Battleship):
 *
 *   BATTLESHIPStart(characterId): Promise<BATTLESHIPGameState>
 *   BATTLESHIPGetState(characterId): Promise<BATTLESHIPGameState | null>
 *   BATTLESHIPPlaceFleet(characterId, ships | null): Promise<BATTLESHIPGameState>
 *   BATTLESHIPMove(characterId, {row, col}): Promise<{ok, error?, state}>
 *   BATTLESHIPResign(characterId): Promise<BATTLESHIPGameState>
 *   BATTLESHIPRematch(characterId): Promise<BATTLESHIPGameState>
 *     New game against the same character; the other side fires first.
 *   BATTLESHIPRetry(characterId): Promise<BATTLESHIPGameState>
 *     Run the character's failed turn (placement or shot) again.
 *   BATTLESHIPEnd(characterId): Promise<void>
 *   onBATTLESHIPState(cb: (state: BATTLESHIPGameState) => void): () => void
 */

// ── cell names + fleet validation (261127) ───────────────────────────────────

/** Row letters as the board labels them, top to bottom. */
export const BATTLESHIP_ROW_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const;

/** "B7" for row 1, col 6: the name the board shows (row letter, column 1-10). */
export function battleshipCellName(row: number, col: number): string {
  return `${BATTLESHIP_ROW_LETTERS[row] ?? '?'}${col + 1}`;
}

/**
 * Parse a cell name the way a person writes it: "B7", "b 7", "B-7", "7B".
 * Null when it is not a cell on the 10x10 board.
 */
export function parseBattleshipCell(raw: unknown): { row: number; col: number } | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase().replace(/[\s\-_,.:()]/g, '');
  let m = /^([A-J])(10|[1-9])$/.exec(t);
  let letter: string;
  let num: string;
  if (m) {
    letter = m[1];
    num = m[2];
  } else {
    m = /^(10|[1-9])([A-J])$/.exec(t);
    if (!m) return null;
    num = m[1];
    letter = m[2];
  }
  const row = BATTLESHIP_ROW_LETTERS.indexOf(letter as (typeof BATTLESHIP_ROW_LETTERS)[number]);
  const col = Number(num) - 1;
  if (row < 0 || col < 0 || col >= BATTLESHIP_COLS) return null;
  return { row, col };
}

/**
 * Why a fleet is not a legal setup (all five ships exactly once, on the board,
 * no overlaps), or null when it is. Plain words: the character reads this as
 * a tool error and fixes its placement.
 */
export function fleetProblem(fleet: ReadonlyArray<BATTLESHIPPlacement>): string | null {
  const names = fleet.map((p) => p.name);
  for (const name of BATTLESHIP_SHIP_NAMES) {
    const n = names.filter((x) => x === name).length;
    if (n === 0) return `The ${name} is missing.`;
    if (n > 1) return `The ${name} is placed more than once.`;
  }
  if (fleet.length !== BATTLESHIP_SHIP_NAMES.length) return 'A fleet has exactly five ships.';
  const taken: Array<{ row: number; col: number; name: BATTLESHIPShipName }> = [];
  for (const p of fleet) {
    for (const c of placementCells(p)) {
      if (c.row < 0 || c.row >= BATTLESHIP_ROWS || c.col < 0 || c.col >= BATTLESHIP_COLS) {
        return `The ${p.name} runs off the board.`;
      }
      const clash = taken.find((o) => o.row === c.row && o.col === c.col);
      if (clash) {
        return `The ${p.name} and the ${clash.name} overlap at ${battleshipCellName(c.row, c.col)}.`;
      }
      taken.push({ ...c, name: p.name });
    }
  }
  return null;
}
