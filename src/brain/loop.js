/**
 * Loop — owns the canonical `messages` array for one Sei active task cycle
 * (Phase 3 D-38 / D-42 / D-43 / D-44 / D-45). Public API is locked at D-44:
 *
 *   appendUserTurn(blocks, { seed })
 *   appendAssistant(content)
 *   appendToolResults(results, { snapshot, eventText })
 *   buildAnthropicPayload()    -> SDK-safe array (no `name` field on text blocks)
 *   iterationCount             -> number of user turns (seed counts as 0)
 *   abortController            -> shared signal for the entire loop
 *   byteSize()                 -> JSON.stringify(messages).length, for sanity caps
 *   _internal: { messages }    -> harness seam (mirrors src/llm/chains.js)
 *
 * Trim algorithm (D-43, rebuild-on-call):
 *   • `messages` stays canonical and is NEVER mutated by buildAnthropicPayload.
 *   • The output payload clones every user turn; for each text block:
 *       - drop the `name` field (Anthropic SDK schema has no `name` on text
 *         blocks — Pitfall 1)
 *       - if `name === 'snapshot'` AND this turn is NOT the last user turn, skip it
 *       - seed turns keep `seed_owner` / `seed_diary` text blocks across the
 *         entire loop (D-45); the seed turn's snapshot block is still subject
 *         to the "strip if not last" rule.
 *   • Tool_result blocks pass through unchanged.
 *   • Assistant turns pass through unchanged (their tool_use blocks are SDK-shaped).
 *
 * Pairing invariant (D-44, Pitfall 3): appendToolResults asserts that the
 * count and ids of `tool_use` blocks in the prior assistant turn match the
 * supplied results 1:1. Mismatched ids throw.
 *
 * Closure-private state — mirrors src/llm/inflight.js + src/llm/chains.js.
 */

let _loopId = 1

/**
 * @param {object} opts
 * @param {number} opts.iterationCap
 * @param {{warn:Function,info?:Function,error?:Function,debug?:Function}} [opts.logger]
 */
export function createLoop({ iterationCap, logger = console } = {}) {
  if (!iterationCap || iterationCap < 1) {
    throw new Error('createLoop requires iterationCap >= 1')
  }

  /** @type {Array<{role:'user'|'assistant', content:any[], seed?:boolean}>} */
  const messages = []
  let iterationCount = 0
  const startedAt = Date.now()
  const abortController = new AbortController()
  const id = `loop-${_loopId++}-${startedAt.toString(36)}`

  function appendUserTurn(blocks, { seed = false } = {}) {
    if (!Array.isArray(blocks)) throw new Error('appendUserTurn: blocks must be an array')
    const turn = { role: 'user', content: blocks.slice(), seed: !!seed }
    messages.push(turn)
    // Per D-44: iteration count tracks user turns; seed counts as 0 (the seed
    // turn establishes the starting state, the first NON-seed user turn is
    // iteration 1). For non-seed Loops (which is the common case once Plan
    // 3-02 is not yet wired) the very first user turn IS iteration 1.
    if (!seed) iterationCount += 1
  }

  function appendAssistant(content) {
    if (!Array.isArray(content)) throw new Error('appendAssistant: content must be an array')
    messages.push({ role: 'assistant', content: content.slice() })
  }

  function appendToolResults(results, { snapshot, eventText } = {}) {
    if (!Array.isArray(results)) throw new Error('appendToolResults: results must be an array')
    // Pairing invariant (D-44, Pitfall 3)
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistant) {
      throw new Error('appendToolResults: no prior assistant turn to pair against')
    }
    const toolUses = lastAssistant.content.filter(b => b && b.type === 'tool_use')
    if (toolUses.length !== results.length) {
      throw new Error(
        `appendToolResults: expected ${toolUses.length} results to pair with prior tool_uses, got ${results.length}`
      )
    }
    const expectedIds = new Set(toolUses.map(u => u.id))
    for (const r of results) {
      if (!r || r.type !== 'tool_result') {
        throw new Error('appendToolResults: every result must have type:"tool_result"')
      }
      if (!expectedIds.has(r.tool_use_id)) {
        throw new Error(`appendToolResults: tool_use_id ${r.tool_use_id} does not match any prior tool_use`)
      }
    }
    const content = [
      ...results,
      ...(eventText ? [{ type: 'text', name: 'event', text: eventText }] : []),
      ...(snapshot ? [{ type: 'text', name: 'snapshot', text: snapshot }] : []),
    ]
    appendUserTurn(content, { seed: false })
  }

  function buildAnthropicPayload() {
    // Find the index of the last user turn (snapshot stays only on this one).
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break }
    }

    const out = []
    for (let i = 0; i < messages.length; i++) {
      const turn = messages[i]
      if (turn.role === 'assistant') {
        // Pass through; deep-clone to keep canonical safe.
        out.push({ role: 'assistant', content: turn.content.map(b => ({ ...b })) })
        continue
      }
      // User turn — rebuild content with trim rules
      const newContent = []
      for (const blk of turn.content) {
        if (!blk || typeof blk !== 'object') continue
        if (blk.type === 'tool_result') {
          newContent.push({ ...blk })
          continue
        }
        if (blk.type === 'text') {
          const isSnapshot = blk.name === 'snapshot'
          // Snapshot stripped from any non-last user turn (applies to seed too — D-45).
          if (isSnapshot && i !== lastUserIdx) continue
          // Strip the `name` field — Anthropic SDK schema has no `name` on text blocks.
          const { name: _omit, ...rest } = blk
          newContent.push({ ...rest })
          continue
        }
        // Unknown block type — pass through deep-cloned.
        newContent.push({ ...blk })
      }
      out.push({ role: 'user', content: newContent })
    }
    return out
  }

  function byteSize() {
    return JSON.stringify(messages).length
  }

  return {
    appendUserTurn,
    appendAssistant,
    appendToolResults,
    buildAnthropicPayload,
    byteSize,
    get iterationCount() { return iterationCount },
    get startedAt() { return startedAt },
    get abortController() { return abortController },
    get id() { return id },
    _internal: { messages },
  }
}
