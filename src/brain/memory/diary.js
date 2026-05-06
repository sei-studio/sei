/**
 * DIARY.md store — newest-first dated entries (D-49 / D-50).
 *
 * Each entry:
 *   ## YYYY-MM-DD HH:MM — <topic ≤ 6 words>
 *   2–4 sentences of in-character prose.
 *   <blank line>
 *
 * After consolidation (Plan 3-03), older entries collapse into a single
 *   ## Earlier (consolidated through YYYY-MM-DD)
 *   <denser paragraph>
 * block at the bottom.
 *
 * Lazy-create per Q4: `seedSlice` and `readAll` on a missing file return
 * placeholder/empty without creating the file. The file is only created on
 * the first `appendEntry` call.
 *
 * Concurrency: a module-level mutex (Pitfall 7) guards `appendEntry` and
 * `replaceOlderHalf`. The non-blocking poll (max 2s) means a per-loop-batch
 * write may drop with a warning if a long-running consolidation is in flight
 * — loss of one diary entry is acceptable per spec.
 */

import { readFile, stat } from 'node:fs/promises'
import { atomicWrite } from '../storage/atomicWrite.js'

let writeLock = false
const LOCK_POLL_MAX_MS = 2000
const LOCK_POLL_INTERVAL_MS = 25

async function acquireWriteLock() {
  if (!writeLock) { writeLock = true; return true }
  const start = Date.now()
  while (writeLock && Date.now() - start < LOCK_POLL_MAX_MS) {
    await new Promise(r => setTimeout(r, LOCK_POLL_INTERVAL_MS))
  }
  if (writeLock) return false
  writeLock = true
  return true
}

function releaseWriteLock() {
  writeLock = false
}

/**
 * Format a Date as `YYYY-MM-DD HH:MM` in UTC (D-49 deterministic prefix).
 */
function formatTimestampUTC(when) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}`
}

/**
 * Truncate `topic` to its first ≤ 6 whitespace-separated words.
 */
function truncateTopic(topic) {
  const words = String(topic ?? '').trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 6).join(' ')
}

/**
 * @typedef {Object} DiaryEntry
 * @property {string}  headingLine   — raw `## ...` line
 * @property {string}  body          — body lines joined with `\n` (no trailing blank)
 * @property {boolean} isConsolidated — heading.startsWith('## Earlier (')
 */

/**
 * Parse the full DIARY.md text into newest-first entries.
 * Entries are demarcated by lines starting with `## `.
 * @param {string} raw
 * @returns {DiaryEntry[]}
 */
function parseDiary(raw) {
  if (!raw) return []
  const lines = raw.split(/\r?\n/)
  const entries = []
  let cur = null
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (cur) entries.push(cur)
      cur = {
        headingLine: line,
        body: '',
        isConsolidated: line.startsWith('## Earlier ('),
      }
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + line
    }
    // Any leading content before the first `## ` heading is dropped.
  }
  if (cur) entries.push(cur)
  // Trim trailing blank-only lines from each body.
  for (const e of entries) {
    e.body = e.body.replace(/\s+$/, '')
  }
  return entries
}

function serializeEntries(entries) {
  return entries.map(e => `${e.headingLine}\n${e.body}\n`).join('\n')
}

/**
 * Create a DIARY.md store factory.
 * @param {Object} opts
 * @param {string} opts.path
 * @param {number} opts.seedDiaryBudgetBytes
 * @param {{warn:Function,info?:Function,debug?:Function}} [opts.logger]
 */
