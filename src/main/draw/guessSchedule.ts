/**
 * When the character is allowed to look at the player's canvas and guess.
 *
 * Kept as a PURE function of state plus `now`, separate from the code that
 * actually dispatches, for two reasons: the policy is the part with all the
 * edge cases, and it is the part worth reading in one piece. drawService polls
 * this every POLL_MS while the player is drawing.
 *
 * The policy:
 *
 *   trigger    3 committed strokes since the last dispatch, OR 10s since the
 *              last dispatch. Whichever lands first.
 *   cooldown   never within 5s of the previous guess COMPLETING. Measured from
 *              completion, not dispatch, so a slow model call is not chased
 *              straight down by the next one.
 *   in flight  one at a time.
 *   empty      never guess at a canvas with nothing on it.
 *
 * "At most one queued guess" needs no queue. Strokes drawn while a call is in
 * flight simply leave `strokesSinceDispatch` above the trigger, and the single
 * dispatch that follows resets it to zero, collapsing any number of missed
 * triggers into exactly one look. There is nothing to overflow and nothing to
 * drain.
 *
 * Two things are deliberately NOT gates here:
 *
 *   - The canvas being unchanged. That cannot be known until the snapshot is
 *     in hand, so drawService hashes the returned PNG and drops the call
 *     there. Putting it here would mean rasterizing on every poll tick.
 *   - The turn clock. A turn ending tears the poll down and bumps the turn
 *     key, so expiry is handled by lifecycle rather than by a gate that would
 *     have to be re-checked after every await anyway.
 */

import type { DrawPhase, DrawRole } from '../../shared/drawIpc';

/** Committed strokes since the last dispatch that force a look. */
export const STROKE_TRIGGER = 3;
/** Wall clock since the last dispatch that forces a look. */
export const TIME_TRIGGER_MS = 10_000;
/** Quiet period after a guess COMPLETES before another may be dispatched. */
export const GUESS_COOLDOWN_MS = 5_000;

export interface GuessGateInput {
  phase: DrawPhase;
  drawer: DrawRole | null;
  /** A guess call is already running. */
  inFlight: boolean;
  /** Strokes currently on the canvas. */
  strokeCount: number;
  /** Strokes committed since the last dispatch. */
  strokesSinceDispatch: number;
  /** When the last dispatch started. Seeded to turn start. */
  lastDispatchAt: number;
  /** When the last guess finished. 0 when none has yet. */
  lastCompletedAt: number;
  now: number;
}

export type GuessGate =
  | { go: true; reason: 'strokes' | 'time' }
  | { go: false; reason: 'not-drawing' | 'in-flight' | 'cooldown' | 'empty-canvas' | 'no-trigger' };

export function guessGate(i: GuessGateInput): GuessGate {
  if (i.phase !== 'drawing' || i.drawer !== 'player') return { go: false, reason: 'not-drawing' };
  if (i.inFlight) return { go: false, reason: 'in-flight' };
  if (i.lastCompletedAt > 0 && i.now - i.lastCompletedAt < GUESS_COOLDOWN_MS) {
    return { go: false, reason: 'cooldown' };
  }
  if (i.strokeCount <= 0) return { go: false, reason: 'empty-canvas' };

  // Stroke trigger is checked first purely so the reason reads usefully in
  // logs when both are true; the two are equivalent for dispatch.
  if (i.strokesSinceDispatch >= STROKE_TRIGGER) return { go: true, reason: 'strokes' };
  if (i.now - i.lastDispatchAt >= TIME_TRIGGER_MS) return { go: true, reason: 'time' };
  return { go: false, reason: 'no-trigger' };
}
