// src/bot/brain/sessionDigest.js — the session's recent conversation, kept for
// main's player-end "next time" check (261011, retention O2).
//
// When the PLAYER ends a session (Stop, closing the world), the bot process is
// gone a moment later, and with it convoMemory. Main runs one small LLM call
// after teardown to decide whether there is a plan for next time
// (src/main/playerEndNextStep.ts), and it needs a compact view of what was
// said. This module keeps that view: the last MAX_LINES lines of the
// conversation (both sides, truncated), plus how many lines each side spoke.
// 261113 (v0.7 D1): the same call now also writes the session's recap into
// the app's shared story, so the window grew from 16 lines to 40: 16 held
// little more than the goodbye at the end of a session.
// The bot posts it up the port as {type:'session-digest'} next to the
// action-stats snapshot (on a timer while it changes, and right before any
// terminal lifecycle).
//
// It holds conversation TEXT, so it never goes to analytics. It only crosses
// the local MessagePort to main, which keeps it in memory for one session.
//
// Process-level singleton (`sessionDigest`): the runtime may rebuild the brain
// (and its convoMemory) per connection, but the session is the process.

export const DIGEST_MAX_LINES = 40
export const DIGEST_LINE_CHARS = 200

export function createSessionDigest() {
  let lines = []
  let playerLines = 0
  let selfLines = 0
  let dirty = false

  /**
   * @param {'player'|'you'|'other'} who  the human player, this companion, or
   *   a sibling companion.
   * @param {string} text
   */
  function record(who, text) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (!t) return
    const kind = who === 'you' || who === 'other' ? who : 'player'
    lines.push({ who: kind, text: t.slice(0, DIGEST_LINE_CHARS) })
    while (lines.length > DIGEST_MAX_LINES) lines.shift()
    if (kind === 'player') playerLines += 1
    else if (kind === 'you') selfLines += 1
    dirty = true
  }

  function snapshot() {
    dirty = false
    return { lines: lines.map(l => ({ ...l })), playerLines, selfLines }
  }

  return {
    record,
    snapshot,
    isDirty: () => dirty,
    /** Tests only. */
    _reset() { lines = []; playerLines = 0; selfLines = 0; dirty = false },
  }
}

export const sessionDigest = createSessionDigest()