export function createDiary({ path, seedDiaryBudgetBytes, logger = console } = {}) {
  if (!path) throw new Error('createDiary: path is required')
  if (!seedDiaryBudgetBytes || seedDiaryBudgetBytes < 1) {
    throw new Error('createDiary: seedDiaryBudgetBytes must be >= 1')
  }

  let cached = null

  async function readRaw() {
    try {
      return await readFile(path, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return ''
      throw err
    }
  }

  async function readAll() {
    if (cached) return cached.slice()
    const raw = await readRaw()
    cached = parseDiary(raw)
    return cached.slice()
  }

  async function appendEntry({ topic, body, when = new Date() } = {}) {
    const ts = formatTimestampUTC(when)
    const topicShort = truncateTopic(topic)
    const heading = `## ${ts} — ${topicShort}`
    const entryText = `${heading}\n${body ?? ''}\n\n`

    const acquired = await acquireWriteLock()
    if (!acquired) {
      logger.warn?.(`[sei/diary] writeLock contention at appendEntry — dropping entry (${heading})`)
      return
    }
    try {
      const existing = await readRaw()
      const next = entryText + existing
      await atomicWrite(path, next)
      cached = null
    } finally {
      releaseWriteLock()
    }
  }

  /**
   * Newest-first byte-budget walk (D-50). Returns markdown beginning with
   * `# Diary (recent first)` and packs entries until the next entry would
   * exceed the budget.
   * @returns {Promise<string>}
   */
  async function seedSlice() {
    const entries = await readAll()
    const header = '# Diary (recent first)\n'
    const placeholder = `${header}(no prior history yet)\n`
    if (entries.length === 0) return placeholder

    const truncatedMarker = '…(older entries truncated)\n'
    const headerBytes = Buffer.byteLength(header, 'utf8')
    let budget = seedDiaryBudgetBytes - headerBytes

    const kept = []
    for (const e of entries) {
      const block = `${e.headingLine}\n${e.body}\n\n`
      const blockBytes = Buffer.byteLength(block, 'utf8')
      if (blockBytes > budget) break
      kept.push(block)
      budget -= blockBytes
    }

    const truncated = kept.length < entries.length
    let body = kept.join('')
    if (truncated) {
      const markerBytes = Buffer.byteLength(truncatedMarker, 'utf8')
      while (kept.length > 0 && headerBytes + Buffer.byteLength(body, 'utf8') + markerBytes > seedDiaryBudgetBytes) {
        const dropped = kept.pop()
        body = kept.join('')
      }
      body += truncatedMarker
    }
    if (kept.length === 0 && truncated) {
      // Edge case: even the newest entry doesn't fit the budget. Return
      // header + truncation marker only — better than violating budget.
      return header + truncatedMarker
    }
    return header + body
  }

  /**
   * Replace the older half of entries with a single consolidated block.
   * Keeps `max(ceil(N/2), 5)` newest entries untouched at the top.
   * If the file has ≤ 5 entries, no-op (warns).
   *
   * @param {string} replacement  Raw markdown of the consolidated block
   *   (must start with a `## ` heading line, e.g. `## Earlier (consolidated through YYYY-MM-DD)`).
   */
  async function replaceOlderHalf(replacement) {
    const entries = await readAll()
    if (entries.length <= 5) {
      logger.warn?.(`[sei/diary] replaceOlderHalf: only ${entries.length} entries — no-op`)
      return
    }
    const keep = Math.max(Math.ceil(entries.length / 2), 5)
    const top = entries.slice(0, keep)

    const acquired = await acquireWriteLock()
    if (!acquired) {
      logger.warn?.(`[sei/diary] writeLock contention at replaceOlderHalf — skipping`)
      return
    }
    try {
      const topText = serializeEntries(top)
      const replText = replacement.endsWith('\n') ? replacement : replacement + '\n'
      const next = topText + replText
      await atomicWrite(path, next)
      cached = null
    } finally {
      releaseWriteLock()
    }
  }

  async function getFileSizeBytes() {
    try {
      const s = await stat(path)
      return s.size
    } catch (err) {
      if (err && err.code === 'ENOENT') return 0
      throw err
    }
  }

  return {
    readAll,
    appendEntry,
    seedSlice,
    replaceOlderHalf,
    getFileSizeBytes,
    _internal: { get cached() { return cached } },
  }
}
