/**
 * Battleship (Battleship) minigame IPC contract.
 *
 * Two 10x10 grids (player + AI), 5 ships each placed randomly at start.
 * Players alternate firing (row, col); win when all opposing ships are sunk.
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

/**
 * window.sei surface (Battleship):
 *
 *   BATTLESHIPStart(characterId): Promise<BATTLESHIPGameState>
 *   BATTLESHIPGetState(characterId): Promise<BATTLESHIPGameState | null>
 *   BATTLESHIPMove(characterId, {row, col}): Promise<{ok, error?, state}>
 *   BATTLESHIPResign(characterId): Promise<BATTLESHIPGameState>
 *   BATTLESHIPRematch(characterId): Promise<BATTLESHIPGameState>
 *   BATTLESHIPEnd(characterId): Promise<void>
 *   onBATTLESHIPState(cb: (state: BATTLESHIPGameState) => void): () => void
 */
