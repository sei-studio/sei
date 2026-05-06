// src/log.js — transparent live logging for debugging.
// All chat in/out and Haiku queries+responses are emitted on stdout with
// stable tag prefixes.

const MAX_INLINE = 2000  // truncate very long payloads inline

function trunc(s) {
  if (typeof s !== 'string') s = safeStringify(s)
  return s.length > MAX_INLINE ? s.slice(0, MAX_INLINE) + `…[+${s.length - MAX_INLINE} chars]` : s
}

function safeStringify(v) {
  try { return JSON.stringify(v) } catch { return String(v) }
}

function ts() {
  return new Date().toISOString().slice(11, 23)  // HH:MM:SS.mmm
}

function emit(tag, ...parts) {
  console.log(`[${ts()}] ${tag} ${parts.map(p => typeof p === 'string' ? p : safeStringify(p)).join(' ')}`)
}

// ─── Chat ────────────────────────────────────────────────────────────────
export function logChatIn(username, message) {
  emit('[chat<-]', `${username}: ${trunc(message)}`)
}
export function logChatOut(text) {
  emit('[chat->]', trunc(text))
}

// ─── Personality LLM (Anthropic / Haiku) ─────────────────────────────────
export function logHaikuQuery({ messages, tools }) {
  const userMsg = messages?.[messages.length - 1]?.content
  emit('[haiku?]', `tools=${(tools ?? []).map(t => t.name).join(',')} user=${trunc(userMsg)}`)
}
export function logHaikuResponse({ text, toolUses, usage, stopReason }) {
  const calls = (toolUses ?? []).map(u => `${u.name}(${trunc(safeStringify(u.input))})`).join(' | ')
  emit('[haiku!]', `stop=${stopReason} text=${trunc(text || '')} calls=${calls || '(none)'} usage=${safeStringify(usage)}`)
}

// ─── Position healer ─────────────────────────────────────────────────────
export function logHeal({ pos, vel, yaw, pitch }) {
  emit('[heal]', `pos=${pos} vel=${vel} yaw=${yaw} pitch=${pitch}`)
}

// ─── Action results (echo for visibility) ────────────────────────────────
export function logActionResult(name, result) {
  emit('[act!]', `${name} → ${trunc(typeof result === 'string' ? result : safeStringify(result))}`)
}
