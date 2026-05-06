/**
 * Conversation memory for Sei (260505-iqo).
 *
 * Two structures:
 *   recentChat   — split owner/self sub-buffers, capacity 10 each, 240-char per-line
 *                  truncation. Renders into TWO seed blocks so the model sees
 *                  what the owner said separately from what it itself said.
 *   loopHistory  — ring of completed-loop summaries (capacity 10). Each entry
 *                  carries a 1-line title synthesized from the loop's first
 *                  say() output + most-frequent tool name (no extra API call,
 *                  no doubling of end-of-loop cost). Used for cross-loop
 *                  continuity in the seed turn.
 *
 * Why split owner/self: the prior single-buffer mixed both directions,
 * which trained the model to treat its OWN prior lines as conversational
 * input from the player. Splitting lets us prompt-engineer self-lines
 * with an explicit "do not repeat" guard.
 *
 * Why loopHistory exists: every Loop is composed cold from seed_owner +
 * seed_diary + event + snapshot. Without an explicit timeline of what
 * happened in recent loops, the bot keeps re-asking questions it already
 * asked five minutes ago and rediscovering tasks it just finished.
 */

const RECENT_CHAT_CAPACITY = 10
const RECENT_CHAT_LINE_TRUNC = 240
// Plan 03.1-03 (RESEARCH Trim 4): cap reduced 20 → 10. The snapshot already
// shows recent_events deltas; per D-M-6 the loopHistory crowded out diary
// content. Saves ~75 tokens per Loop without losing cross-loop continuity.
const LOOP_HISTORY_CAPACITY = 10
const LOOP_TITLE_BASE_TRUNC = 80

function pushRing(arr, item, cap) {
  arr.push(item)
  while (arr.length > cap) arr.shift()
}

function fmtAgo(now, at) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return `${h}h ago`
}

export function createConvoMemory() {
  /** @type {{ at:number, who:string, text:string }[]} */
  const ownerLines = []
  /** @type {{ at:number, who:string, text:string }[]} */
  const selfLines = []
  /** @type {{ loopId:string, startedAt:number, endedAt:number, event:string, title:string, mutations:string }[]} */
  const loopHistory = []

  function pushOwner(who, text) {
    if (!text) return
    const line = String(text).trim()
    if (!line) return
    pushRing(ownerLines, { at: Date.now(), who: String(who || '?'), text: line.slice(0, RECENT_CHAT_LINE_TRUNC) }, RECENT_CHAT_CAPACITY)
  }

  function pushSelf(who, text) {
    if (!text) return
    const line = String(text).trim()
    if (!line) return
    pushRing(selfLines, { at: Date.now(), who: String(who || 'sei'), text: line.slice(0, RECENT_CHAT_LINE_TRUNC) }, RECENT_CHAT_CAPACITY)
  }

  function formatOwnerBlock() {
    if (ownerLines.length === 0) return null
    const now = Date.now()
    const body = ownerLines.map(({ at, who, text }) => `[${fmtAgo(now, at)}] ${who}: ${text}`).join('\n')
    return `Recent owner messages, oldest first:\n${body}`
  }

  function formatSelfBlock() {
    if (selfLines.length === 0) return null
    const now = Date.now()
    const body = selfLines.map(({ at, text }) => `[${fmtAgo(now, at)}] you: ${text}`).join('\n')
    return `Things you (Sei) said recently. Do NOT repeat — if your next message would substantially duplicate one of these, say something different or stay silent.\n${body}`
  }

  /**
   * Synthesize a title from a completed Loop's messages — no extra API call.
   * Strategy: first say() line truncated to ~80 chars + most-frequent
   * non-personality tool name as a tag. If neither exists, fall back to event.
   */
  function synthesizeTitle(loopMessages, originatingEvent) {
    let firstSay = null
    const toolFreq = new Map()
    for (const msg of loopMessages || []) {
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
      for (const blk of msg.content) {
        if (!blk || blk.type !== 'tool_use') continue
        if (blk.name === 'say') {
          if (!firstSay) firstSay = String(blk.input?.text ?? '').trim()
        } else if (blk.name !== 'setGoals') {
          toolFreq.set(blk.name, (toolFreq.get(blk.name) || 0) + 1)
        }
      }
    }
    let topTool = null
    let topCount = 0
    for (const [name, count] of toolFreq) {
      if (count > topCount) { topTool = name; topCount = count }
    }
    const sayPart = firstSay ? firstSay.slice(0, LOOP_TITLE_BASE_TRUNC) : ''
    const toolPart = topTool ? `[${topTool}×${topCount}]` : ''
    if (sayPart && toolPart) return `${sayPart} ${toolPart}`
    if (sayPart) return sayPart
    if (toolPart) return `${originatingEvent || 'loop'} ${toolPart}`
    return `${originatingEvent || 'loop'} (no output)`
  }

  /**
   * Synthesize a 1-line mutation summary from snapshot deltas captured during
   * the loop. The snapshot's `recent_events:` line carries inventory/kill/hp
   * deltas — we scan tool_result text blocks (which carry the snapshot text)
   * for the latest one and extract that line. Best-effort; empty string OK.
   */
  function synthesizeMutations(loopMessages) {
    let latest = ''
    for (const msg of loopMessages || []) {
      if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue
      for (const blk of msg.content) {
        if (!blk || blk.type !== 'text' || blk.name !== 'snapshot' || typeof blk.text !== 'string') continue
        const m = blk.text.match(/recent_events:\s*([^\n]+)/)
        if (m && m[1]) latest = m[1].trim()
      }
    }
    return latest
  }

  /**
   * Push a completed-loop summary. Called from orchestrator's handleDispatch
   * finally block at loop terminal.
   */
  function pushLoop({ loopId, startedAt, endedAt, event, loopMessages }) {
    const title = synthesizeTitle(loopMessages, event)
    const mutations = synthesizeMutations(loopMessages)
    pushRing(loopHistory, { loopId, startedAt, endedAt, event, title, mutations }, LOOP_HISTORY_CAPACITY)
  }

  function formatLoopHistoryBlock() {
    if (loopHistory.length === 0) return null
    const now = Date.now()
    const body = loopHistory.map(({ endedAt, event, title, mutations }) => {
      const ago = fmtAgo(now, endedAt)
      const mu = mutations ? ` — ${mutations}` : ''
      return `[${ago}] (${event}) ${title}${mu}`
    }).join('\n')
    return `Your recent activity timeline (loop-by-loop, oldest first):\n${body}`
  }

  return {
    recentChat: {
      pushOwner,
      pushSelf,
      formatOwnerBlock,
      formatSelfBlock,
      get ownerSize() { return ownerLines.length },
      get selfSize() { return selfLines.length },
      _internal: { ownerLines, selfLines },
    },
    loopHistory: {
      push: pushLoop,
      formatBlock: formatLoopHistoryBlock,
      get size() { return loopHistory.length },
      _internal: { entries: loopHistory },
    },
  }
}
