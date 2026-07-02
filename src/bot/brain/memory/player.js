/**
 * PLAYER.md store — YAML frontmatter only.
 *
 * PLAYER.md is the canonical record of the human player you share the world
 * with — identity (uuid + username), session counters, cosmetic preferences.
 * The bot is a fellow player, not a servant; this file is just "who is the
 * other person in here with me."
 *
 *   - `player_uuid` (source of truth for recognition)
 *   - `player_username` (current display name; not used for recognition)
 *   - `first_seen`, `last_seen` (ISO timestamps)
 *   - `total_sessions` (integer counter)
 *   - `preferred_name`, `pronouns` (cosmetic)
 *
 * 260616: the old freeform `# Notes` body was removed. It was advertised as
 * "LLM-managed" but had no writer (savePlayer is only ever called by the
 * session lifecycle, never with model-authored notes), so it was always empty
 * and overlapped MEMORY.md, which is the real home for the bot's evolving read
 * on the player. A legacy `# Notes` section in an existing PLAYER.md is simply
 * ignored on read and dropped on the next save.
 *
 * Lazy-create: `loadPlayer` on a missing file returns `{ exists: false, ... }`
 * — it does NOT create the file. Files are only created via `savePlayer`
 * (which goes through atomicWrite).
 *
 * Frontmatter parser is a flat regex (`^([a-z_]+):\s*(.*)$`); no `js-yaml`
 * dep needed. Tolerant of unknown keys and malformed lines.
 */

import { readFile } from 'node:fs/promises'
import { atomicWrite } from '../storage/atomicWrite.js'
import { withFileLock } from '../storage/fileLock.js'

const FRONT_DELIM = '---'
const KNOWN_KEYS = [
  'player_uuid',
  'player_username',
  'first_seen',
  'last_seen',
  'total_sessions',
  'preferred_name',
  'pronouns',
]

/**
 * @typedef {Object} PlayerData
 * @property {string|null} player_uuid
 * @property {string|null} player_username
 * @property {string|null} first_seen
 * @property {string|null} last_seen
 * @property {number}      total_sessions
 * @property {string|null} preferred_name
 * @property {string|null} pronouns
 * @property {boolean}     exists
 */

function freshPlayerData() {
  return {
    player_uuid: null,
    player_username: null,
    first_seen: null,
    last_seen: null,
    total_sessions: 0,
    preferred_name: null,
    pronouns: null,
    exists: false,
  }
}

/**
 * Read and parse PLAYER.md at `path`. Returns a fresh placeholder
 * (`exists: false`) if the file does not exist (never creates the file).
 * @param {string} path
 * @returns {Promise<PlayerData>}
 */
export async function loadPlayer(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return freshPlayerData()
    throw err
  }
  return parsePlayer(raw)
}

function parsePlayer(raw) {
  const data = freshPlayerData()
  data.exists = true

  // Parse the frontmatter only. Anything after the closing `---` (e.g. a
  // legacy `# Notes` section) is ignored — see the module header.
  const lines = raw.split(/\r?\n/)
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
            data[key] = val === '' ? null : val
          }
        }
      }
      i++
    }
  }

  return data
}

async function _writePlayerSerialized(path, data) {
  const lines = [FRONT_DELIM]
  for (const key of KNOWN_KEYS) {
    let v = data[key]
    if (key === 'total_sessions') {
      v = Number.isFinite(v) ? Math.trunc(v) : 0
      lines.push(`${key}: ${v}`)
    } else {
      lines.push(`${key}: ${v == null ? '' : String(v)}`)
    }
  }
  lines.push(FRONT_DELIM)
  lines.push('')
  await atomicWrite(path, lines.join('\n'))
}

/**
 * Atomically write PLAYER.md at `path` from `data`. Wrapped in withFileLock
 * so concurrent savePlayer calls do not interleave on the same file.
 */
export async function savePlayer(path, data) {
  return withFileLock(path, () => _writePlayerSerialized(path, data))
}

/**
 * Format PLAYER.md as the seed_player markdown block injected into every
 * Loop's first user turn — the player's identity frontmatter, nothing more.
 * The `budgetBytes` argument is retained for call-site compatibility but is
 * now unused: the block is a small, fixed set of recognition fields with no
 * freeform body to truncate (the `# Notes` body was removed — see header).
 * @param {PlayerData} player
 * @param {number} [budgetBytes] vestigial; ignored
 * @returns {string}
 */
export function formatPlayerSeedBlock(player, budgetBytes) { // eslint-disable-line no-unused-vars
  if (!player || !player.exists) {
    return '# Player\n(no player recorded yet)\n'
  }

  const headerLines = ['# Player', '']
  for (const key of KNOWN_KEYS) {
    const v = player[key]
    headerLines.push(`${key}: ${v == null ? '' : String(v)}`)
  }
  return headerLines.join('\n') + '\n'
}
