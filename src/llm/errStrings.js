// Small helpers for action error strings — keep mineflayer reasons compact
// and free of stack traces so the LLM gets useful signal without context blow.

export function firstLine(s) {
  if (s == null) return ''
  return String(s).split('\n')[0].trim()
}

export function truncate(s, max = 80) {
  const str = String(s ?? '')
  return str.length <= max ? str : str.slice(0, max - 1) + '…'
}

/** Format an underlying mineflayer error into a single short line. */
export function reason(err) {
  return truncate(firstLine(err?.message ?? err), 80)
}
