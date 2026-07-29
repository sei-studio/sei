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

/**
 * Every game is this long (260728). The setup screen used to offer 1-5, which
 * was a choice nobody had the information to make before their first game and
 * did not want to make again after it. Three rounds is six turns, about twelve
 * minutes, which is where a session lands anyway.
 *
 * MIN/MAX are kept as the bounds main clamps an incoming request to, so an old
 * renderer or a replayed IPC call cannot ask for a hundred-round game.
 */
export const ROUNDS = 3;
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 5;

/** Words offered to the player before each of their drawing turns. */
export const WORD_CHOICES = 3;

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
  /** Setup screen: round count + start. No turn is running. */
  | 'setup'
  /**
   * The player is choosing which of `wordChoices` to draw. Only ever precedes
   * one of THEIR turns; the character's word is dealt to it directly. The turn
   * clock does not start until the choice is made.
   */
  | 'pick'
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
  /**
   * Raw-index range [start, end) of the winning word inside `text`, set
   * alongside `correct` so the renderer highlights the word itself rather than
   * the whole sentence. Absent when the word could not be located in the raw
   * text; the renderer falls back to highlighting the whole line.
   */
  correctRange?: { start: number; end: number };
  /** Set on system lines ("Time's up. It was a lighthouse."). */
  system?: boolean;
  /**
   * What the CHARACTER is shown in place of `text`, when the two must differ.
   * The renderer ignores this field entirely.
   *
   * It exists because the chat log is replayed verbatim into the character's
   * prompt, and a system line written for the player is wrong there twice over
   * (260728): "Round 1 of 3. Your turn to draw: horn." handed the guesser the
   * answer, and its second person reads as addressed to the model, which is
   * how the character ended up believing it had drawn the player's words. A
   * line carrying this field states the same fact in the third person, and
   * never names a word that is still secret.
   */
  modelText?: string;
  /**
   * Model-only line (260729): stripped from every state push, so the renderer
   * never sees it. Used for the character's own word slips — the player just
   * sees the line silently not arrive, while the character is told its line
   * was hidden so the thread stays coherent. A public "can't type this word!"
   * system line was tried first and read as the game scolding the character.
   */
  hidden?: boolean;
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
  /**
   * The words on offer during the 'pick' phase; empty otherwise. Only ever the
   * player's own choices, so this never reveals anything the character drew.
   */
  wordChoices: string[];
  /** Epoch ms when the live turn expires; null outside a turn. */
  turnEndsAt: number | null;
  /** Committed strokes for the current turn (see the ai-stroke note above). */
  strokes: DrawStroke[];
  /**
   * Bumped when the CHARACTER wipes its own page mid-turn with the `clear`
   * tool. The renderer's revealed list is local and survives a state push by
   * design (see the strokes note above), so this is the one signal that tells
   * it to throw that list away without ending the turn.
   */
  clearSeq: number;
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
 *   drawNewGame(characterId: string): Promise<DrawGameState>
 *     Back to the setup screen after a finished game, keeping the round count
 *     as the preselected value so "play again" can be replayed at a new length.
 *   drawPickWord(characterId: string, word: string): Promise<DrawGameState>
 *     Choose one of `wordChoices` during the 'pick' phase and begin the turn.
 *     Ignored unless that word is actually on offer.
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
