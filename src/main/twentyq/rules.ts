/**
 * 20 Questions round bookkeeping — pure, typed, no LLM.
 *
 * The service (twentyqService.ts) maps LLM tool calls onto these functions;
 * everything that can corrupt a round (slot accounting, phase legality,
 * winners) lives here so it is unit-testable without a mocked model. All
 * mutators return { ok, error? } instead of throwing: an illegal call becomes
 * a tool_result retry note, mirroring connect4's illegal-column handling.
 *
 * Round phases, informally:
 *   - live, awaitingReply=false  — the ball is with the character (guesser
 *     mode: free to ask/guess; keeper mode: waiting on a player question)
 *   - live, awaitingReply=true   — a question/guess is out; the player has
 *     not replied yet (guesser mode only; keeper answers resolve in-turn)
 *   - over                        — result set; only a new round resets it
 */
import {
  TQ_MAX_QUESTIONS,
  type TQEndReason,
  type TQLogEntry,
  type TQMode,
  type TQRoundResult,
  type TQVerdict,
} from '../../shared/twentyqIpc';

export interface TQRoundState {
  mode: TQMode;
  /** 1-based round number. */
  round: number;
  questionsUsed: number;
  log: TQLogEntry[];
  /** Guesser mode: the last explicit guess, until the player's reply resolves it. */
  pendingGuess: string | null;
  /** Guesser mode: a question/guess is out and unanswered. */
  awaitingReply: boolean;
  /** Keeper mode only. Held main-side; never serialized to the renderer while live. */
  secret: string | null;
  over: boolean;
  result: TQRoundResult | null;
}

export interface TQApplyResult {
  ok: boolean;
  /** Model-facing correction, phrased for a tool_result note. */
  error?: string;
}

const OK: TQApplyResult = { ok: true };

export function createRound(mode: TQMode, round: number, secret: string | null = null): TQRoundState {
  return {
    mode,
    round,
    questionsUsed: 0,
    log: [],
    pendingGuess: null,
    awaitingReply: false,
    secret: mode === 'keeper' ? secret : null,
    over: false,
    result: null,
  };
}

export function slotsLeft(r: TQRoundState): number {
  return Math.max(0, TQ_MAX_QUESTIONS - r.questionsUsed);
}

export function outOfQuestions(r: TQRoundState): boolean {
  return r.questionsUsed >= TQ_MAX_QUESTIONS;
}

function liveGuard(r: TQRoundState, mode: TQMode): TQApplyResult | null {
  if (r.over) return { ok: false, error: 'The round is already over.' };
  if (r.mode !== mode) {
    return {
      ok: false,
      error:
        mode === 'guesser'
          ? 'You are not the guesser this round; you are the one hiding the answer.'
          : 'You are not hiding anything this round; you are the guesser.',
    };
  }
  return null;
}

/** The character asks a yes/no question (guesser mode). Costs one slot. */
export function applyAsk(r: TQRoundState, question: string): TQApplyResult {
  const guard = liveGuard(r, 'guesser');
  if (guard) return guard;
  if (slotsLeft(r) === 0) return { ok: false, error: 'You have no questions left.' };
  r.log.push({ kind: 'question', text: question });
  r.questionsUsed++;
  r.pendingGuess = null; // moving on supersedes an unresolved guess
  r.awaitingReply = true;
  return OK;
}

/** The character makes an explicit guess (guesser mode). Costs one slot. */
export function applyGuess(r: TQRoundState, answer: string): TQApplyResult {
  const guard = liveGuard(r, 'guesser');
  if (guard) return guard;
  if (slotsLeft(r) === 0) return { ok: false, error: 'You have no questions left.' };
  r.log.push({ kind: 'guess', text: answer });
  r.questionsUsed++;
  r.pendingGuess = answer;
  r.awaitingReply = true;
  return OK;
}

/** The player replied to whatever was out (dispatch calls this at chat time). */
export function noteReply(r: TQRoundState): void {
  r.awaitingReply = false;
}

/** The character answers a player question honestly (keeper mode). Costs one slot. */
export function applyAnswer(r: TQRoundState, reply: string, verdict: TQVerdict): TQApplyResult {
  const guard = liveGuard(r, 'keeper');
  if (guard) return guard;
  if (slotsLeft(r) === 0) return { ok: false, error: 'They have no questions left.' };
  r.log.push({ kind: 'answer', text: reply, verdict });
  r.questionsUsed++;
  return OK;
}

/**
 * End the round. Idempotent-guarded by the caller (returns ok:false when
 * already over so a double-end never flips a result).
 */
export function finishRound(
  r: TQRoundState,
  winner: 'player' | 'character' | null,
  reason: TQEndReason,
  secret: string | null,
): TQApplyResult {
  if (r.over) return { ok: false, error: 'The round is already over.' };
  r.over = true;
  r.awaitingReply = false;
  r.result = { winner, reason, secret, round: r.round };
  return OK;
}

/**
 * Guesser mode: claim the round after the player confirmed the pending guess.
 * The service passes the model's reveal() text; the recorded secret prefers
 * the confirmed pending guess (it is what the player said yes to).
 */
export function resolveGuesserReveal(r: TQRoundState, revealText: string): TQApplyResult {
  const guard = liveGuard(r, 'guesser');
  if (guard) return guard;
  if (r.pendingGuess === null) {
    return {
      ok: false,
      error: 'You have no confirmed guess to claim. Make a guess with guess() first and wait for their answer.',
    };
  }
  if (r.awaitingReply) {
    return { ok: false, error: 'They have not answered that guess yet. Wait for their reply.' };
  }
  return finishRound(r, 'character', 'guessed', (r.pendingGuess || revealText || '').trim() || null);
}

/**
 * Keeper mode: the round ends with the secret on the table. playerGotIt true
 * = the player just named it (their win); false = they gave up (yours). The
 * recorded secret is ALWAYS the stored one; the model cannot rewrite history.
 */
export function resolveKeeperReveal(r: TQRoundState, playerGotIt: boolean): TQApplyResult {
  const guard = liveGuard(r, 'keeper');
  if (guard) return guard;
  return playerGotIt
    ? finishRound(r, 'player', 'guessed', r.secret)
    : finishRound(r, 'character', 'gave-up', r.secret);
}

/** The character quits the round (both modes). The player takes it. */
export function applyForfeit(r: TQRoundState): TQApplyResult {
  if (r.over) return { ok: false, error: 'The round is already over.' };
  return finishRound(r, 'player', 'gave-up', r.secret);
}

/**
 * Keeper mode: the player's 20th question was just answered without a correct
 * guess — the character takes the round and the secret comes out.
 */
export function resolveKeeperExhaustion(r: TQRoundState): TQApplyResult {
  const guard = liveGuard(r, 'keeper');
  if (guard) return guard;
  if (!outOfQuestions(r)) return { ok: false, error: 'They still have questions left.' };
  return finishRound(r, 'character', 'out-of-questions', r.secret);
}

/**
 * Guesser mode: the character burned all 20 slots and the player's last reply
 * did not confirm a guess — the player takes the round. Only legal once the
 * outstanding question/guess has been replied to (awaitingReply false), so a
 * 20th question still gets its answer before the round closes.
 */
export function resolveGuesserExhaustion(r: TQRoundState): TQApplyResult {
  const guard = liveGuard(r, 'guesser');
  if (guard) return guard;
  if (!outOfQuestions(r)) return { ok: false, error: 'You still have questions left.' };
  if (r.awaitingReply) return { ok: false, error: 'The last question has not been answered yet.' };
  return finishRound(r, 'player', 'out-of-questions', null);
}
