/**
 * A game session's recap on its play row (261113, v0.7 consistency D1).
 *
 * When the player ends a game session (the 'check' route, nextStepReach.ts),
 * closePlaySession runs the session-end call with `recap: true`
 * (playerEndNextStep.ts startSessionEnd) and the play row waits for it, so the
 * row is written once, with the recap on it (playSummary.ts buildPlayRow).
 * The wait is bounded:
 *   - RECAP_WAIT_MS at most. The call has its own 15 s time box on a remote
 *     model, but a local model's floor is much longer, and the row must not
 *     hang that long. Past the wait the row goes out with the digest lines.
 *   - An account switch ends the wait at once (onScopeSwitchStart): the row
 *     is a tracked write, so the switch's drain waits for it, and it must land
 *     in the outgoing account before the scope moves.
 * Every other way a session ends (the companion's goodbye, an app quit, a
 * failed session) writes the row right away with the digest lines.
 *
 * Analytics (shape only, never the recap or any line): `play_recap` once per
 * play row of a bot game: {character_id, game, saved, source: 'recap' |
 * 'lines' | 'none', recap_chars, recap_words, lines, check_outcome}.
 */
import type { PlayerEndOutcome, SessionEndResult } from './playerEndNextStep';

export const RECAP_WAIT_MS = 20_000;

export type RecapWaitOutcome = PlayerEndOutcome | 'waited_out' | 'scope_switch' | 'not_run';

export interface RecapWait {
  recap: string | null;
  outcome: RecapWaitOutcome;
}

/**
 * Wait for the session end's recap, bounded by `waitMs` and by a scope switch.
 * Never rejects.
 */
export function awaitRecap(
  ended: Promise<SessionEndResult>,
  opts: {
    waitMs?: number;
    onSwitch: (fn: () => void) => () => void;
    switchPending: () => boolean;
  },
): Promise<RecapWait> {
  if (opts.switchPending()) return Promise.resolve({ recap: null, outcome: 'scope_switch' });
  return new Promise<RecapWait>((resolve) => {
    let done = false;
    const finish = (r: RecapWait) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ recap: null, outcome: 'waited_out' }), opts.waitMs ?? RECAP_WAIT_MS);
    timer.unref?.();
    const off = opts.onSwitch(() => finish({ recap: null, outcome: 'scope_switch' }));
    ended.then(
      (r) => finish({ recap: r.recap, outcome: r.outcome }),
      () => finish({ recap: null, outcome: 'error' }),
    );
  });
}

/** `play_recap` props for a written play row. Pure; no text, only its shape. */
export function playRecapProps(p: {
  characterId: string;
  game: string;
  event: { recap?: string; lines?: unknown[] };
  checkOutcome: RecapWaitOutcome;
}): Record<string, string | number | boolean> {
  const recap = typeof p.event.recap === 'string' ? p.event.recap : '';
  const lines = Array.isArray(p.event.lines) ? p.event.lines.length : 0;
  return {
    character_id: p.characterId,
    game: p.game,
    saved: recap.length > 0,
    source: recap ? 'recap' : lines ? 'lines' : 'none',
    recap_chars: recap.length,
    recap_words: recap ? recap.split(/\s+/).filter(Boolean).length : 0,
    lines,
    check_outcome: p.checkOutcome,
  };
}
