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

// 261020: the section for memories written OUTSIDE a game world (texting in
// the app, out-of-game calls, chess, Draw!, a screen share). MEMORY.md is
// segmented by `## World N` headers, but those writers appended at the end of
// the file, so their entries landed under whatever game world came last: a
// Minecraft build the player described in text chat sat under a Stardew
// farm's header, and the next Stardew session took it for a Stardew task.
// appendMemory({ section: 'app' }) opens this section first when the file's
// last section is a world. Like world headers it is not an entry line, and
// the seed reader, the duplicate guard and the compactor treat every `## `
// line as a section header.
export const APP_SECTION_HEADER = '## In the app (texting, calls and minigames, outside any game world)'

const SECTION_RE = /^## /

/** The last `## ` section header line of a MEMORY.md body, or null. */
export function lastSectionHeader(body) {
  const m = String(body ?? '').match(/^## .*$/gm)
  return m && m.length ? m[m.length - 1] : null
}

export function createMemoryLog({ path: filePath } = {}) {
  if (!filePath) throw new Error('createMemoryLog: path required')
  return {
    path: filePath,
    append: (text, when, opts) => appendMemory(filePath, text, when, opts),
    forget: (query) => forgetMemory(filePath, query),
    readAll: () => readMemoryFull(filePath),
    noteWorld: (num, label, game) => noteWorld(filePath, num, label, game),
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
export async function noteWorld(filePath, num, label, game) {
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
    // Skip if the most recent section header is already this world. 261020:
    // any section counts (the app section too), so a world re-entered after
    // app memories gets its header again and its entries are not filed
    // under the app section.
    if (lastSectionIsWorld(existing, num)) return 0
    const sep = existing.endsWith('\n') ? '' : '\n'
    const header = worldHeaderLine(num, label, game)
    await atomicWrite(filePath, `${existing}${sep}\n${header}\n`)
    await archiveAppend(filePath, `\n${header}\n`)
    return 1
  })
}

/** Whether the last section header of a MEMORY.md body is `## World <num>`. */
function lastSectionIsWorld(body, num) {
  const lastHeader = lastSectionHeader(body)
  const lastWorld = lastHeader ? /^## World (\d+)\b/.exec(lastHeader) : null
  return !!lastWorld && Number(lastWorld[1]) === num
}

/**
 * The header line for a world. 261020: it names the game too ("## World 2 —
 * Sei Farm (Stardew Valley)"). World numbers are shared by every game a
 * character plays, and a farm name alone does not say which game the section
 * is from.
 */
function worldHeaderLine(num, label, game) {
  const gamePart = typeof game === 'string' && game.trim() && !String(label ?? '').includes(game.trim()) ? ` (${game.trim()})` : ''
  const labelPart = label ? ` — ${label}${gamePart}` : gamePart
  return `## World ${num}${labelPart}`
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
// whitespace. Same idea as the heartbeat's normalizeGoal. 261113: exported
// for main's fact saves (chat/memoryFacts.ts), which dedupe against the whole
// file rather than this append path's 10-minute window.
export function normalizeEntry(text) {
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
  const lastHeader = existing.lastIndexOf('\n## ')
  const segment = lastHeader === -1 ? existing : existing.slice(lastHeader)
  const cutoff = atMs - DEDUPE_WINDOW_MS
  for (const m of segment.matchAll(/^- \[([^\]]*)\] (.*)$/gm)) {
    const at = Date.parse(m[1])
    if (!Number.isFinite(at) || at < cutoff) continue
    if (normalizeEntry(m[2]) === key) return true
  }
  return false
}

/**
 * @param {string} filePath
 * @param {string} text
 * @param {Date | string} [when]
 * @param {{ section?: 'app', world?: { num: number, label?: string, game?: string } }} [opts]
 *   261020: `section: 'app'` = written outside a game world (main's chat,
 *   call, chess, Draw!, backseat writers): filed under APP_SECTION_HEADER
 *   when the file's last section is a world. `world` = written by a game
 *   session in that world (the bot): when an app writer opened another
 *   section after this session's world header (a group-call greeting, a
 *   late player-end save), the world header is written again first, in the
 *   same lock, so the entry is not filed under that section.
 */
export async function appendMemory(filePath, text, when, opts = {}) {
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
    let chunk = line
    const world = opts?.world
    if (world && Number.isFinite(world.num) && lastSectionHeader(existing) !== null && !lastSectionIsWorld(existing, world.num)) {
      chunk = `${existing.endsWith('\n') ? '' : '\n'}\n${worldHeaderLine(world.num, world.label, world.game)}\n${line}`
    } else if (opts?.section === 'app') {
      const last = lastSectionHeader(existing)
      if (last !== null && last !== APP_SECTION_HEADER) {
        chunk = `${existing.endsWith('\n') ? '' : '\n'}\n${APP_SECTION_HEADER}\n${line}`
      }
    }
    await atomicWrite(filePath, existing + chunk)
    await archiveAppend(filePath, chunk)
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
    if (/^- \[/.test(lines[i]) || SECTION_RE.test(lines[i])) { headerEnd = i; break }
    headerEnd = i + 1
  }
  const header = lines.slice(0, headerEnd).join('\n')
  const body = lines.slice(headerEnd)
  const entryIdx = []
  for (let i = 0; i < body.length; i++) if (/^- \[/.test(body[i])) entryIdx.push(i)
  const trunc = '- [...older memory truncated]'
  const truncBytes = Buffer.byteLength(trunc + '\n', 'utf8')
  if (entryIdx.length === 0) {
    // 261013: a file over budget with no entry lines used to come back WHOLE,
    // the one path around the budget, straight into the pinned seed turn the
    // context safety net never trims. Every app writer (remember(), the
    // heartbeat log, the compactor, which keeps only `- [` lines) writes
    // entries, so only a hand-edited file lands here; it now gets the same
    // budget as every other file, newest lines kept.
    const kept = []
    let room = budgetBytes - truncBytes
    for (let i = lines.length - 1; i >= 0; i--) {
      const b = Buffer.byteLength(lines[i] + '\n', 'utf8')
      if (b > room) break
      kept.unshift(lines[i])
      room -= b
    }
    return humanizeMemoryStamps([trunc, ...kept].join('\n'))
  }

  // Section markers (worlds, the app section) carry essential context: each
  // kept entry keeps the header of the section it sits in, and the last header
  // (the section being written now) is always kept. 261020: headers of
  // sections whose entries were all truncated are left out and every kept
  // header is paid from the budget. A player who alternates a game and texting
  // gets a header pair per session (the compactor merges them later), and
  // keeping all of them unpaid let headers alone overrun the budget.
  const sectionOf = new Array(body.length).fill(-1)
  let lastMarker = -1
  for (let i = 0; i < body.length; i++) {
    if (SECTION_RE.test(body[i])) lastMarker = i
    sectionOf[i] = lastMarker
  }
  const bytesOf = (l) => Buffer.byteLength(l + '\n', 'utf8')
  const headerBytes = Buffer.byteLength(header + '\n', 'utf8')
  let remaining = budgetBytes - headerBytes - truncBytes
  const keep = new Set()
  if (lastMarker !== -1) {
    keep.add(lastMarker)
    remaining -= bytesOf(body[lastMarker])
  }
  // Walk newest → oldest entries, keeping until the byte budget is exhausted.
  for (let k = entryIdx.length - 1; k >= 0; k--) {
    const i = entryIdx[k]
    const m = sectionOf[i]
    const cost = bytesOf(body[i]) + (m !== -1 && !keep.has(m) ? bytesOf(body[m]) : 0)
    if (cost > remaining) break
    keep.add(i)
    if (m !== -1) keep.add(m)
    remaining -= cost
  }
  // Reconstruct in ORIGINAL order: header, truncation marker, then the kept
  // section headers and entries, so the surviving entries stay under their
  // section.
  const out = [header, trunc]
  for (let i = 0; i < body.length; i++) {
    if (keep.has(i)) out.push(body[i])
  }
  return humanizeMemoryStamps(out.join('\n') + '\n')
}
