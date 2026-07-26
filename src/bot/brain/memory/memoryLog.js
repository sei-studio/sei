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

import { readFile, appendFile, access } from 'node:fs/promises'
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

const STAMP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Model-facing stamp humanization (260725). Entries are STORED with UTC ISO
 * timestamps (stable, sortable, parser-friendly — the file format does not
 * change), but the model reads them next to a local-time clock line like
 * "Fri 25 Jul 2026, 14:57", and relating a UTC ISO instant to that reliably
 * misjudges "how long ago" (live capture: a two-week-old "packing for LA"
 * note surfaced as a days-old thread) and lands evening notes on the wrong
 * day. So at READ time entry stamps are rendered in the same local format as
 * the clock: "- [11 Jul 2026, 09:23] ...". Non-ISO bracket lines (the
 * truncation marker, world headers) pass through untouched.
 */
export function humanizeMemoryStamps(text) {
  return String(text ?? '').replace(
    /^(- \[)(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)(\])/gm,
    (full, open, iso, close) => {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return full
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      return `${open}${d.getDate()} ${STAMP_MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}${close}`
    },
  )
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
    await archiveAppend(filePath, `\n## World ${num}${labelPart}\n`)
    return 1
  })
}

// ── Raw archive (260725) ────────────────────────────────────────────────
// A write-only shadow of MEMORY.md: every entry line and world header is
// mirrored here at append time and then NEVER touched again — not by the
// compactor, not by forget(), not by any truncation, and nothing reads it at
// runtime. It exists purely so that if compaction tech improves later, the
// original uncompacted memories can be recovered. Best-effort by design: an
// archive failure must never break a remember().

const ARCHIVE_HEADER =
  '# Memory archive\n' +
  '\n' +
  'Raw append-only mirror of every memory write. Never compacted, never\n' +
  'forgotten from, never read by the app. Kept for future recovery only.\n' +
  '\n'

function archivePath(filePath) {
  return filePath.replace(/\.md$/i, '') + '.archive.md'
}

async function archiveAppend(filePath, chunk) {
  try {
    const dest = archivePath(filePath)
    let needHeader = false
    try { await access(dest) } catch { needHeader = true }
    await appendFile(dest, (needHeader ? ARCHIVE_HEADER : '') + chunk)
  } catch { /* best-effort */ }
}

// Loose near-duplicate key: lowercase, letters/digits/spaces only, collapsed
// whitespace. Same idea as the heartbeat's normalizeGoal.
function normalizeEntry(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// How far back the duplicate guard looks. The guard exists for a same-breath
// double fire (live capture: the identical line written twice 9s apart, three
// "marv goes by mars" variants inside 42s) — NOT for permanently banning a
// fact. A thing the player re-confirms next week MUST append again: the seed
// prompt now tells the model to mind the gap between an entry's stamp and
// today ("a weeks-old note is an old thread"), so keeping the old stamp would
// make a fresh confirmation read as stale history.
const DEDUPE_WINDOW_MS = 10 * 60_000

/**
 * True when `key` already exists as an entry written inside DEDUPE_WINDOW_MS
 * of `atMs` AND inside the CURRENT world segment (everything after the last
 * `## World` header). Both bounds are deliberate: cross-world and older
 * matches are the compactor's problem, not the append path's.
 */
function isRecentDuplicate(existing, key, atMs) {
  const lastHeader = existing.lastIndexOf('\n## World ')
  const segment = lastHeader === -1 ? existing : existing.slice(lastHeader)
  const cutoff = atMs - DEDUPE_WINDOW_MS
  for (const m of segment.matchAll(/^- \[([^\]]*)\] (.*)$/gm)) {
    const at = Date.parse(m[1])
    if (!Number.isFinite(at) || at < cutoff) continue
    if (normalizeEntry(m[2]) === key) return true
  }
  return false
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
    // Duplicate guard (260725): remember() sometimes fires twice in one breath
    // (live capture: "hang up when they say bye" written twice, 9s apart).
    // Skip an append whose normalized text EXACTLY matches a RECENT entry in
    // THIS world — deliberately loose, near-misses are the compactor's job.
    // Bounded on purpose: see DEDUPE_WINDOW_MS. Callers must treat 0 as "not
    // written" (the remember() tool_result says so).
    const atMs = Number.isFinite(whenDate.getTime()) ? whenDate.getTime() : Date.now()
    if (isRecentDuplicate(existing, normalizeEntry(safe), atMs)) return 0
    await atomicWrite(filePath, existing + line)
    await archiveAppend(filePath, line)
    return 1
  })
}

/**
 * Remove all entries whose text contains `query` (case-insensitive substring).
 * Returns the number of removed lines.
 *
 * 260725: the query is matched against the entry as the MODEL SAW IT as well
 * as against the raw line. Entries are stored with UTC ISO stamps but every
 * seed read runs through humanizeMemoryStamps, so a forget() that quotes the
 * entry the way it was shown ("- [11 Jul 2026, 09:23] they are packing for
 * LA") could never match the ISO line on disk. Two tolerances cover it: the
 * humanized rendering of each line is a second haystack, and a leading entry
 * prefix is stripped off the query so the remaining text still matches.
 */
export async function forgetMemory(filePath, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return 0
  // "- [11 Jul 2026, 09:23] text" / "[11 jul 2026, 09:23] text" → "text". Only
  // a leading BRACKETED stamp is stripped (so a query that legitimately starts
  // with a dash is left alone), which narrows the match rather than widening
  // it; a query that is nothing but a stamp strips to empty and falls back to
  // the humanized-line haystack.
  const qText = q.replace(/^(?:-\s*)?\[[^\]]*\]\s*/, '').trim()

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
      if (/^- \[/.test(line)) {
        const stored = line.toLowerCase()
        const shown = humanizeMemoryStamps(line).toLowerCase()
        if (
          stored.includes(q) || shown.includes(q) ||
          (qText && (stored.includes(qText) || shown.includes(qText)))
        ) {
          removed += 1
          continue
        }
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
  if (Buffer.byteLength(full, 'utf8') <= budgetBytes) return humanizeMemoryStamps(full)

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
  return humanizeMemoryStamps(out.join('\n') + '\n')
}
