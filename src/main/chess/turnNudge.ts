/**
 * "It's your move" nudge gating (260929).
 *
 * 10 of 35 chess games ended before the first move, several after the player
 * sat at the board for 2 to 9 minutes. The player is White by default, so a
 * confused player at move one is waiting on themselves while the companion
 * waits politely. Now, when the player has been quiet at the start of their
 * turn for long enough, the companion says one line in character that it is
 * their move.
 *
 * At most ONE nudge per player turn: the flag resets only when the turn does
 * (the player moves and the companion answers). "Quiet" is measured from the
 * later of the turn starting and the last chat line either side sent, so a
 * player who is talking is not idle, and a companion that already spoke on an
 * idle tick does not immediately follow up with a nudge.
 *
 * Pure so the gating is testable without a session or timers.
 */

export interface NudgeTiming {
  /** Quiet before nudging on the player's FIRST move of the game. */
  nudgeFirstMoveMs: number;
  /** Quiet before nudging on any later move. */
  nudgeMoveMs: number;
}

export interface NudgeInput {
  now: number;
  /** When the current player turn began; null when it is not their turn. */
  playerTurnSince: number | null;
  /** Last chat line (either side), move, or commit. */
  lastActivityAt: number;
  /** A nudge already went out this turn. */
  nudged: boolean;
  /** The player has not made a move yet this game. */
  firstMove: boolean;
  /** The game is live, the engine is ready, and the companion may speak. */
  active: boolean;
  /**
   * Something else owns the table right now: the companion is deciding or
   * presenting a move, or a reply turn is queued. A nudge would talk over it.
   */
  busy: boolean;
}

/**
 * Milliseconds until a nudge is due: 0 = nudge now, a positive number = check
 * again after that long, null = no nudge this turn (not eligible, or already
 * nudged). The caller re-arms on a positive result rather than assuming the
 * nudge will still be wanted, since activity in between pushes it back.
 */
export function nudgeDueInMs(i: NudgeInput, t: NudgeTiming): number | null {
  if (!i.active || i.playerTurnSince === null || i.nudged) return null;
  const threshold = i.firstMove ? t.nudgeFirstMoveMs : t.nudgeMoveMs;
  const quietSince = Math.max(i.playerTurnSince, i.lastActivityAt);
  const remaining = quietSince + threshold - i.now;
  if (remaining > 0) return remaining;
  // Due, but the table is busy: look again shortly rather than dropping it.
  if (i.busy) return Math.min(5_000, threshold);
  return 0;
}
