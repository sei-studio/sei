/**
 * Battleship (Battleship) minigame IPC contract.
 *
 * Two 10x10 grids (player + AI), 5 ships each. The game opens in
 * `preparing`: the player places their own fleet (or rolls a random one) and
 * confirms; then players alternate firing (row, col) and win when all
 * opposing ships are sunk.
 * The AI's column/row is chosen by the LLM from a `fire(row, col)` tool — no
 * external engine, no model download.
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
  shotsFired: number;
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

/** A fresh random fleet, one ship of each name. */
export function randomFleetPlacement(): BATTLESHIPPlacement[] {
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
 *   BATTLESHIPEnd(characterId): Promise<void>
 *   onBATTLESHIPState(cb: (state: BATTLESHIPGameState) => void): () => void
 */
