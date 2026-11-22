/**
 * Loop â€” owns the canonical `messages` array for one Sei active task cycle
 * Public API is locked:
 *
 *   appendUserTurn(blocks, { seed })
 *   appendAssistant(content)
 *   appendToolResults(results, { snapshot, eventText })
 *   demoteOlderImages()        -> replace stale image blocks with a text stub (image cap)
 *   supersedeSeedConversation() -> drop the seed's conversation + own-lines note from payloads
 *   buildAnthropicPayload()    -> SDK-safe array (no `name` field on text blocks)
 *   iterationCount             -> number of user turns (seed counts as 0)
 *   abortController            -> shared signal for the entire loop
 *   byteSize()                 -> JSON.stringify(messages).length, for sanity caps
 *   _internal: { messages }    -> harness seam (mirrors src/llm/chains.js)
 *
 * Trim algorithm (D-43, rebuild-on-call):
 *   â€¢ `messages` stays canonical and is NEVER mutated by buildAnthropicPayload.
 *   â€¢ The output payload clones every user turn; for each text block:
 *       - drop the `name` field (Anthropic SDK schema has no `name` on text
 *         blocks â€” Pitfall 1)
 *       - if `name === 'snapshot'` AND this turn is NOT the last user turn, skip it
 *       - seed turns keep `seed_player` text blocks across the
 *         entire loop (D-45); the seed turn's snapshot block is still subject
 *         to the "strip if not last" rule.
 *       - once supersedeSeedConversation() ran, the seed's
 *         `recent_conversation` and `own_repeats` blocks are skipped too.
 *   â€¢ Tool_result blocks pass through unchanged.
 *   â€¢ Assistant turns pass through unchanged (their tool_use blocks are SDK-shaped).
 *
 * Pairing invariant (D-44, Pitfall 3): appendToolResults asserts that the
 * count and ids of `tool_use` blocks in the prior assistant turn match the
 * supplied results 1:1. Mismatched ids throw.
 *
 * Closure-private state â€” mirrors src/llm/inflight.js + src/llm/chains.js.
 */

let _loopId = 1

// The seed blocks a mid-loop conversation replaces (supersedeSeedConversation).
const SEED_SUPERSEDED_BLOCKS = new Set(['recent_conversation', 'own_repeats'])

/**
 * @param {object} opts
 * @param {number} opts.iterationCap
 * @param {{warn:Function,info?:Function,error?:Function,debug?:Function}} [opts.logger]
 */
export function createLoop({ iterationCap, logger = console, speakReminder = null } = {}) {
  // 0 = unlimited (no cap); the orchestrator's runIterations skips the check
  // when cap <= 0. Reject only missing / negative / non-integer values.
  if (iterationCap == null || !Number.isInteger(iterationCap) || iterationCap < 0) {
    throw new Error('createLoop requires iterationCap >= 0 (0 = unlimited)')
  }
  // 260619: the say() reminder used to ride only on the SEED turn, so every
  // mid-loop continuation turn (a long gather/dig/craft chain) carried no say()
  // contract at all â€” the model kept acting and dumped any speech into its
  // private text, which is never sent (the "Sui silent through a whole build"
  // bug). When set, appendToolResults restates it as the last block of every
  // continuation turn so the contract is present on EVERY turn, not just the seed.

  /** @type {Array<{role:'user'|'assistant', content:any[], seed?:boolean}>} */
  const messages = []
  let iterationCount = 0
  const startedAt = Date.now()
  // Mutable so the orchestrator's
  // replaceAbortController can swap in a fresh instance via
  // _setAbortController without resorting to Object.defineProperty
  // on the returned getter. The loop's abortController getter still
  // returns the active reference; consumers re-read on each access.
  let abortController = new AbortController()
  const id = `loop-${_loopId++}-${startedAt.toString(36)}`
  // 261118 (pass 58): set once a later turn of this loop carries its own copy
  // of the conversation (a player line that landed mid-loop). From then on
  // the seed turn's conversation and own-lines note are left out of the
  // payload, so the turn shows her recent lines once, not twice over. A bit
  // she just made ("you still owe me a wood run") was reused in 84% of
  // mid-loop "thanks" replies with both copies and 56% with only the newest
  // (pass58-probe thanks_owe), the same as a fresh loop.
  let seedConversationSuperseded = false

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
      // Last block = highest recency, read right before the model responds.
      ...(speakReminder ? [{ type: 'text', name: 'speak_reminder', text: speakReminder }] : []),
    ]
    appendUserTurn(content, { seed: false })
  }

  /**
   * Image retention cap: replace every image block currently in history with a
   * short text placeholder. Called by the orchestrator right BEFORE it appends
   * a fresh frame, so the canonical history never holds more than one image â€”
   * bounding both byteSize() and the per-call payload (each 256px frame is
   * ~7KB base64 / ~90 input tokens that would otherwise be re-sent on EVERY
   * subsequent iteration of the loop). This is a deliberate exception to the
   * "canonical is append-only" posture: the newest view supersedes older ones
   * the way the newest snapshot supersedes older snapshots (D-43) â€” but unlike
   * the snapshot rule it must shrink the CANONICAL array, not just the payload,
   * or long follow-loops accumulate dead base64 in memory.
   */
  function demoteOlderImages() {
    for (const turn of messages) {
      if (turn.role !== 'user') continue
      for (let i = 0; i < turn.content.length; i++) {
        const blk = turn.content[i]
        if (blk && blk.type === 'image') {
          turn.content[i] = { type: 'text', text: '[a picture was shown here on an earlier turn; it has been removed and is no longer visible to you]' }
        }
      }
    }
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
      // User turn â€” rebuild content with trim rules
      const newContent = []
      for (const blk of turn.content) {
        if (!blk || typeof blk !== 'object') continue
        if (blk.type === 'tool_result') {
          newContent.push({ ...blk })
          continue
        }
        if (blk.type === 'text') {
          const isSnapshot = blk.name === 'snapshot'
          // Snapshot stripped from any non-last user turn (applies to seed too â€” D-45).
          if (isSnapshot && i !== lastUserIdx) continue
          if (turn.seed && seedConversationSuperseded && SEED_SUPERSEDED_BLOCKS.has(blk.name)) continue
          // Strip the `name` field â€” Anthropic SDK schema has no `name` on text blocks.
          const { name: _omit, ...rest } = blk
          newContent.push({ ...rest })
          continue
        }
        // Unknown block type â€” pass through deep-cloned.
        newContent.push({ ...blk })
      }
      out.push({ role: 'user', content: newContent })
    }
    return out
  }

  /** A later turn carries the conversation, so the seed's copy is stale. */
  function supersedeSeedConversation() {
    seedConversationSuperseded = true
  }

  function byteSize() {
    return JSON.stringify(messages).length
  }

  return {
    appendUserTurn,
    appendAssistant,
    appendToolResults,
    demoteOlderImages,
    supersedeSeedConversation,
    buildAnthropicPayload,
    byteSize,
    get iterationCount() { return iterationCount },
    get startedAt() { return startedAt },
    get abortController() { return abortController },
    // Expose a setter so the orchestrator's replaceAbortController can swap
    // controllers cleanly. Validates the
    // argument shape â€” must look like an AbortController.
    _setAbortController(c) {
      if (!c || typeof c.abort !== 'function' || !c.signal) {
        throw new Error('_setAbortController: AbortController-shaped instance required')
      }
      abortController = c
    },
    get id() { return id },
    _internal: { messages },
  }
}




