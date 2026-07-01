// src/behaviors/readSign.js — read a sign's text, bounded + sanitized
// (MCRAFT-04, D-09; threat T-17-07).
//
// SECURITY: block.getSignText() is fully server-controlled untrusted content
// that would otherwise flow snapshot → LLM prompt (prompt-injection + context
// bloat). We sanitize BEFORE returning: strip Minecraft §-color sequences,
// strip ASCII control chars (incl. newlines), collapse whitespace, and CAP the
// result to MAX_SIGN_CHARS. This bounds the injection + oversized-content
// surface at the source. Read-only: no world mutation.
import { resolveBlock, isStaleHandle } from '../observers/targeting.js'

export const MAX_SIGN_CHARS = 200

function sanitizeSignText(raw) {
  if (raw == null) return ''
  let s = String(raw)
  // Strip Minecraft section-code color/format sequences (§ + 1 char).
  s = s.replace(/\u00A7./g, '')
  // Strip ASCII control chars (NUL..US + DEL), including newlines/tabs.
  s = s.replace(/[\x00-\x1F\x7F]+/g, ' ')
  // Collapse whitespace runs and trim.
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > MAX_SIGN_CHARS) s = s.slice(0, MAX_SIGN_CHARS)
  return s
}

export async function readSignAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const target = await resolveBlock(args, bot)
  if (!target) return isStaleHandle(args) ? 'stale target' : 'no sign there'

  // Must be a sign block exposing a text accessor; otherwise nothing to read.
  const name = target.name ?? ''
  const hasAccessor = typeof target.getSignText === 'function' || target.signText != null
  if (!name.includes('sign') && !hasAccessor) return 'no sign there'

  let faces = []
  try {
    if (typeof target.getSignText === 'function') {
      const res = target.getSignText()
      faces = Array.isArray(res) ? res : [res]
    } else if (target.signText != null) {
      faces = [target.signText]
    }
  } catch {
    return 'no sign there'
  }

  // Sanitize each face, drop blanks, join, then cap the joined result too so
  // the returned text never exceeds MAX_SIGN_CHARS regardless of face count.
  let text = faces.map(sanitizeSignText).filter(Boolean).join(' / ')
  if (!text) return 'sign is blank'
  if (text.length > MAX_SIGN_CHARS) text = text.slice(0, MAX_SIGN_CHARS)
  return `sign: "${text}"`
}
