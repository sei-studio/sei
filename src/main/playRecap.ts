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
 *   - An app quit ends it too (releaseRecapWaitsForQuit, 261123): the row is
 *     written with the digest lines and the quit drains the tracked writes,
 *     bounded, before it exits.
 * Every other way a session ends (the companion's goodbye, an app quit, a
 * failed session) writes the row right away with the digest lines.
 *
 * Analytics (shape only, never the recap or any line): `play_recap` once per
 * play row of a bot game: {character_id, game, saved, source: 'recap' |
 * 'lines' | 'none', recap_chars, recap_words, lines, check_outcome}, plus the
 * same call's durable facts (D2): facts_returned, facts_saved, fact_dupes, and
 * (261123) recap_memory_saved, the recap written to MEMORY.md too.
 */
import type { PlayerEndOutcome, SessionEndResult } from './playerEndNextStep';
import type { FactSave } from './chat/memoryFacts';

export const RECAP_WAIT_MS = 20_000;

export type RecapWaitOutcome = PlayerEndOutcome | 'waited_out' | 'scope_switch' | 'app_quit' | 'not_run';

/** Waits still open, each ended by releaseRecapWaitsForQuit. */
const openWaits = new Set<() => void>();
let quitting = false;

/**
 * 261123 (review): the app is quitting. Every open recap wait ends now
 * (outcome 'app_quit', no recap) so its play row is written before the quit
 * drains tracked writes, and a wait started after this ends at once.
 * Returns how many waits it ended.
 */
export function releaseRecapWaitsForQuit(): number {
  quitting = true;
  const waits = [...openWaits];
  for (const end of waits) end();
  return waits.length;
}

/** Tests only. */
export function _resetPlayRecapForTests(): void {
  quitting = false;
  openWaits.clear();
}

export interface RecapWait {
  recap: string | null;
  outcome: RecapWaitOutcome;
  /** 261113 (D2): the session end's remember: lines, when it returned any. */
  facts?: FactSave | null;
  /** 261123: the recap was also written to MEMORY.md. */
  recapSaved?: boolean;
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
  if (quitting) return Promise.resolve({ recap: null, outcome: 'app_quit' });
  return new Promise<RecapWait>((resolve) => {
    let done = false;
    const finish = (r: RecapWait) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      openWaits.delete(onQuit);
      resolve(r);
    };
    const onQuit = () => finish({ recap: null, outcome: 'app_quit' });
    openWaits.add(onQuit);
    const timer = setTimeout(() => finish({ recap: null, outcome: 'waited_out' }), opts.waitMs ?? RECAP_WAIT_MS);
    timer.unref?.();
    const off = opts.onSwitch(() => finish({ recap: null, outcome: 'scope_switch' }));
    ended.then(
      (r) => finish({ recap: r.recap, outcome: r.outcome, facts: r.facts ?? null, ...(r.recapSaved !== undefined ? { recapSaved: r.recapSaved } : {}) }),
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
  facts?: FactSave | null;
  recapSaved?: boolean;
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
    facts_returned: p.facts?.returned ?? 0,
    facts_saved: p.facts?.saved ?? 0,
    fact_dupes: p.facts?.dupes ?? 0,
    // 261123: the recap written to MEMORY.md as well (false: a duplicate, not tried, or no recap).
    recap_memory_saved: p.recapSaved === true,
  };
}
