/**
 * HEARTBEAT.md â€” the bot's active operating state, surfaced into EVERY loop's
 * seed user turn (the "heartbeat" that keeps a goal alive across loops).
 *
 * Distinct from MEMORY.md: MEMORY.md is subjective long-term impressions the
 * bot CHOSE to keep; HEARTBEAT.md is the here-and-now agenda â€” committed goals
 * and standing orders the bot is actively pursuing. Written by the LLM via the
 * `setGoal(text)` tool and cleared via `clearGoal(text)`. The composed seed
 * block prepends the proactiveness-level directive (see prompts.js
 * PROACTIVENESS_DIRECTIVES) to these goals so "how proactive am I" and "what am
 * I doing" arrive together every loop.
 *
 * Why a file (not just memory): a multi-step goal (gather 10 wood â†’ build a
 * statue) must survive a loop ending after step 1. MEMORY.md's tool description
 * actively bans transactional/goal content, so goals had no home â€” they fell
 * through the crack between loop_end ("don't chain a new action") and idle
 * ("defer to proactiveness"). HEARTBEAT.md is that home.
 *
 * Format mirrors MEMORY.md (append-only, one line per entry) so the byte-budget
 * seed-read and file-lock machinery are identical.
 */

import { readFile } from 'node:fs/promises'
import { atomicWrite } from '../storage/atomicWrite.js'
import { withFileLock } from '../storage/fileLock.js'
import { PLAYER_TASK_TAG } from '../promptLibrary.js'

const HEADER =
  '# Heartbeat\n' +
  '\n' +
  'Your active goals and standing orders â€” what you are pursuing right now,\n' +
  'across loops. Add with setGoal(); remove with clearGoal() once a goal is\n' +
  'done or abandoned. One line per goal.\n' +
  '\n'

function entryLine(timestamp, text) {
  const safe = String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim()
  return `- [${timestamp}] ${safe}\n`
}

// Normalize a goal's text for near-duplicate detection: lowercase, strip
// punctuation, collapse whitespace. Used so setGoal doesn't append a goal the
// heartbeat already holds (the tool description forbids duplicates; this
// enforces it so a re-stated goal can't pile up across loops).
function normalizeForDedup(text) {
  return stripPlayerTaskTag(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// 261013 (pass 6b): a task the player gave the bot is stored with
// PLAYER_TASK_TAG in front of its text, so the seed can list it apart from (and
// ahead of) the bot's own goals, and so JS never auto-clears it from the
// progression spine (only the model can tell when it was handed over).
export function isPlayerTask(text) {
  return String(text ?? '').trimStart().startsWith(PLAYER_TASK_TAG)
}

// 261017 (pass 14b): whether the heartbeat file still holds a player task.
export function hasPlayerTask(fullText) {
  for (const line of String(fullText ?? '').split('\n')) {
    const m = /^- \[[^\]]*\]\s*(.*)$/.exec(line)
    if (m && isPlayerTask(m[1])) return true
  }
  return false
}

// 261020 (pass 20): the goal texts in the heartbeat file, oldest first, with
// the player-task tag kept and the stamps dropped.
export function goalEntries(fullText) {
  const out = []
  for (const line of String(fullText ?? '').split('\n')) {
    const m = /^- \[[^\]]*\]\s*(.*)$/.exec(line)
    if (m && m[1].trim()) out.push(m[1].trim())
  }
  return out
}

// 261022 (pass 22): the player tasks in the heartbeat file, oldest first:
// { at } is the stamp in ms (NaN when unreadable), { text } the goal text
// without the tag, { key } the text as appendGoal dedups it.
export function playerTaskEntries(fullText) {
  const out = []
  for (const line of String(fullText ?? '').split('\n')) {
    const m = /^- \[([^\]]*)\]\s*(.*)$/.exec(line)
    if (!m || !isPlayerTask(m[2])) continue
    const text = stripPlayerTaskTag(m[2])
    if (text) out.push({ at: Date.parse(m[1]), text, key: goalKey(text) })
  }
  return out
}

// A goal's text as appendGoal compares it (tag, case and punctuation dropped).
export function goalKey(text) {
  return normalizeForDedup(text)
}

// 261022 (pass 22c): which of the player's tasks an action works, from the
// item and block names in its args against the task's words ("oak_log" and
// "Get 8 logs for Alex's dock" share "log"). A player name never links: a
// walk to the player belongs to no one task. Empty when nothing is shared.
const LINK_SKIP = new Set(['the', 'and', 'for', 'with', 'any', 'block', 'blocks', 'item', 'items', 'nearest'])
const stemWord = (w) => {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && /(ch|sh|s|x)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}
const linkWords = (text) => String(text ?? '').toLowerCase().split(/[^a-z]+/)
  .filter((w) => w.length >= 3 && !LINK_SKIP.has(w)).map(stemWord)
