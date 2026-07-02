// src/bot/brain/log.js — transparent live logging for debugging.
//
// Event-per-line multi-line emission.
//   - Each event opens with `[ts] [tag] begin` and closes with `[ts] [tag] end`,
//     sharing ONE timestamp captured at the start of the call.
//   - Continuation lines are indented exactly 2 spaces; multi-line section
//     bodies get 4 spaces total (2 for the section + 2 for nesting).
//   - Inline truncation is gone — long payloads print in full. Size control
//     is delegated to a session-scoped hash dictionary that elides three
//     cached prompt blocks (persona, capability, diary) to short hash refs
//     on second+ appearances within the same process lifetime (D-4..D-7).
//
// Public API is stable: every existing emitter keeps its old call signature.
// `logHaikuQuery` additively accepts `systemBlocks` and `namedUserBlocks`.

import { createHash } from 'node:crypto'

/**
 * ITEM 1 (quick/260523-t8d) — log-volume gate.
 *
 * Suppress the game-state-rich `[haiku?]` request log AND its companion
 * `[haiku!]` response log when:
 *   - process.env.SEI_BACKEND === 'local'   (BYOK mode)
 *   AND
 *   - !process.env.SEI_HAS_API_KEY          (no key on disk)
 *
 * In that state every haiku call 401s before reaching the model, so the
 * snapshot dump is pure cognitive noise for the user staring at the LogsBar
 * with no key yet. The moment EITHER condition flips (key added OR
 * backend → cloud-proxy), the next bot fork picks up new env values and the
 * logs reappear unmodified — no in-process re-evaluation needed because the
 * bot is re-spawned by the supervisor on summon.
 *
 * Other tags (chat in/out, [act!], [heal], [log]) are NOT gated — those carry
 * actionable information for the user even in the no-key state (e.g. shows
 * which player chatted at the bot before it tried to call Haiku and failed).
 */
function shouldLogPrompts() {
  return !(process.env.SEI_BACKEND === 'local' && !process.env.SEI_HAS_API_KEY)
}

function safeStringify(v) {
  try { return JSON.stringify(v) } catch { return String(v) }
}

function ts() {
  return new Date().toISOString().slice(11, 23)  // HH:MM:SS.mmm
}

// ─── Session-scoped hash dictionary (D-4..D-7) ───────────────────────────
// Module-scope state: resets only when the Node process restarts (D-6 — no
// cross-restart persistence; the rolling log file is per-session).
const _seenHashes = new Set()
let _headerWritten = false

