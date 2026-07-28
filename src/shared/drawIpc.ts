/**
 * Draw! minigame: shared renderer <-> main contract (260727).
 *
 * A turn-based sketch-guessing game. One game per character, N rounds (1-5,
 * chosen on the setup screen). Each ROUND is two TURNS: the player draws while
 * the character guesses, then the character draws while the player guesses.
 * Every turn is capped at TURN_MS (3 minutes) and ends early the moment the
 * guesser says the word.
 *
 * Authority split, mirroring chess (src/shared/chessIpc.ts):
 *
 *   main      owns the game: word selection, round/turn sequencing, the turn
 *             clock, guess matching, the character's guess scheduler and its
 *             drawing turn. Pushes full DrawGameState snapshots on draw:state.
 *   renderer  owns pixels: it captures the player's strokes, rasterizes
 *             snapshots on request, and animates the character's strokes as
 *             they stream in. It never decides anything.
 *
 * Two deliberate asymmetries in the pushed state:
 *
 *   - `word` is null for the guesser. While the character draws, the player's
 *     renderer is never told the answer; it is revealed only when the turn
 *     ends. (Local app, so this is not a security boundary, but it keeps the
 *     answer out of the view layer entirely so it cannot leak into the UI.)
 *   - `strokes` is NOT the source of truth while the character is drawing.
 *     Its strokes arrive one at a time on draw:ai-stroke with playback timing
 *     and are animated locally; the renderer shows its own revealed list until
 *     the turn ends, at which point `strokes` becomes authoritative again.
 *     Same shape as the chess reveal gate: no ack round trip.
 */

/** Turn length. Both the player's and the character's turns use it. */
export const TURN_MS = 180_000;

/** Logical canvas size. All stroke points are in this space, origin top-left. */
export const CANVAS_W = 1000;
export const CANVAS_H = 700;

/** Round-count bounds for the setup slider. */
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 5;

export type DrawRole = 'player' | 'ai';

export interface DrawPoint {
  x: number;
  y: number;
}

/**
 * One pen-down-to-pen-up stroke. Single thickness, always black, so there are
 * no style fields: the pen is the only tool that creates these and the stroke
 * eraser is the only tool that removes them (whole stroke, never partial).
 */
export interface DrawStroke {
  id: string;
  points: DrawPoint[];
}

export type DrawPhase =
  /** Setup screen: rounds slider + start. No turn is running. */
  | 'setup'
  /** A turn is live (see `drawer` for whose). */
  | 'drawing'
  /** Turn over, answer revealed, short pause before the next turn. */
  | 'turn-end'
  /** All rounds played: the gallery. */
  | 'gallery';

export interface DrawChatMessage {
  id: string;
  from: DrawRole;
  text: string;
  at: number;
  /** Set on the message that contained the correct guess. */
  correct?: boolean;
  /** Set on system lines ("Time's up. It was a lighthouse."). */
  system?: boolean;
}

/** A finished turn, kept for the end-of-game gallery. */
export interface DrawGalleryEntry {
  round: number;
  drawer: DrawRole;
  word: string;
  strokes: DrawStroke[];
  /** True when the guesser got it before the clock ran out. */
  guessed: boolean;
}

export interface DrawGameState {
  gameId: string;
  characterId: string;
  phase: DrawPhase;
  /** Rounds in this game (1-5). Each round is a player turn + a character turn. */
  rounds: number;
  /** Current round, 1-based. 0 during setup. */
  round: number;
  /** Who is drawing this turn; null outside a turn. */
  drawer: DrawRole | null;
  /**
   * Identifies the current turn. Bumped on every turn change, and carried on
   * DrawAiStroke, so the renderer can drop strokes that belonged to a turn
   * that has already ended (and reset its local playback when it changes).
   */
  turnKey: string;
  /**
   * The answer. Non-null ONLY when the local player is entitled to see it:
   * while they are drawing, and after any turn has ended.
   */
  word: string | null;
  /** Epoch ms when the live turn expires; null outside a turn. */
  turnEndsAt: number | null;
  /** Committed strokes for the current turn (see the ai-stroke note above). */
  strokes: DrawStroke[];
  /** Whole-game chat, oldest first. Guesses and table talk share the log. */
  chat: DrawChatMessage[];
  /** A point per correct guess, to the guesser. */
  scores: { player: number; ai: number };
  gallery: DrawGalleryEntry[];
  /** Display names for the chat column and the gallery headings. */
  playerName: string;
  aiName: string;
}

/**
 * One of the character's strokes, pushed as it is produced so the renderer can
 * animate it. `delayBeforeMs` is the pen-up pause to hold before starting and
 * `durationMs` is how long the stroke itself should take to draw; both are
 * sampled in main so the pacing reads as a hand rather than a plotter.
 */
export interface DrawAiStroke {
  characterId: string;
  gameId: string;
  /** Guards against a stroke from a previous turn landing late. */
  turnKey: string;
  stroke: DrawStroke;
  delayBeforeMs: number;
  durationMs: number;
}

/**
 * Main asking the renderer to rasterize the current canvas so the character
 * can look at it. The renderer answers with drawSnapshot(requestId, dataUrl).
 */
export interface DrawSnapshotRequest {
  characterId: string;
  requestId: string;
}

/** Typed error codes thrown by drawStart (surface as popups, not toasts). */
export const DRAW_ERR_MC_ACTIVE = 'DRAW_MC_SESSION_ACTIVE';

/**
 * window.sei surface (implemented in src/preload/index.ts):
 *
 *   drawStart(characterId: string, rounds: number): Promise<DrawGameState>
 *     Open the game at the setup screen, or start it with the chosen round
 *     count. Rejects with DRAW_ERR_MC_ACTIVE when the character is summoned.
 *   drawOpen(characterId: string): Promise<DrawGameState>
 *     Open the surface without starting (setup phase).
 *   drawGetState(characterId: string): Promise<DrawGameState | null>
 *   drawStroke(characterId: string, stroke: DrawStroke): Promise<void>
 *     The player lifted the pen. Ignored unless it is their turn to draw.
 *   drawErase(characterId: string, strokeId: string): Promise<void>
 *   drawChat(characterId: string, text: string): Promise<void>
 *     A chat line from the player. Checked against the answer when the
 *     character is drawing; otherwise it is table talk the character sees.
 *   drawSnapshot(requestId: string, dataUrl: string): Promise<void>
 *     Answer to a draw:snapshot-request.
 *   drawSaveGallery(characterId: string, pngDataUrl: string): Promise<string>
 *     Write the gallery PNG to the Desktop; resolves with the saved path.
 *   drawEnd(characterId: string): Promise<void>
 *     Close the game. An unfinished game is recorded as abandoned.
 *   onDrawState(cb: (s: DrawGameState) => void): () => void
 *   onDrawAiStroke(cb: (s: DrawAiStroke) => void): () => void
 *   onDrawSnapshotRequest(cb: (r: DrawSnapshotRequest) => void): () => void
 */
