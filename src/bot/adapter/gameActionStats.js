// Per-action outcome telemetry for the mod-driven games (Stardew Valley, Don't
// Starve Together), the same counters Minecraft keeps (brain/actionStats.js):
// attempts, successes, time, and a closed failure class per verb. Shape only:
// the result text is classified here and never leaves this frame.
//
// Each game says which results are failures, from what its mod reports:
// Stardew prefixes them with "failed:", the DST helper sends an ok flag.

import { sessionActionStats, classifyActionOutcome, classifyResultText } from '../brain/actionStats.js'

/**
 * Failure class of a result the game already called a failure. The shared
 * text map knows the common shapes (no path, missing items, timeouts); the
 * "nothing like that nearby" family is the mods' own wording.
 * @param {string} text
 * @returns {string} a FAIL_REASONS member
 */
export function failureClass(text) {
  const s = String(text ?? '').trim().toLowerCase()
  if (/^replaced by |^superseded\b/.test(s)) return 'aborted_by_preempt'
  if (/^you need \d+ .* and have \d+/.test(s)) return 'missing_materials'
  if (/ matching .* nearby|^nothing .* nearby|^no \S.* nearby|target is gone|^no .* at \(/.test(s)) return 'target_not_found'
  if (/needs a newer sei helper mod|^unknown (action|command)/.test(s)) return 'refused'
  return classifyResultText(s) ?? 'refused'
}

/**
 * Run one tool call and record it.
 * @param {string} name        the tool name (recorded only when `known`)
 * @param {boolean} known      the registry has this tool (a model-invented name is recorded as 'other')
 * @param {() => Promise<any>} run
 * @param {{ failed: (result: any) => (string|null|false), signal?: AbortSignal|null, stats?: any }} opts
 *   `failed(result)` returns the failure text, or null/false for a success.
 */
export async function withActionStats(name, known, run, { failed, signal = null, stats = sessionActionStats }) {
  const startedAt = Date.now()
  try { stats?.noteActionStarted() } catch {}
  let result, error
  try {
    result = await run()
    return result
  } catch (err) {
    error = err ?? new Error('unknown')
    throw err
  } finally {
    try {
      let reason = null
      if (error) reason = classifyActionOutcome({ error, aborted: signal?.aborted === true })
      else {
        const text = failed(result)
        if (text != null && text !== false) reason = signal?.aborted === true ? 'aborted_by_preempt' : failureClass(text)
      }
      stats?.recordAction(known ? name : 'other', Date.now() - startedAt, reason)
    } catch {}
  }
}
