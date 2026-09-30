/**
 * Lookup log: what the companion found on the web, kept for the session.
 *
 * A web search lives inside ONE loop's history (the server_tool_use +
 * web_search_tool_result pair, or the client search()/visit() tool_results),
 * and a loop's history is dropped when the loop ends. So everything she
 * learned was gone by her next turn. Measured on a Stardew session (260921):
 * asked whether every farm starts the same, she searched in three separate
 * turns inside 50 seconds (four billed searches), and because no turn could
 * see what the previous one had found, each re-derived the answer in new
 * words. The player got six answers, two of them contradicting the others,
 * and by the fourth the search text about multiplayer cabins had turned into
 * "your cabin's in a different spot than mine", a cabin she does not have.
 *
 * The fix is to keep the FINDING, not to police the answers: a short note per
 * lookup (the query, what she concluded in her own scratchpad, what she told
 * the player), rendered into every later seed turn. Pure; no I/O.
 */

const LOOKUP_CAPACITY = 6
const FINDING_MAX_CHARS = 500
const TOLD_MAX_CHARS = 240

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

/**
 * Pull the server-side searches out of one assistant response.
 *
 * `content` is the raw Anthropic content array. The queries are the
 * `server_tool_use` inputs; the finding is the model's own text AFTER the last
 * result block (text before it is the "let me check" preamble, not a finding).
 *
 * @param {Array<object>} content
 * @returns {{queries: string[], finding: string}|null} null when no search ran
 */
export function extractServerLookup(content) {
  if (!Array.isArray(content)) return null
  const queries = []
  let lastResultIdx = -1
  content.forEach((b, i) => {
    if (!b || typeof b !== 'object') return
    if (b.type === 'server_tool_use' && b.name === 'web_search') {
      const q = String(b.input?.query ?? '').trim()
      if (q) queries.push(q)
    }
    if (b.type === 'web_search_tool_result') lastResultIdx = i
  })
  if (queries.length === 0 && lastResultIdx < 0) return null
  const finding = content
    .slice(lastResultIdx + 1)
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join(' ')
  return { queries, finding: finding.trim() }
}

function fmtAgo(now, at) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

export const LOOKUPS_HEADER =
  'What you looked up on the web earlier this session, oldest first (your own notes; the player never saw them). This is what you FOUND, so it outranks a guess: answer follow-up questions on the same topic from these notes, keep what you say consistent with what you already told them, and do not search for the same thing again. If a note shows an earlier line of yours was wrong, say so plainly.'

export function createLookupLog({ capacity = LOOKUP_CAPACITY } = {}) {
  /** @type {Array<{at:number, queries:string[], finding:string, told:string}>} */
  const entries = []

  /**
   * @param {object} e
   * @param {string[]} e.queries  what was searched (or the visited ref)
   * @param {string} [e.finding]  her own conclusion, from the private text
   * @param {string} [e.told]     the say() line of the same turn, if any
   */
  function record({ queries, finding = '', told = '' }) {
    const qs = (Array.isArray(queries) ? queries : []).map(q => clip(q, 120)).filter(Boolean)
    const f = clip(finding, FINDING_MAX_CHARS)
    const t = clip(told, TOLD_MAX_CHARS)
    // A search whose turn wrote nothing down has nothing worth keeping.
    if (qs.length === 0 || (!f && !t)) return false
    entries.push({ at: Date.now(), queries: qs, finding: f, told: t })
    while (entries.length > capacity) entries.shift()
    return true
  }

  /** Seed block text, or null when nothing has been looked up. */
  function formatBlock() {
    if (entries.length === 0) return null
    const now = Date.now()
    const body = entries.map(({ at, queries, finding, told }) => {
      const lines = [`[${fmtAgo(now, at)}] searched: ${queries.map(q => `"${q}"`).join(', ')}`]
      if (finding) lines.push(`  found: ${finding}`)
      if (told) lines.push(`  you told them: ${told}`)
      return lines.join('\n')
    }).join('\n')
    return `${LOOKUPS_HEADER}\n${body}`
  }

  return { record, formatBlock, get size() { return entries.length }, _internal: { entries } }
}
