// Small helpers for action error strings — keep adapter-side reasons compact
// and free of stack traces so the LLM gets useful signal without context blow.

export function firstLine(s) {
  if (s == null) return ''
  return String(s).split('\n')[0].trim()
}

export function truncate(s, max = 80) {
  const str = String(s ?? '')
  return str.length <= max ? str : str.slice(0, max - 1) + '…'
}

/**
 * Format an underlying adapter/runtime error into a single short line.
 *
 * NOTE: Do NOT post-decorate the result with held-item / inventory
 * context inside action wrappers. Haiku reads decoration as causal
 * ("with stick" → "stick is wrong tool"). If an action can fail for
 * multiple distinct reasons, branch on the reason and emit a
 * self-contained message that names the actual root cause (no block,
 * unbreakable, out of range, ...). (260505-twx)
 */
export function reason(err) {
  return truncate(firstLine(err?.message ?? err), 80)
}

/**
 * One-line, model-readable rendering of an error for tool results. ZodErrors
 * (schema validation on tool args) render as `field: message` pairs — the raw
 * `.message` on a ZodError is the multi-line JSON issue dump, which the model
 * was previously shown verbatim (260709: craft count 92 produced a 12-line
 * JSON blob where "count: Number must be less than or equal to 64" says it
 * all). Non-Zod errors fall back to the first line of the message.
 */
export function errLine(err) {
  const issues = err?.issues ?? err?.errors
  if (Array.isArray(issues) && issues.length && issues.every(i => i && typeof i.message === 'string')) {
    return issues
      .map(i => (Array.isArray(i.path) && i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ')
  }
  return firstLine(err?.message ?? err) || 'unknown'
}
