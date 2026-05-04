/**
 * Recent-chat ring buffer.
 *
 * Each Loop is composed cold (D-39 single-flight): the LLM sees diary,
 * owner, snapshot, and the current event but NOT the prior loop's chat
 * exchange. That makes short replies like "yes" / "do it" ambiguous —
 * the model has to guess what was being agreed to.
 *
 * This buffer holds the last N chat lines (owner + bot) and exposes a
 * formatted block that orchestrator injects into the seed user turn as a
 * dynamic (uncached) block alongside `event` and `snapshot`.
 */
export function createChatRingBuffer({ capacity = 10 } = {}) {
  /** @type {{ at:number, who:string, text:string }[]} */
  const buf = []

  function push(who, text) {
    if (!text) return
    const line = String(text).trim()
    if (!line) return
    buf.push({ at: Date.now(), who: String(who || '?'), text: line.slice(0, 240) })
    while (buf.length > capacity) buf.shift()
  }

  function format() {
    if (buf.length === 0) return '(no recent chat)'
    const now = Date.now()
    return buf.map(({ at, who, text }) => {
      const ago = Math.max(0, Math.round((now - at) / 1000))
      return `[${ago}s ago] ${who}: ${text}`
    }).join('\n')
  }

  function clear() { buf.length = 0 }

  return { push, format, clear, get size() { return buf.length } }
}
