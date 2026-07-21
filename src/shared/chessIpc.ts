/**
 * Chess minigame: shared renderer <-> main contract (260710).
 *
 * The authoritative game lives in main (src/main/chess/). The renderer is a
 * view: it sends player intents (move, resign, draw, rematch) and receives
 * full state snapshots over the chess:state push. The AI's move is decided in
 * main by the character LLM picking from the CCE candidate set; the decision
 * is never re-run. Presentation is paced in two halves: main holds the move
 * through a sampled think delay (prethink) before publishing `pendingAiMove`,
 * and the renderer then reveals it only after the table has been quiet for a
 * settle window (commentary finished printing/speaking and no player message
 * jumped in), acking with chessAckReveal to commit. A player chat before the
 * ack does NOT roll the move back: the reply turn knows the queued move and
 * may revise it (a replacement pendingAiMove arrives) or hold it back via the
 * wait() tool (pendingAiMove drops until a later turn releases it).
 */

export type ChessColor = 'w' | 'b';

export interface ChessMoveRecord {
  san: string;
  uci: string;
  /** FEN AFTER this move was played (drives move-list scrubbing). */
  fen: string;
}

export type ChessEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'draw-agreed'
  | 'draw-material'
  | 'draw-repetition'
  | 'draw-fifty'
  | 'resign'      // player resigned
  | 'forfeit'     // the character forfeited
  | 'abandoned';  // game closed without a result

export interface ChessResult {
  winner: ChessColor | null; // null = draw/abandoned
  reason: ChessEndReason;
}

export type ChessGameStatus =
  | 'preparing'   // engine warm-up: first-run model download in progress
  | 'active'
  | 'ended';

export interface ChessGameState {
  gameId: string;
  characterId: string;
  status: ChessGameStatus;
  /** Position with all COMMITTED moves applied (pendingAiMove NOT applied). */
  fen: string;
  history: ChessMoveRecord[];
  playerColor: ChessColor;
  /** Side to move in `fen`. */
  turn: ChessColor;
  /**
   * True from the moment it becomes the AI's turn until its move is revealed
   * and acked (drives the "thinking" shimmer + locks the player's board).
   */
  aiThinking: boolean;
  /**
   * The AI's decided move, published after its think delay and waiting on the
   * renderer's quiet gate. Apply visually + ack via chessAckReveal once the
   * table settles. It may be REPLACED (the character revised its decision
   * mid-conversation) or DROPPED (wait(): the character is holding the move
   * back) by a later push; both clear any local reveal overlay.
   */
  pendingAiMove: { uci: string; san: string } | null;
  /** A draw offer awaiting an answer ('player' = player offered). */
  drawOffer: 'player' | 'ai' | null;
  result: ChessResult | null;
  /** Elo label shown in the panel header (from the character's chess profile). */
  aiElo: number;
}

export interface ChessDownloadProgress {
  characterId: string;
  /** 0-100; -1 = failed (message in `error`). */
  pct: number;
  error?: string;
}

/** Typed error codes thrown by chessStart (surface as popups, not toasts). */
export const CHESS_ERR_MC_ACTIVE = 'CHESS_MC_SESSION_ACTIVE';
export const CHESS_ERR_DOWNLOAD_FAILED = 'CHESS_MODEL_DOWNLOAD_FAILED';

/**
 * window.sei surface (implemented in src/preload/index.ts):
 *
 *   chessStart(characterId: string, opts?: { playerColor?: 'w' | 'b' | 'random' }): Promise<ChessGameState>
 *     Starts (or resumes) the character's game. Rejects with
 *     CHESS_ERR_MC_ACTIVE when the character is summoned in Minecraft.
 *   chessGetState(characterId: string): Promise<ChessGameState | null>
 *   chessMove(characterId: string, uci: string): Promise<{ ok: boolean; error?: string; state: ChessGameState }>
 *     Player move in UCI (e7e8q for promotions). ok:false = rejected
 *     (not your turn / illegal); state is authoritative either way.
 *   chessResign(characterId: string): Promise<ChessGameState>
 *   chessOfferDraw(characterId: string): Promise<ChessGameState>
 *   chessRespondDraw(characterId: string, accept: boolean): Promise<ChessGameState>
 *   chessRematch(characterId: string): Promise<ChessGameState>
 *   chessEnd(characterId: string): Promise<void>
 *     Close the game (panel dismissed). An unfinished game ends 'abandoned'.
 *   chessAckReveal(characterId: string, uci: string): Promise<ChessGameState>
 *     The pending AI move passed the renderer's quiet gate; commit it. Stale
 *     acks (revised move, wait() hold, game over) are ignored.
 *   onChessState(cb: (state: ChessGameState) => void): () => void
 *   onChessDownload(cb: (p: ChessDownloadProgress) => void): () => void
 */
