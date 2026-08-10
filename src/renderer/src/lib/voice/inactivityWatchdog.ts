/**
 * Inactivity watchdog for voice calls (260810) — pure decision logic.
 *
 * Why this exists: a call left running unattended used to idle-nudge (and
 * bill LLM turns) forever. Worse, before the echo gate (260807) a video
 * playing into the mic manufactured phantom "player" turns every few seconds
 * for close to an hour. The echo gate means an unattended call now reads as
 * SILENT — this watchdog is the layer that then ends it gracefully.
 *
 * ACTIVITY is the player actually doing something: a confirmed, dispatched
 * utterance (post junk-filter, post echo-gate), or typing a chat message to
 * an on-call companion. Companion speech deliberately does NOT count — a
 * companion idle-nudging itself alive is exactly the failure mode. An active
 * screenshare (backseat) counts as continuous presence: while `sharing` the
 * watchdog never fires, and the caller resets the clock so ending the share
 * restarts the full window.
 *
 * Everything is wall-clock timestamps compared at evaluation time, never
 * accumulated intervals, so a sleep/wake gap collapses into one late
 * evaluation instead of a drifted timer. Note the decision ladder: a machine
 * that slept past BOTH thresholds still lands on 'prompt' first (promptAt is
 * null until the popup is actually shown), so the call can never end without
 * the player having been asked.
 *
 * The store (useVoiceStore) owns the timers and the mutable timestamps; this
 * module owns only the decision, so it can be unit-tested with plain numbers.
 */

/** Quiet time on a live call before the "Are you still there?" popup. */
export const INACTIVITY_PROMPT_AFTER_MS = 10 * 60_000;
/** Countdown shown on the popup before the call ends. */
export const INACTIVITY_COUNTDOWN_MS = 10_000;

export type InactivityDecision = 'ok' | 'prompt' | 'end';

export interface InactivityArgs {
  /** Wall-clock ms of the last real player activity. */
  lastActivityAt: number;
  /** Wall-clock ms the popup was shown, or null while it is not up. */
  promptAt: number | null;
  /** Wall-clock now. */
  now: number;
  /** A backseat screenshare is live — the watchdog never fires during one. */
  sharing: boolean;
}

/**
 * One evaluation of the watchdog. 'ok' = nothing to do (and any showing
 * prompt should be dismissed), 'prompt' = the popup should be up,
 * 'end' = the countdown expired, hang up through the normal path.
 */
export function decideInactivity(args: InactivityArgs): InactivityDecision {
  const { lastActivityAt, promptAt, now, sharing } = args;
  if (sharing) return 'ok';
  if (promptAt !== null) {
    return now - promptAt >= INACTIVITY_COUNTDOWN_MS ? 'end' : 'prompt';
  }
  return now - lastActivityAt >= INACTIVITY_PROMPT_AFTER_MS ? 'prompt' : 'ok';
}

/** Whole seconds left on the countdown (10 → 0), for the popup body. */
export function countdownSecondsLeft(promptAt: number, now: number): number {
  return Math.max(0, Math.ceil((promptAt + INACTIVITY_COUNTDOWN_MS - now) / 1000));
}
