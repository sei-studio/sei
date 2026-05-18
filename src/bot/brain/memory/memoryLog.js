/**
 * MEMORY.md — append-only long-term memory written by the LLM via the
 * `remember(text)` tool and pruned via `forget(text)`. Loaded in full
 * (subject to a byte budget for display) into every loop's seed user turn.
 *
 * Format:
 *   # Memory
 *
 *   - [ISO timestamp] entry text
 *   - [ISO timestamp] entry text
 *   ...
 *
 * Replaces the prior AFFECT.md + DIARY.md split. The LLM writes its own
 * summaries (one per loop) and any mid-loop moments worth keeping. No
 * model-driven compaction — entries persist until forgotten or rolled off
 * by display-budget truncation.
 */

import { readFile } from 'node:fs/promises'
import { atomicWrite } from '../storage/atomicWrite.js'
import { withFileLock } from '../storage/fileLock.js'

const HEADER =
  '# Memory\n' +
  '\n' +
  'Append-only record. One line per entry. Written via remember(); removed via forget().\n' +
  '\n'

function entryLine(timestamp, text) {
  const safe = String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim()
  return `- [${timestamp}] ${safe}\n`
}

export function createMemoryLog({ path: filePath } = {}) {
  if (!filePath) throw new Error('createMemoryLog: path required')
  return {
    path: filePath,
    append: (text, when) => appendMemory(filePath, text, when),
    forget: (query) => forgetMemory(filePath, query),
    readAll: () => readMemoryFull(filePath),
  }
}

export async function appendMemory(filePath, text, when) {
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
    if (!existing.startsWith('# Memory')) existing = HEADER + existing
    await atomicWrite(filePath, existing + line)
    return 1
  })
}

/**
 * Remove all entries whose text contains `query` (case-insensitive substring).
 * Returns the number of removed lines.
 */
export async function forgetMemory(filePath, query) {
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
      // Only entry lines (`- [iso] ...`) are candidates. Header / blank lines pass through.
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

export async function readMemoryFull(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await atomicWrite(filePath, HEADER)
      return HEADER
    }
    throw err
  }
}

/**
 * Read memory, but cap the body at `budgetBytes` by dropping oldest entries
 * from the display (file on disk is untouched). The header is always preserved.
 */
export async function readMemoryForSeed(filePath, budgetBytes) {
  const full = await readMemoryFull(filePath)
  if (Buffer.byteLength(full, 'utf8') <= budgetBytes) return full

  const lines = full.split('\n')
  // Split into [header, ...entries]. Header ends at the first blank line after
  // the format-explanation block.
  let headerEnd = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[/.test(lines[i])) { headerEnd = i; break }
    headerEnd = i + 1
  }
  const header = lines.slice(0, headerEnd).join('\n')
  const entries = lines.slice(headerEnd).filter(l => /^- \[/.test(l))
  if (entries.length === 0) return full

  const headerBytes = Buffer.byteLength(header + '\n', 'utf8')
  const marker = '- [...older memory truncated]\n'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  let remaining = budgetBytes - headerBytes - markerBytes
  const kept = []
  // Walk newest → oldest, including until budget exhausted.
  for (let i = entries.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(entries[i] + '\n', 'utf8')
    if (lineBytes > remaining) break
    kept.unshift(entries[i])
    remaining -= lineBytes
  }
  return header + '\n' + marker + kept.join('\n') + '\n'
}
