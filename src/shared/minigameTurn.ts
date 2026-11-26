/**
 * Shared shape for a board minigame turn the character could not finish
 * (Four in a Row, Fleet Battle). 261127.
 *
 * The character's moves are always its own LLM call: the engine only enforces
 * the rules and never picks a move for it. When every attempt at a turn fails
 * (timeouts, provider errors, illegal moves it could not correct), the game
 * stops in this state and the panel shows "<name> couldn't move" with a
 * Try again control that runs the character's turn again.
 */
export type MinigameTurnFailReason =
  /** Every attempt ran out of time. */
  | 'timeout'
  /** The model kept choosing moves the rules do not allow. */
  | 'illegal_move'
  /** The model answered without ever choosing a move. */
  | 'no_move'
  /** The provider failed (server error, network, bad request). */
  | 'provider_error'
  /** Sign-in or API key problem: retrying alone cannot fix it. */
  | 'auth'
  /** Cloud allowance used up (the credit popup was raised). */
  | 'credit_wall'
  /** Cloud rate limit (the popup was raised). */
  | 'rate_limited';

export interface MinigameTurnFailure {
  reason: MinigameTurnFailReason;
  /** Attempts made before giving up. */
  attempts: number;
}