function shortHash(s) {
  const input = typeof s === 'string' ? s : safeStringify(s)
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

// Emit a one-line dictionary header on the FIRST event of the process
// lifetime. Single physical line — no begin/end sentinels. logRouter's TAG_RE
// matches any bracketed tag, so `[log]` classifies cleanly.
function maybeWriteDictHeader() {
  if (_headerWritten) return
  _headerWritten = true
  try {
    console.log(`[${ts()}] [log] cache-prefix dictionary initialized (sha256-8, session-scoped)`)
  } catch {}
}

// First appearance: print body in full, append the hash ref on its own line so
// later occurrences can be grepped back to their source body.
// Subsequent appearances within the session: short hash ref only.
function elideOrFull(name, body) {
  const h = shortHash(body)
  if (_seenHashes.has(h)) {
    return `<${name} @sha=${h}>`
  }
  _seenHashes.add(h)
  return `${body}\n<${name} @sha=${h}>`
}

// ─── Multi-line emit primitive (D-1, D-3) ────────────────────────────────
// `sections` is `Array<{label: string, body: string}>`.
// Output:
//   [ts] [tag] begin
//     label1: body-first-line
//       body-continuation-line
//     label2: body
//   [ts] [tag] end
//
// All output lines are joined with `\n` and written through a SINGLE
// console.log call so the block is atomic from Node's perspective.
function emitBlock(tag, sections) {
  maybeWriteDictHeader()
  try {
    const t = ts()
    const lines = [`[${t}] ${tag} begin`]
    for (const { label, body } of sections) {
      const bodyStr = body == null ? '' : (typeof body === 'string' ? body : safeStringify(body))
      const bodyLines = bodyStr.split('\n')
      lines.push(`  ${label}: ${bodyLines[0]}`)
      for (let i = 1; i < bodyLines.length; i++) {
        lines.push(`    ${bodyLines[i]}`)
      }
    }
    lines.push(`[${t}] ${tag} end`)
    console.log(lines.join('\n'))
  } catch {}
}

// ─── Chat ────────────────────────────────────────────────────────────────
export function logChatIn(username, message) {
  emitBlock('[chat<-]', [
    { label: 'from', body: String(username ?? '') },
    { label: 'text', body: typeof message === 'string' ? message : safeStringify(message) },
  ])
}

export function logChatOut(text) {
  emitBlock('[chat->]', [
    { label: 'text', body: typeof text === 'string' ? text : safeStringify(text) },
  ])
}

// ─── Personality LLM (Anthropic / Haiku) ─────────────────────────────────
/**
 * @param {object} req
 * @param {Array<any>} req.messages
 * @param {Array<{name:string}>} [req.tools]
 * @param {Array<{type:string,text?:string}>} [req.systemBlocks]
 *   5-block array from anthropicClient.buildCachedSystem; index 1 = persona,
 *   index 2 = capability.
 * @param {Array<{role:string,content:Array<{type:string,name?:string,text?:string}>}>} [req.namedUserBlocks]
 *   Canonical pre-strip user-content array(s) carrying `name` fields. The
 *   logger scans the LAST user-role entry's content for `name === 'seed_diary'`
 *   (hashed as `diary`) and emits every other named text block inline by its
 *   `name` field as the section label (D-4, D-8).
 */
// Named user-content blocks whose content is static (or near-static) within a
// session — elided to a `@sha` ref after first appearance. seed_cuboid_grammar
// is fully static; seed_player shifts only when the player profile changes;
// memory shifts every remember()/forget(). Hashing collapses repetition;
// when the body changes the hash changes and the new body is emitted in full.
const STATIC_NAMED_BLOCKS = new Set(['seed_player', 'seed_cuboid_grammar', 'memory'])

export function logHaikuQuery({ messages, tools, systemBlocks, namedUserBlocks }) {
  // ITEM 1 — gate the game-state-rich snapshot dump when the bot is in BYOK
  // mode without a key. See shouldLogPrompts() docblock for rationale.
  if (!shouldLogPrompts()) return
  const toolNames = (tools ?? []).map(t => t.name).join(', ')
  // The tool list rarely changes within a session — hash it after first sight.
  const toolsBody = toolNames.length > 0 ? elideOrFull('tools', toolNames) : ''

  // Find last user-role entry in namedUserBlocks.
  let lastUser = null
  if (Array.isArray(namedUserBlocks)) {
    for (let i = namedUserBlocks.length - 1; i >= 0; i--) {
      if (namedUserBlocks[i]?.role === 'user') { lastUser = namedUserBlocks[i]; break }
    }
  }

  const userBodyLines = []

  // 5a. persona — systemBlocks[1]
  const personaText = systemBlocks?.[1]?.text
  if (typeof personaText === 'string' && personaText.length > 0) {
    userBodyLines.push(elideOrFull('persona', personaText))
  }

  // 5b. capability — systemBlocks[2]
  const capabilityText = systemBlocks?.[2]?.text
  if (typeof capabilityText === 'string' && capabilityText.length > 0) {
    userBodyLines.push(elideOrFull('capability', capabilityText))
  }

  // 5c. Every named text block — inline in full, preserving order.
  //   Observed names from orchestrator.js: seed_player, seed_cuboid_grammar,
  //   memory, recent_player_chat, your_recent_messages, event, snapshot.
  //   STATIC_NAMED_BLOCKS entries are hashed after first sight; the rest
  //   are printed inline (per-call dynamic sections never hashed).
  const reserved = new Set(['persona', 'capability'])
  if (lastUser && Array.isArray(lastUser.content)) {
    for (const b of lastUser.content) {
      if (b?.type !== 'text') continue
      if (typeof b.name !== 'string' || b.name.length === 0) continue
      if (reserved.has(b.name)) continue
      const txt = typeof b.text === 'string' ? b.text : safeStringify(b.text)
      if (STATIC_NAMED_BLOCKS.has(b.name)) {
        userBodyLines.push(elideOrFull(b.name, txt))
      } else {
        userBodyLines.push(`${b.name}: ${txt}`)
      }
    }
  }

  // 5e. Fallback — no namedUserBlocks yet.
  if (userBodyLines.length === 0) {
    userBodyLines.push(`raw: ${safeStringify(messages?.[messages.length - 1]?.content)}`)
  }

  emitBlock('[haiku?]', [
    { label: 'tools', body: toolsBody },
    { label: 'user', body: userBodyLines.join('\n') },
  ])
}

export function logHaikuResponse({ text, toolUses, usage, stopReason, elapsedMs }) {
  // ITEM 1 — paired suppression with logHaikuQuery; never log a response when
  // we suppressed the request.
  if (!shouldLogPrompts()) return
  const calls = (toolUses ?? []).map(u => `${u.name}(${safeStringify(u.input)})`)
  const callsBody = calls.length === 0 ? '(none)' : calls.join('\n')
  emitBlock('[haiku!]', [
    { label: 'stop', body: String(stopReason ?? '') },
    // 260607: per-call wall-clock so latency spikes (and silent SDK retries —
    // elapsed >> one attempt) are visible. Previously a slow/failed call showed
    // only as a [haiku?] with no [haiku!], invisible to anyone reading logs.
    ...(Number.isFinite(elapsedMs) ? [{ label: 'elapsed', body: `${elapsedMs}ms` }] : []),
    { label: 'text', body: text && text.length > 0 ? text : '(empty)' },
    { label: 'calls', body: callsBody },
    { label: 'usage', body: safeStringify(usage) },
  ])
}

// 260607: companion to [haiku!] — fires when a personality call ABORTS, TIMES
// OUT, or ERRORS, instead of silently leaving a [haiku?] with no response.
// `elapsed` here is the key diagnostic: an elapsed near the per-call budget
// with a TimeoutError is a stalled upstream; a small elapsed with a 5xx/429 is
// a fast upstream rejection. Gated like the other haiku logs.
export function logHaikuError({ elapsedMs, name, message, status }) {
  if (!shouldLogPrompts()) return
  const statusPart = (status !== undefined && status !== null) ? ` (${status})` : ''
  emitBlock('[haiku✗]', [
    ...(Number.isFinite(elapsedMs) ? [{ label: 'elapsed', body: `${elapsedMs}ms` }] : []),
    { label: 'error', body: `${name ?? 'Error'}${statusPart}: ${message ?? ''}` },
  ])
}

// ─── Position healer ─────────────────────────────────────────────────────
export function logHeal({ pos, vel, yaw, pitch }) {
  emitBlock('[heal]', [
    { label: 'pos', body: String(pos) },
    { label: 'vel', body: String(vel) },
    { label: 'yaw', body: String(yaw) },
    { label: 'pitch', body: String(pitch) },
  ])
}

// ─── Action results (echo for visibility) ────────────────────────────────
export function logActionResult(name, result) {
  const resultStr = typeof result === 'string' ? result : safeStringify(result)
  emitBlock('[act!]', [
    { label: 'action', body: String(name) },
    { label: 'result', body: resultStr },
  ])
}
