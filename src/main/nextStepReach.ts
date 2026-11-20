/**
 * Which session ends get the "next time" check (261107, O2 reach). Pure, so
 * the routing is pinned in nextStepReach.test.ts; index.ts applies it.
 *
 * The check itself is playerEndNextStep.ts (one small background call after a
 * session the player ended) and its app-quit deferral is quitNextStep.ts. Two
 * common ends were missing it:
 *   - Stardew and Don't Starve Together: closing the game is how a session
 *     normally ends, and it arrived as an error (GAME_WORLD_NOT_OPEN, reason
 *     `error`) instead of `world_closed` like Minecraft. The adapters now send
 *     `world_closed`, so gameEndRoute runs the check for it.
 *   - A call ended by closing the app window. Main closes it itself
 *     (sweepVoiceCalls), so the renderer's hang-up report, the path that runs
 *     the check, never came. On Windows and Linux the quit follows at once,
 *     and the window's 'closed' fires BEFORE before-quit, so
 *     persistCallsForQuit then found no live call either and the deferred
 *     check never ran. mainClosedCallRoute keeps it for the next launch there
 *     and runs it now on macOS, where the app stays up.
 * Every other end reports why it ran no check (reportNextStepNotRun), so
 * `next_step_checked` covers every session end.
 */
import { isPlayerEndedGame, type NextStepNotRun } from './playerEndNextStep';

export type GameEndRoute =
  /** startPlayerEndNextStep now. */
  | { kind: 'check' }
  /** persistQuitSession, then report deferred (or trivial when it wrote nothing). */
  | { kind: 'persist' }
  | { kind: 'report'; outcome: Extract<NextStepNotRun, 'goodbye' | 'not_covered'> };

/** What a closed live game session does about the check. */
export function gameEndRoute(p: { reason: string; companionGoodbye: boolean }): GameEndRoute {
  // A Stop or a closed world runs the check even after a goodbye line (the
  // existing rule; the dedupe and the plan ledger keep one plan).
  if (isPlayerEndedGame(p.reason)) return { kind: 'check' };
  if (p.companionGoodbye) return { kind: 'report', outcome: 'goodbye' };
  if (p.reason === 'app_quit') return { kind: 'persist' };
  return { kind: 'report', outcome: 'not_covered' };
}

export type MainClosedCallRoute =
  /** startCallNextStep now. */
  | { kind: 'check' }
  /** persistQuitSession (surface call), then report deferred / trivial. */
  | { kind: 'persist' }
  /** persistCallsForQuit already kept and reported it. */
  | { kind: 'none' }
  | { kind: 'report'; outcome: Extract<NextStepNotRun, 'goodbye' | 'in_game' | 'not_covered'> };

/**
 * What a call main closed itself (accountSwitchCalls onClosed) does about the
 * check. `reason` is the voice_call_ended reason main stamped.
 */
export function mainClosedCallRoute(p: {
  reason: string;
  platform: NodeJS.Platform;
  companionEnded: boolean;
  inGame: boolean;
}): MainClosedCallRoute {
  if (p.companionEnded) return { kind: 'report', outcome: 'goodbye' };
  if (p.reason === 'app_quit') return { kind: 'none' };
  if (p.inGame) return { kind: 'report', outcome: 'in_game' };
  if (p.reason === 'window_closed') return p.platform === 'darwin' ? { kind: 'check' } : { kind: 'persist' };
  // account_switch, renderer_gone, renderer_reload: not the player leaving.
  return { kind: 'report', outcome: 'not_covered' };
}
