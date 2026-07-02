/**
 * HEARTBEAT.md — the bot's active operating state, surfaced into EVERY loop's
 * seed user turn (the "heartbeat" that keeps a goal alive across loops).
 *
 * Distinct from MEMORY.md: MEMORY.md is subjective long-term impressions the
 * bot CHOSE to keep; HEARTBEAT.md is the here-and-now agenda — committed goals
 * and standing orders the bot is actively pursuing. Written by the LLM via the
 * `setGoal(text)` tool and cleared via `clearGoal(text)`. The composed seed
 * block prepends the proactiveness-level directive (see prompts.js
 * PROACTIVENESS_DIRECTIVES) to these goals so "how proactive am I" and "what am
 * I doing" arrive together every loop.
 *
 * Why a file (not just memory): a multi-step goal (gather 10 wood → build a
 * statue) must survive a loop ending after step 1. MEMORY.md's tool description
 * actively bans transactional/goal content, so goals had no home — they fell
 * through the crack between loop_end ("don't chain a new action") and idle
 * ("defer to proactiveness"). HEARTBEAT.md is that home.
 *
 * Format mirrors MEMORY.md (append-only, one line per entry) so the byte-budget
 * seed-read and file-lock machinery are identical.
 */

import { readFile } from 'node:fs/promises'
import { atomicWrite } from '../storage/atomicWrite.js'
import { withFileLock } from '../storage/fileLock.js'

const HEADER =
  '# Heartbeat\n' +
  '\n' +
  'Your active goals and standing orders — what you are pursuing right now,\n' +
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
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function createHeartbeatLog({ path: filePath } = {}) {
  if (!filePath) throw new Error('createHeartbeatLog: path required')
  return {
    path: filePath,
    append: (text, when) => appendGoal(filePath, text, when),
    remove: (query) => removeGoal(filePath, query),
    readAll: () => readHeartbeatFull(filePath),
  }
}

export async function appendGoal(filePath, text, when) {
  const safe = String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim()
  if (!safe) return 0
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
  const q = String(query ?? '').trim().toLowerCase()
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
 * regardless). The header is dropped from the seed view — the composed block
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
  // Walk newest → oldest until the budget is exhausted.
  for (let i = entries.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(entries[i] + '\n', 'utf8')
    if (lineBytes > remaining) { truncated = true; break }
    kept.unshift(entries[i])
    remaining -= lineBytes
  }
  if (kept.length === 0) return entries[entries.length - 1]
  return (truncated ? marker + '\n' : '') + kept.join('\n')
}
