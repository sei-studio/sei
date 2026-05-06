/**
 * OWNER.md store — YAML-frontmatter + freeform `# Notes` body.
 *
 * Per D-46 / D-47, OWNER.md is the canonical source of owner identity:
 *   - `owner_uuid` (source of truth for recognition)
 *   - `owner_username` (current display name; not used for recognition)
 *   - `first_seen`, `last_seen` (ISO timestamps)
 *   - `total_sessions` (integer counter)
 *   - `preferred_name`, `pronouns` (cosmetic)
 *   - `# Notes` body (freeform, LLM-managed)
 *
 * Lazy-create per Q4: `loadOwner` on a missing file returns
 * `{ exists: false, ... }` — it does NOT create the file. Files are only
 * created via `saveOwner` (which goes through atomicWrite).
 *
 * Frontmatter parser is a flat regex (`^([a-z_]+):\s*(.*)$`) — v1 fields are
 * flat per D-47, no `js-yaml` dep needed. Tolerant of unknown keys and
 * malformed lines (V5 input validation; SPEC line 82).
 */

import { readFile } from 'node:fs/promises'
import { atomicWrite } from '../storage/atomicWrite.js'

const FRONT_DELIM = '---'
const KNOWN_KEYS = [
  'owner_uuid',
  'owner_username',
  'first_seen',
  'last_seen',
  'total_sessions',
  'preferred_name',
  'pronouns',
]

/**
 * @typedef {Object} OwnerData
 * @property {string|null} owner_uuid
 * @property {string|null} owner_username
 * @property {string|null} first_seen
 * @property {string|null} last_seen
 * @property {number}      total_sessions
 * @property {string|null} preferred_name
 * @property {string|null} pronouns
 * @property {string}      notes
 * @property {boolean}     exists
 */

function freshOwnerData() {
  return {
    owner_uuid: null,
    owner_username: null,
    first_seen: null,
    last_seen: null,
    total_sessions: 0,
    preferred_name: null,
    pronouns: null,
    notes: '',
    exists: false,
  }
}

/**
 * Read and parse OWNER.md at `path`. Returns a fresh placeholder
 * (`exists: false`) if the file does not exist (Q4 — never creates the file).
 * @param {string} path
 * @returns {Promise<OwnerData>}
 */
export async function loadOwner(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return freshOwnerData()
    throw err
  }
  return parseOwner(raw)
}

function parseOwner(raw) {
  const data = freshOwnerData()
  data.exists = true

  // Detect frontmatter delimiters: leading `---\n` and a closing `---\n` later.
  const lines = raw.split(/\r?\n/)
  let bodyStart = 0
  if (lines[0] === FRONT_DELIM) {
    let i = 1
    while (i < lines.length && lines[i] !== FRONT_DELIM) {
      const m = /^([a-z_]+)\s*:\s*(.*)$/.exec(lines[i])
      if (m) {
        const key = m[1]
        const val = m[2]
        if (KNOWN_KEYS.includes(key)) {
          if (key === 'total_sessions') {
            const n = Number(val)
            data.total_sessions = Number.isFinite(n) ? Math.trunc(n) : 0
          } else {
            // Empty string → null for optional fields; keep raw string otherwise.
            data[key] = val === '' ? null : val
          }
        }
        // Unknown keys are silently ignored (V5 tolerance, SPEC line 82).
      }
      // Lines without `key: value` shape are tolerated: just ignored.
      i++
    }
    // Skip the closing delimiter line if present.
    bodyStart = (i < lines.length && lines[i] === FRONT_DELIM) ? i + 1 : i
  }

  // The body is everything after frontmatter, with optional leading `# Notes` heading.
  let body = lines.slice(bodyStart).join('\n')
  // Strip leading blank lines.
  body = body.replace(/^\s*\n/, '')
  // If body starts with `# Notes`, drop that header line.
  body = body.replace(/^# Notes\s*\n/, '')
  // Trim trailing whitespace/newlines.
  body = body.replace(/\s+$/, '')
  data.notes = body

  return data
}

/**
 * Atomically write OWNER.md at `path` from `data`.
 * @param {string} path
 * @param {OwnerData} data
 */
export async function saveOwner(path, data) {
  const lines = [FRONT_DELIM]
  for (const key of KNOWN_KEYS) {
    let v = data[key]
    if (key === 'total_sessions') {
      v = Number.isFinite(v) ? Math.trunc(v) : 0
      lines.push(`${key}: ${v}`)
    } else {
      // Null/undefined → empty string (preserves shape; loadOwner converts back).
      lines.push(`${key}: ${v == null ? '' : String(v)}`)
    }
  }
  lines.push(FRONT_DELIM)
  lines.push('# Notes')
  lines.push(data.notes ?? '')
  lines.push('') // trailing newline
  await atomicWrite(path, lines.join('\n'))
}

/**
 * Format OWNER.md as the seed_owner markdown block injected into every Loop's
 * first user turn. Frontmatter (recognition fields) is always preserved; the
 * notes body is truncated at the byte boundary if the total exceeds budget.
 * @param {OwnerData} owner
 * @param {number} budgetBytes
 * @returns {string}
 */
export function formatOwnerSeedBlock(owner, budgetBytes) {
  if (!owner || !owner.exists) {
    return '# Owner\n(no owner recorded yet)\n'
  }

  // Header + frontmatter table (always preserved).
  const headerLines = ['# Owner', '']
  for (const key of KNOWN_KEYS) {
    const v = owner[key]
    headerLines.push(`${key}: ${v == null ? '' : String(v)}`)
  }
  headerLines.push('')
  headerLines.push('## Notes')
  const headerStr = headerLines.join('\n') + '\n'
  const headerBytes = Buffer.byteLength(headerStr, 'utf8')

  const notes = owner.notes ?? ''
  if (!notes) return headerStr

  const fullBytes = headerBytes + Buffer.byteLength(notes + '\n', 'utf8')
  if (fullBytes <= budgetBytes) {
    return headerStr + notes + '\n'
  }

  // Truncate notes at byte boundary so total ≤ budget. Leave room for the
  // truncation marker.
  const marker = '\n…(truncated)\n'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const remaining = Math.max(0, budgetBytes - headerBytes - markerBytes)
  const buf = Buffer.from(notes, 'utf8')
  const truncated = buf.subarray(0, remaining).toString('utf8')
  return headerStr + truncated + marker
}
