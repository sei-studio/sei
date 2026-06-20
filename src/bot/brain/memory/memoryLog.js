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
    noteWorld: (num, label) => noteWorld(filePath, num, label),
  }
}

/**
 * World awareness: drop a `## World <num> — <label>` section header so the
 * append-only log reads as world-segmented. Written on join (worlds.js), but
 * only when the world CHANGED — if the last world header already names this
 * world, this is a no-op so repeated summons into the same world don't stack
 * duplicate headers. Headers are deliberately NOT entry lines (`- [`), so
 * forget() leaves them alone; readMemoryForSeed and the compactor are taught to
 * preserve them.
 */
export async function noteWorld(filePath, num, label) {
  if (!Number.isFinite(num)) return 0
  return withFileLock(filePath, async () => {
    let existing = ''
    try {
      existing = await readFile(filePath, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') existing = HEADER
      else throw err
    }
    if (!existing.startsWith('# Memory')) existing = HEADER + existing
    // Skip if the most recent world header is already this world.
    const markers = existing.match(/^## World (\d+)\b/gm)
    if (markers && markers.length) {
      const last = Number(markers[markers.length - 1].replace(/^## World /, ''))
      if (last === num) return 0
    }
    const labelPart = label ? ` — ${label}` : ''
    const sep = existing.endsWith('\n') ? '' : '\n'
    await atomicWrite(filePath, `${existing}${sep}\n## World ${num}${labelPart}\n`)
    return 1
  })
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
  // Header ends at the first entry line OR world marker (whichever comes first).
  let headerEnd = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[/.test(lines[i]) || /^## World /.test(lines[i])) { headerEnd = i; break }
    headerEnd = i + 1
  }
  const header = lines.slice(0, headerEnd).join('\n')
  const body = lines.slice(headerEnd)
  const entryIdx = []
  for (let i = 0; i < body.length; i++) if (/^- \[/.test(body[i])) entryIdx.push(i)
  if (entryIdx.length === 0) return full

  // World markers are tiny and carry essential context — always keep them.
  const markerBytes = body
    .filter((l) => /^## World /.test(l))
    .reduce((s, l) => s + Buffer.byteLength(l + '\n', 'utf8'), 0)
  const headerBytes = Buffer.byteLength(header + '\n', 'utf8')
  const trunc = '- [...older memory truncated]'
  const truncBytes = Buffer.byteLength(trunc + '\n', 'utf8')
  let remaining = budgetBytes - headerBytes - markerBytes - truncBytes
  const keep = new Set()
  // Walk newest → oldest entries, keeping until the byte budget is exhausted.
  for (let k = entryIdx.length - 1; k >= 0; k--) {
    const i = entryIdx[k]
    const lineBytes = Buffer.byteLength(body[i] + '\n', 'utf8')
    if (lineBytes > remaining) break
    keep.add(i)
    remaining -= lineBytes
  }
  // Reconstruct in ORIGINAL order: header, truncation marker, then every world
  // header plus the kept entries — so the surviving entries stay under their
  // world's section.
  const out = [header, trunc]
  for (let i = 0; i < body.length; i++) {
    if (/^## World /.test(body[i]) || keep.has(i)) out.push(body[i])
  }
  return out.join('\n') + '\n'
}
