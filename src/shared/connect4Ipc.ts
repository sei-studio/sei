/**
 * Connect 4 minigame: shared renderer <-> main contract (260720).
 *
 * Cloned from src/shared/chessIpc.ts (game #2; see
 * .planning/quick/connect4-reuse-notes.md for the copy/diverge ledger).
 * The authoritative game lives in main (src/main/connect4/). The renderer is
 * a view: it sends player intents (drop, resign, rematch) and receives full
 * state snapshots over the connect4:state push. The AI's move is decided in
 * main by the character LLM picking from the engine candidate set; the
 * decision is never re-run. Presentation is paced in two halves: main holds
 * the move through a sampled think delay (prethink) before publishing
 * `pendingAiMove`, and the renderer then reveals it only after the table has
 * been quiet for a settle window, acking with connect4AckReveal to commit. A
 * player chat before the ack does NOT roll the move back: the reply turn
 * knows the queued move and may revise it (a replacement pendingAiMove
 * arrives) or hold it back via the wait() tool (pendingAiMove drops until a
 * later turn releases it).
 *
 * Divergences from chess, by design:
 *   - no draw offers (a full board is the only draw)
 *   - no 'preparing' status / download push (the engine is pure JS, no model)
 *   - moves are column drops (0-6), not UCI strings
 */

/** Disc colors. Red moves first (the white-analog seat). */
export type C4Color = 'r' | 'y';

export const C4_ROWS = 6;
export const C4_COLS = 7;

/**
 * Board cells: `board[row][col]`, row 0 is the BOTTOM row (gravity fills
 * upward). null = empty.
 */
export type C4Board = (C4Color | null)[][];

export interface C4MoveRecord {
  /** Column dropped into (0-6). */
  col: number;
  /** Row the disc landed in (0 = bottom). */
  row: number;
  color: C4Color;
}

export type C4EndReason =
  | 'connect'    // four in a row on the board
  | 'draw-full'  // board filled with no four
  | 'resign'     // player resigned
  | 'forfeit'    // the character forfeited
  | 'abandoned'; // game closed without a result

export interface C4Result {
  winner: C4Color | null; // null = draw/abandoned
  reason: C4EndReason;
  /** The four winning cells, for the board highlight (reason 'connect'). */
  line?: Array<{ row: number; col: number }>;
}

export type C4GameStatus = 'active' | 'ended';

export interface C4GameState {
  gameId: string;
  characterId: string;
  status: C4GameStatus;
  /** Board with all COMMITTED moves applied (pendingAiMove NOT applied). */
  board: C4Board;
  history: C4MoveRecord[];
  playerColor: C4Color;
  /** Side to move on `board`. */
  turn: C4Color;
  /**
   * True from the moment it becomes the AI's turn until its move is revealed
   * and acked (drives the "thinking" shimmer + locks the player's columns).
   */
  aiThinking: boolean;
  /**
   * The AI's decided drop, published after its think delay and waiting on the
   * renderer's quiet gate. Apply visually + ack via connect4AckReveal once
   * the table settles. It may be REPLACED (revised mid-conversation) or
   * DROPPED (wait(): held back) by a later push; both clear any local
   * reveal overlay.
   */
  pendingAiMove: { col: number } | null;
  result: C4Result | null;
  /** Strength label shown in the panel header (1-5, from the profile). */
  aiStrength: number;
}

/** Typed error code thrown by connect4Start (surfaces as a popup). */
export const C4_ERR_MC_ACTIVE = 'CONNECT4_MC_SESSION_ACTIVE';

/**
 * window.sei surface (implemented in src/preload/index.ts):
 *
 *   connect4Start(characterId: string, opts?: { playerColor?: 'r' | 'y' | 'random' }): Promise<C4GameState>
 *     Starts (or resumes) the character's game. Rejects with
 *     C4_ERR_MC_ACTIVE when the character is summoned in Minecraft.
 *   connect4GetState(characterId: string): Promise<C4GameState | null>
 *   connect4Move(characterId: string, col: number): Promise<{ ok: boolean; error?: string; state: C4GameState }>
 *     Player drop into a column (0-6). ok:false = rejected (not your turn /
 *     column full); state is authoritative either way.
 *   connect4Resign(characterId: string): Promise<C4GameState>
 *   connect4Rematch(characterId: string): Promise<C4GameState>
 *   connect4End(characterId: string): Promise<void>
 *     Close the game (panel dismissed). An unfinished game ends 'abandoned'.
 *   connect4AckReveal(characterId: string, col: number): Promise<C4GameState>
 *     The pending AI move passed the renderer's quiet gate; commit it. Stale
 *     acks (revised move, wait() hold, game over) are ignored.
 *   onConnect4State(cb: (state: C4GameState) => void): () => void
 */