export function tasksOfAction(args, tasks, { names = [] } = {}) {
  const skip = new Set((names ?? []).flatMap((n) => linkWords(n)))
  const words = new Set()
  const walk = (v, depth) => {
    if (depth > 2 || v == null) return
    if (typeof v === 'string') { for (const w of linkWords(v)) if (!skip.has(w)) words.add(w) } else if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1) } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) if (k !== 'player' && k !== 'username') walk(x, depth + 1)
    }
  }
  walk(args, 0)
  if (!words.size) return []
  return (tasks ?? []).filter((t) => linkWords(t?.text).some((w) => !skip.has(w) && words.has(w)))
}

function stripPlayerTaskTag(text) {
  const t = String(text ?? '').trim()
  return t.startsWith(PLAYER_TASK_TAG) ? t.slice(PLAYER_TASK_TAG.length).trim() : t
}

export function createHeartbeatLog({ path: filePath } = {}) {
  if (!filePath) throw new Error('createHeartbeatLog: path required')
  return {
    path: filePath,
    append: (text, when, opts) => appendGoal(filePath, text, when, opts),
    remove: (query) => removeGoal(filePath, query),
    readAll: () => readHeartbeatFull(filePath),
  }
}

export async function appendGoal(filePath, text, when, { forPlayer = false } = {}) {
  const folded = String(text ?? '').replace(/\s*\n+\s*/g, ' ')
  const body = stripPlayerTaskTag(folded)
  if (!body) return 0
  // The model may also copy the tag into the text itself from the seed view.
  const safe = (forPlayer || isPlayerTask(folded)) ? `${PLAYER_TASK_TAG} ${body}` : body
  let whenDate
  if (when instanceof Date) whenDate = when
  else if (typeof when === 'string') whenDate = new Date(when)
  else whenDate = new Date()
  const line = entryLine(whenDate.toISOString(), safe)

  return withFileLock(filePath, async () => {
    let existing = ''
    try {
      existing = await readFile(filePath, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') existing = HEADER
      else throw err
    }
    if (!existing.startsWith('# Heartbeat')) existing = HEADER + existing
    // Dedup: skip the append if an existing goal normalizes to the same text.
    // Returns 0 (treated as "already set" by the caller) so a re-stated goal
    // doesn't pile up loop after loop.
    const wantKey = normalizeForDedup(safe)
    if (wantKey) {
      for (const existingLine of existing.split('\n')) {
        const m = /^- \[[^\]]*\]\s*(.*)$/.exec(existingLine)
        if (m && normalizeForDedup(m[1]) === wantKey) return 0
      }
    }
    await atomicWrite(filePath, existing + line)
    return 1
  })
}

/**
 * Remove all goals whose text contains `query` (case-insensitive substring).
 * Returns the number of removed lines.
 */
export async function removeGoal(filePath, query) {
  // 261020 (pass 20 review): NUDGES.heartbeatNow shows a long goal cut at 157
  // characters with "..." on the end. A clearGoal that copies that line whole
  // must still match, so a trailing ellipsis is not part of the substring.
  const q = String(query ?? '').trim().replace(/\s*(\.\.\.|â€¦)$/, '').trim().toLowerCase()
  if (!q) return 0

  return withFileLock(filePath, async () => {
    let raw
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return 0
      throw err
    }
    const lines = raw.split('\n')
    let removed = 0
    const kept = []
    for (const line of lines) {
      if (/^- \[/.test(line) && line.toLowerCase().includes(q)) {
        removed += 1
        continue
      }
      kept.push(line)
    }
    if (removed === 0) return 0
    await atomicWrite(filePath, kept.join('\n'))
    return removed
  })
}

export async function readHeartbeatFull(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return ''
    throw err
  }
}

/**
 * Read the goals body, capped at `budgetBytes` by dropping oldest goals from
 * the display (file on disk untouched). Returns '' when there are no goals so
 * the caller can omit the block entirely (the proactiveness directive is shown
 * regardless). The header is dropped from the seed view â€” the composed block
 * supplies its own framing.
 */
export async function readHeartbeatForSeed(filePath, budgetBytes) {
  const full = await readHeartbeatFull(filePath)
  const lines = full.split('\n')
  const entries = lines.filter(l => /^- \[/.test(l))
  if (entries.length === 0) return ''

  const marker = '- [...older goals truncated]'
  const markerBytes = Buffer.byteLength(marker + '\n', 'utf8')
  let remaining = budgetBytes - markerBytes
  const kept = []
  let truncated = false
  // Walk newest â†’ oldest until the budget is exhausted.
  for (let i = entries.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(entries[i] + '\n', 'utf8')
    if (lineBytes > remaining) { truncated = true; break }
    kept.unshift(entries[i])
    remaining -= lineBytes
  }
  if (kept.length === 0) return entries[entries.length - 1]
  return (truncated ? marker + '\n' : '') + kept.join('\n')
}




