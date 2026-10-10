// 261008: the "next time" hook a companion can attach to its goodbye
// (retention fix 2(c), ~/suisei/reports/retention-2026-10-05.md).
//
// Every goodbye tool (game quit_game / end_call, chat-surface quit_game /
// end_call) takes an optional `next_time` field: a few words naming something
// real to pick up next session ("finish the roof"). The model writes its own
// goodbye around it; nothing here touches what it says. This module only
// turns the FIELD into the MEMORY.md line the next greeting reads back, and
// tells the host whether one was given (analytics counts the field, never the
// spoken text).
//
// Import-free on purpose: the bot (raw ESM) and main (bundled TS) both use it.

/** A stored note, not speech: bounded so one runaway field cannot bloat MEMORY.md. */
export const NEXT_STEP_MAX_CHARS = 200

/**
 * The tool's `next_time` input as a clean single line, or null when the model
 * left it out (missing, not a string, or only whitespace).
 */
export function normalizeNextStep(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (s.length <= NEXT_STEP_MAX_CHARS) return s
  const cut = s.slice(0, NEXT_STEP_MAX_CHARS)
  const space = cut.lastIndexOf(' ')
  return (space > NEXT_STEP_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trim()
}

/**
 * The MEMORY.md entry for a saved hook. The prefix is what the greeting
 * prompts point at (promptLibrary NEXT_TIME_GREETING), so keep them in sync.
 */
export function nextStepMemoryLine(step) {
  return `Plan for next time: ${step}`
}
