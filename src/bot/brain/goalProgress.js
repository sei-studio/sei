/**
 * Goal progress: whether a goal set this session has had any work done
 * since it was set. Pure; no I/O.
 *
 * 261023 (quality pass 25). Her goodbyes and saved next_time steps said she
 * would "finish" goals she had never started: set on the greeting turn, then
 * an hour of talk, then "next time we finish the starter base" (pass 24 probe
 * bye_own, 6 of 8). The heartbeat she read at the goodbye listed the goal and
 * nothing about how far it got, and the next_time example said "finish the
 * roof". So a goal set this session that no world work has followed is now
 * marked as not started in the heartbeat, and the next_time text asks for
 * "start" or "try" on those. Work is any finished world action that
 * sessionEvents records as an event (quiet moves, looks and failures that
 * changed nothing are not), except fighting, eating, sleeping and using an
 * item: those happen on any goal and say nothing about this one.
 *
 * Goals from an earlier session are left unmarked: their progress then is
 * not known here.
 */

import { describeActionEvent } from './sessionEvents.js'
import { GOAL_NOT_STARTED_NOTE } from './promptLibrary.js'

export { GOAL_NOT_STARTED_NOTE }

const NOT_GOAL_WORK = new Set(['attackEntity', 'consumeItem', 'sleep', 'activateItem'])

/**
 * Whether a finished action counts as work toward the goals she holds.
 * @param {string} name   tool name
 * @param {unknown} result  the action's return value
 */
export function countsAsGoalWork(name, result) {
  if (!name || NOT_GOAL_WORK.has(name)) return false
  return describeActionEvent(name, result) !== null
}

/** The stamp of a heartbeat line ("- [ISO] text") in ms, or NaN. */
export function goalStampMs(line) {
  const m = /^- \[([^\]]*)\]/.exec(String(line ?? '').trim())
  return m ? Date.parse(m[1]) : NaN
}

/**
 * True when the goal line was set this session and no work has finished
 * since. Unknown cases (no session start, no readable stamp, a goal from an
 * earlier session) are false, so they stay unmarked.
 * @param {string} line  heartbeat line with its stamp
 * @param {{ sessionStartMs?: number|null, lastWorkAt?: number|null }} opts
 */
export function goalNotStarted(line, { sessionStartMs = null, lastWorkAt = null } = {}) {
  if (!Number.isFinite(sessionStartMs)) return false
  const at = goalStampMs(line)
  if (!Number.isFinite(at) || at < sessionStartMs) return false
  return !(Number.isFinite(lastWorkAt) && lastWorkAt >= at)
}

/**
 * The heartbeat text with GOAL_NOT_STARTED_NOTE after each line that
 * goalNotStarted marks. Other lines are returned as they are.
 * @param {string} goalsText
 * @param {{ sessionStartMs?: number|null, lastWorkAt?: number|null }} opts
 */
export function markGoalProgress(goalsText, opts = {}) {
  const text = String(goalsText ?? '')
  if (!Number.isFinite(opts.sessionStartMs)) return text
  return text.split('\n').map((l) => (/^- \[/.test(l.trim()) && goalNotStarted(l, opts) ? `${l.trimEnd()} ${GOAL_NOT_STARTED_NOTE}` : l)).join('\n')
}




