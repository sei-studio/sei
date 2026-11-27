/**
 * Four in a Row minigame (internal id CONNECT4): shared renderer <-> main
 * contract. The user-facing and model-facing name is "Four in a Row".
 *
 * Authority split, mirroring chess (src/shared/chessIpc.ts):
 *
 *   main      owns the game: board (6x7), turn sequencing, win/draw detection,
 *             the character's column pick via its own LLM `play` tool call
 *             (never an engine move; a failed turn stops in `aiTurnFailed`
 *             until the player presses Try again), and full
 *             CONNECT4GameState snapshots pushed on CONNECT4:state.
 *   renderer  owns the board view (column clicks, cell colors) and reflects
 *             pushed state. It never decides anything.
 *
 * One game per character, mutually exclusive with chess / Draw! / Minecraft
 * summon via the gameLaunch cross-launch gate.
 */

import type { MinigameTurnFailure } from './minigameTurn';

export type CONNECT4Color = 'r' | 'y';

export interface CONNECT4Cell {
  r: number; // 0..5 top->bottom
  c: number; // 0..6 left->right
}

export interface CONNECT4MoveRecord {
  column: number;
  row: number;
  color: CONNECT4Color;
}

export type CONNECT4EndReason =
  | 'connect-four'   // someone made 4 in a row
  | 'draw'           // full board, no winner
  | 'resign'         // player resigned
  | 'forfeit'        // the character forfeited
  | 'abandoned';     // game closed without a result

export interface CONNECT4Result {
  winner: CONNECT4Color | null; // null = draw / abandoned
  reason: CONNECT4EndReason;
}

export type CONNECT4GameStatus = 'preparing' | 'active' | 'ended';

export interface CONNECT4GameState {
  gameId: string;
  characterId: string;
  status: CONNECT4GameStatus;
  /** 6 rows x 7 columns; null = empty cell. */
  board: Array<Array<CONNECT4Color | null>>;
  /** Side to move in `board`. */
  turn: CONNECT4Color;
  /** Color the player plays as. */
  playerColor: CONNECT4Color;
  /** True while the character is deciding its column. */
  aiThinking: boolean;
  /** The character's decided column, waiting on the renderer (no reveal gate
   *  for Four in a Row: commits immediately once decided). */
  pendingAiMove: { column: number } | null;
  result: CONNECT4Result | null;
  history: CONNECT4MoveRecord[];
  moves: number; // total plies played
  /**
   * 261127: set when the character could not make its move (every attempt
   * failed). The board waits; Try again (CONNECT4:retry) runs the turn again.
   * Null while the turn is fine or not the character's.
   */
  aiTurnFailed: MinigameTurnFailure | null;
}

/** Typed error codes thrown by CONNECT4Start (surface as popups, not toasts). */
export const CONNECT4_ERR_MC_ACTIVE = 'CONNECT4_MC_SESSION_ACTIVE';

/**
 * window.sei surface (implemented in src/preload/index.ts):
 *
 *   CONNECT4Start(characterId: string, opts?: { playerColor?: 'r' | 'y' | 'random' }): Promise<CONNECT4GameState>
 *     Starts (or resumes) the character's game. Rejects with
 *     CONNECT4_ERR_MC_ACTIVE when the character is summoned in Minecraft.
 *   CONNECT4GetState(characterId: string): Promise<CONNECT4GameState | null>
 *   CONNECT4Move(characterId: string, column: number): Promise<{ ok: boolean; error?: string; state: CONNECT4GameState }>
 *     Player drops a piece in `column`. ok:false = rejected (not your turn /
 *     column full); state is authoritative either way.
 *   CONNECT4Resign(characterId: string): Promise<CONNECT4GameState>
 *   CONNECT4Rematch(characterId: string): Promise<CONNECT4GameState>
 *   CONNECT4Retry(characterId: string): Promise<CONNECT4GameState>
 *     Run the character's failed turn again (only when aiTurnFailed is set).
 *   CONNECT4End(characterId: string): Promise<void>
 *     Close the game (panel dismissed). An unfinished game ends 'abandoned'.
 *   onCONNECT4State(cb: (state: CONNECT4GameState) => void): () => void
 */
