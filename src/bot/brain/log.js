// src/bot/brain/log.js — transparent live logging for debugging.
//
// Phase 5 (D-1, D-3, D-9): event-per-line multi-line emission.
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
export function logHaikuQuery({ messages, tools, systemBlocks, namedUserBlocks }) {
  const toolNames = (tools ?? []).map(t => t.name).join(', ')

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

  // 5c. diary — `name === 'seed_diary'` in last user turn content.
  if (lastUser && Array.isArray(lastUser.content)) {
    for (const b of lastUser.content) {
      if (b?.type === 'text' && b?.name === 'seed_diary' && typeof b.text === 'string' && b.text.length > 0) {
        userBodyLines.push(elideOrFull('diary', b.text))
        break
      }
    }
  }

  // 5d. Every other named text block — inline in full, preserving order.
  //   Observed names from orchestrator.js + compaction.js: seed_owner,
  //   seed_diary, affect_log, recent_loop_history, recent_owner_chat,
  //   your_recent_messages, event, snapshot. Of these, only seed_diary is
  //   hashed (above); the rest are printed inline (D-8: per-call dynamic
  //   sections never hashed). seed_owner is rendered inline by its `name`.
  const reserved = new Set(['persona', 'capability', 'diary', 'seed_diary'])
  if (lastUser && Array.isArray(lastUser.content)) {
    for (const b of lastUser.content) {
      if (b?.type !== 'text') continue
      if (typeof b.name !== 'string' || b.name.length === 0) continue
      if (reserved.has(b.name)) continue
      const txt = typeof b.text === 'string' ? b.text : safeStringify(b.text)
      userBodyLines.push(`${b.name}: ${txt}`)
    }
  }

  // 5e. Fallback — no namedUserBlocks yet (Plan 05-02 wires the orchestrator).
  if (userBodyLines.length === 0) {
    userBodyLines.push(`raw: ${safeStringify(messages?.[messages.length - 1]?.content)}`)
  }

  emitBlock('[haiku?]', [
    { label: 'tools', body: toolNames },
    { label: 'user', body: userBodyLines.join('\n') },
  ])
}

export function logHaikuResponse({ text, toolUses, usage, stopReason }) {
  const calls = (toolUses ?? []).map(u => `${u.name}(${safeStringify(u.input)})`)
  const callsBody = calls.length === 0 ? '(none)' : calls.join('\n')
  emitBlock('[haiku!]', [
    { label: 'stop', body: String(stopReason ?? '') },
    { label: 'text', body: text && text.length > 0 ? text : '(empty)' },
    { label: 'calls', body: callsBody },
    { label: 'usage', body: safeStringify(usage) },
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
