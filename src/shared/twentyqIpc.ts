/**
 * 20 Questions minigame: shared renderer <-> main contract (260720).
 *
 * Game #3, cloned from src/shared/connect4Ipc.ts and simplified per the
 * TurnGameAdapter boundaries in .planning/quick/connect4-reuse-notes.md
 * (follow-up ledger: .planning/quick/twentyq-reuse-notes.md). This is the
 * party-tier template: pure conversation, no board, no engine, no
 * presentation hold, no pendingAiMove/ackReveal reveal protocol. The whole
 * game loop is chat: each player message rides the session FSM at P1 and
 * triggers the character's next turn; a P3 idle tick nudges when the table
 * goes quiet.
 *
 * The authoritative game lives in main (src/main/twentyq/). The renderer is
 * a view: it sends session intents (start, new round, close) and receives
 * full TQGameState snapshots over the twentyq:state push. Questions, guesses,
 * and answers all happen in the normal chat transcript; the panel is only a
 * status card (mode, 20-pip question tracker, guesses, score, result banner).
 *
 * Secrecy invariant (keeper mode): the character's secret is held main-side
 * in the session and NEVER appears in a snapshot until the round is over
 * (result.secret is the only place it ships).
 */

/** Who holds the secret. The character is the guesser or the keeper. */
export type TQMode = 'guesser' | 'keeper';

export const TQ_MAX_QUESTIONS = 20;

/** Honest keeper-mode verdicts for a player's yes/no question. */
export type TQVerdict = 'yes' | 'no' | 'sortof';

/**
 * One consumed question slot, in order. Drives the 20-pip tracker:
 *   'question' — the character asked (guesser mode)
 *   'guess'    — the character made an explicit guess (guesser mode; marked)
 *   'answer'   — the character answered a player question (keeper mode)
 */
export interface TQLogEntry {
  kind: 'question' | 'guess' | 'answer';
  text: string;
  /** 'answer' entries only: the honest verdict given. */
  verdict?: TQVerdict;
}

export type TQEndReason =
  | 'guessed'          // the guessing side named the secret
  | 'out-of-questions' // 20 slots burned without a confirmed guess
  | 'gave-up'          // the character forfeited the round
  | 'abandoned';       // panel closed mid-round

export interface TQRoundResult {
  /** Who took the round. null = abandoned. */
  winner: 'player' | 'character' | null;
  reason: TQEndReason;
  /** The secret, revealed at round end only (null when nobody ever said it). */
  secret: string | null;
  /** 1-based round number this result belongs to. */
  round: number;
}

export type TQGameStatus = 'active' | 'ended';

export interface TQGameState {
  gameId: string;
  characterId: string;
  /** Session status (the panel's lifetime, spanning rounds). */
  status: TQGameStatus;
  mode: TQMode;
  /** 1-based current round. */
  round: number;
  /** Question slots consumed this round (0..20). Asks, guesses, and answers all cost one. */
  questionsUsed: number;
  /** Consumed slots in order, for the pip tracker and the guess list. */
  log: TQLogEntry[];
  /** True between a round's end and the next new-round (result banner up). */
  roundOver: boolean;
  /** Most recent finished round's result (kept until the next round starts). */
  result: TQRoundResult | null;
  /** Match score: rounds won by each side. */
  score: { player: number; character: number };
  /** A character turn (or keeper-mode secret pick) is running. */
  aiBusy: boolean;
}

/** Typed error code thrown by twentyqStart (surfaces as a popup). */
export const TQ_ERR_MC_ACTIVE = 'TWENTYQ_MC_SESSION_ACTIVE';

/**
 * window.sei surface (implemented in src/preload/index.ts):
 *
 *   twentyqStart(characterId: string, opts?: { mode?: TQMode }): Promise<TQGameState>
 *     Starts (or resumes) the character's session. Default mode 'guesser'
 *     (the player thinks of something). Rejects with TQ_ERR_MC_ACTIVE when
 *     the character is summoned in Minecraft.
 *   twentyqGetState(characterId: string): Promise<TQGameState | null>
 *   twentyqNewRound(characterId: string): Promise<TQGameState>
 *     Start the next round after one ends (same mode, score carries over).
 *   twentyqEnd(characterId: string): Promise<void>
 *     Close the session (panel dismissed). A live round ends 'abandoned'.
 *   onTwentyQState(cb: (state: TQGameState) => void): () => void
 */
