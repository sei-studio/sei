// 261013: prompt-size guard for every Anthropic Messages request the app builds.
//
// Two jobs, and only the second one ever changes a request:
//
//   1. LOG the long-prompt price tier. claude-haiku-5-5 bills $0.10 in /
//      $0.50 out per MTok while the prompt is at most 100,000 tokens, and
//      $0.50 / $2.50 for EVERY token of the request once the prompt passes it
//      (prompt = uncached input + cache writes + cache reads). Product call
//      (261013): pay the 5x rather than cut what the model sees, so a request
//      over the tier is sent untouched and only logged here (the proxy also
//      logs and counts the billed ones).
//   2. A SAFETY NET just under the model's hard context limit (the Models API
//      max_input_tokens: 1,000,000 for Haiku 5.5 / Sonnet 5 / Opus 5, 200,000
//      for Haiku 4.5). Past the limit the API answers 400 and the turn is lost
//      outright, so at CONTEXT_SAFETY_FRACTION (90%) of it the oldest whole
//      turns are dropped. Measured prompts are 3-40k (docs/haiku55-game-sim,
//      the quality-eval logs, the 260924-261012 live sessions), so a normal
//      session is twenty times below this and never touched.
//
// Applied at every place the app builds an Anthropic Messages request, next
// to applyAnthropicModelDefaults: the bot's anthropicClient.call (game brains,
// in-game voice), main's llm/anthropic.ts provider (chat, voice, chess, Draw!,
// backseat, folds, every other main-side call) and the dev-only
// computerUse/directAnthropic.ts. Main imports this file directly (plain ESM,
// no Electron), like anthropicModelDefaults.js.
//
// The estimate needs no network call (count_tokens is not routed through the
// cloud proxy and would add a round trip to every turn). It was calibrated
// against count_tokens on claude-haiku-5-5 (261013) and over-counts on
// purpose: English prose by about 10%, JSON and tool schemas by 25-30%,
// Japanese by about 40%, Korean by about 5%. Images follow the measured 5.5
// rule (long edge scaled to 2560, about 3.7 MP, at most ~4,790 tokens).
//
// The safety net, when it does fire: the system prompt, tools, any pinned
// leading messages (the bot's seed turn) and the latest turn are never
// dropped; cuts land only where tool_use / tool_result pairing stays valid,
// and a short note tells the model earlier turns were cut. Still over: images
// outside the latest message become a text stub, then oversized tool_result
// text is shortened, oldest first. Player text is never cut. Still over: the
// request is sent as is and the log says so.
//
// Prompt-cache stability: the amount dropped is rounded UP to a multiple of
// the quantum (10% of the limit), measured from the start of the droppable
// region. History is append-only, so the cut stays on the same message until
// the thread has grown by another quantum, instead of moving one turn per
// call and cache-missing the whole thread every time. The function is pure
// (no per-conversation state), so every surface behaves the same.

/** Haiku 5.x prompt-length price tier (tokens). */
export const LONG_PROMPT_TIER_TOKENS = 100_000

/** Share of the model's hard input limit the safety net trims to. */
export const CONTEXT_SAFETY_FRACTION = 0.9

/** Share of the model's hard input limit dropped per step (cache stability). */
export const TRIM_QUANTUM_FRACTION = 0.1

/** Text the model sees where earlier turns were cut. Constant on purpose (cache). */
export const TRIM_NOTE = '[Earlier turns of this conversation were removed to keep the context short. Continue from what is below.]'
export const IMAGE_STUB = '[an image was here; it was removed to keep the context short]'
const RESULT_CUT_NOTE = '\n[... the rest of this result was cut to keep the context short]'

/**
 * The long-prompt tier threshold for a model, or null when the model has no
 * prompt-length tier. Only Haiku 5.x today (claude-haiku-5-5 and its dated
 * snapshots).
 * @param {unknown} model
 * @returns {number|null}
 */
export function longPromptTierFor(model) {
  return typeof model === 'string' && /^claude-haiku-5(?:[-.]|$)/.test(model) ? LONG_PROMPT_TIER_TOKENS : null
}

/**
 * Hard input-token limit for a model (Models API max_input_tokens, read
 * 261013), or null when unknown (no safety net for it).
 * @param {unknown} model
 * @returns {number|null}
 */
export function contextLimitFor(model) {
  if (typeof model !== 'string') return null
  if (/^claude-(?:haiku|sonnet|opus)-5(?:[-.]|$)/.test(model)) return 1_000_000
  if (/^claude-haiku-4-5(?:[-.]|$)/.test(model)) return 200_000
  return null
}

// ── Estimation ──────────────────────────────────────────────────────────────

const TOKEN_RE = /[A-Za-z]+|[0-9]+|\s+|[\x00-\x7f]|[^\x00-\x7f]/g

/**
 * Conservative token estimate for a string on the Haiku 5.5 tokenizer.
 * Letter runs count one token per 3.5 letters (rounded up per word), digit
 * runs one per 3 digits, ASCII punctuation one each, whitespace free, and
 * every non-ASCII UTF-16 unit 1.4 (CJK and Hangul run about 1-1.4 per char).
 * @param {unknown} s
 * @returns {number}
 */
export function estimateTextTokens(s) {
  if (typeof s !== 'string' || s.length === 0) return 0
  let t = 0
  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(s)) !== null) {
    const x = m[0]
    const c = x.charCodeAt(0)
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) t += Math.ceil(x.length / 3.5)
    else if (c >= 48 && c <= 57) t += Math.ceil(x.length / 3)
    else if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) continue
    else if (c < 128) t += 1
    else t += 1.4
  }
  return Math.ceil(t)
}

/** Measured on claude-haiku-5-5 (261013): pixels/750 after the resize, capped. */
const IMAGE_MAX_TOKENS = 4_800
const IMAGE_MAX_EDGE = 2_560
const IMAGE_MAX_PIXELS = 2_560 * 1_440

/**
 * Read width/height from the first bytes of a base64 image (PNG, JPEG, GIF,
 * WebP). Returns null when the header is not recognized.
 * @param {string} b64
 * @returns {{w:number,h:number}|null}
 */
export function imageDimsFromBase64(b64) {
  if (typeof b64 !== 'string' || b64.length < 40) return null
  let buf
  try {
    // 64 KB of base64 covers a JPEG's EXIF block in practice; decode only that.
    const head = b64.slice(0, 65_536)
    buf = Buffer.from(head.slice(0, head.length - (head.length % 4)), 'base64')
  } catch { return null }
  const u8 = (i) => buf[i]
  const be16 = (i) => (buf[i] << 8) | buf[i + 1]
  const be32 = (i) => ((buf[i] << 24) >>> 0) + (buf[i + 1] << 16) + (buf[i + 2] << 8) + buf[i + 3]
  const le16 = (i) => buf[i] | (buf[i + 1] << 8)
  const le24 = (i) => buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16)
  if (buf.length >= 24 && u8(0) === 0x89 && u8(1) === 0x50 && u8(2) === 0x4e && u8(3) === 0x47) {
    return { w: be32(16), h: be32(20) }
  }
  if (buf.length >= 10 && u8(0) === 0x47 && u8(1) === 0x49 && u8(2) === 0x46) {
    return { w: le16(6), h: le16(8) }
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { w: le24(24) + 1, h: le24(27) + 1 }
    if (kind === 'VP8 ' && buf.length >= 30) return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff }
    if (kind === 'VP8L' && buf.length >= 25) {
      const b0 = u8(21), b1 = u8(22), b2 = u8(23), b3 = u8(24)
      return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }
    }
    return null
  }
  if (buf.length >= 4 && u8(0) === 0xff && u8(1) === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (u8(i) !== 0xff) { i++; continue }
      const marker = u8(i + 1)
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = be16(i + 2)
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: be16(i + 7), h: be16(i + 5) }
      }
      i += 2 + len
    }
  }
  return null
}

/**
 * Token estimate for one image block. Unknown size or a URL source counts as
 * the per-image maximum.
 * @param {any} block
 * @returns {number}
 */
export function estimateImageTokens(block) {
  const src = block?.source
  const dims = src?.type === 'base64' ? imageDimsFromBase64(src.data) : null
  if (!dims || !(dims.w > 0) || !(dims.h > 0)) return IMAGE_MAX_TOKENS
  let { w, h } = dims
  const edge = Math.max(w, h)
  if (edge > IMAGE_MAX_EDGE) { const k = IMAGE_MAX_EDGE / edge; w *= k; h *= k }
  if (w * h > IMAGE_MAX_PIXELS) { const k = Math.sqrt(IMAGE_MAX_PIXELS / (w * h)); w *= k; h *= k }
  return Math.min(IMAGE_MAX_TOKENS, Math.ceil((w * h) / 750) + 20)
}

/**
 * @param {any} block
 * @returns {number}
 */
export function estimateBlockTokens(block) {
  if (typeof block === 'string') return estimateTextTokens(block)
  if (!block || typeof block !== 'object') return 0
  const BLOCK_OVERHEAD = 3
  switch (block.type) {
    case 'text':
      return BLOCK_OVERHEAD + estimateTextTokens(block.text)
    case 'image':
      return estimateImageTokens(block)
    case 'tool_use':
    case 'server_tool_use':
      return BLOCK_OVERHEAD + 10 + estimateTextTokens(block.name) + estimateTextTokens(safeJson(block.input))
    case 'tool_result': {
      const c = block.content
      if (typeof c === 'string') return BLOCK_OVERHEAD + 10 + estimateTextTokens(c)
      if (Array.isArray(c)) return BLOCK_OVERHEAD + 10 + c.reduce((n, b) => n + estimateBlockTokens(b), 0)
      return BLOCK_OVERHEAD + 10
    }
    case 'thinking':
      return BLOCK_OVERHEAD + estimateTextTokens(block.thinking)
    case 'redacted_thinking':
      return BLOCK_OVERHEAD + estimateTextTokens(block.data)
    case 'document': {
      const src = block.source
      if (src?.type === 'base64' && typeof src.data === 'string') {
        // A base64 PDF: no cheap page count, so count the decoded bytes / 3.
        return BLOCK_OVERHEAD + Math.ceil((src.data.length * 0.75) / 3)
      }
      if (src?.type === 'text') return BLOCK_OVERHEAD + estimateTextTokens(src.data)
      return BLOCK_OVERHEAD + estimateTextTokens(safeJson(block))
    }
    default:
      // web_search_tool_result and anything newer: count the serialized block
      // (encrypted_content included; it is billed as input on later turns).
      return BLOCK_OVERHEAD + estimateTextTokens(safeJson(block))
  }
}

/**
 * @param {{role?:string, content:any}} msg
 * @returns {number}
 */
export function estimateMessageTokens(msg) {
  if (!msg) return 0
  const c = msg.content
  const body = typeof c === 'string' ? estimateTextTokens(c)
    : Array.isArray(c) ? c.reduce((n, b) => n + estimateBlockTokens(b), 0)
    : 0
  return 4 + body
}

function estimateSystemTokens(system) {
  if (typeof system === 'string') return estimateTextTokens(system)
  if (Array.isArray(system)) return system.reduce((n, b) => n + estimateBlockTokens(b), 0)
  return 0
}

function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0
  // ~330 tokens of tool-use preamble once tools are present (measured).
  let n = 350
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    // Server tools are schema-less but carry their own system text
    // (web_search measured at ~2,800 tokens).
    if (typeof t.type === 'string' && t.type.startsWith('web_search')) { n += 3_000; continue }
    if (typeof t.type === 'string' && !t.input_schema) { n += 1_000; continue }
    n += estimateTextTokens(safeJson({ name: t.name, description: t.description, input_schema: t.input_schema }))
  }
  return n
}

/**
 * Estimated prompt tokens (everything billed as input) for a Messages body.
 * @param {{system?:any, tools?:any[], messages?:any[]}} req
 * @returns {number}
 */
export function estimateRequestTokens(req) {
  const msgs = Array.isArray(req?.messages) ? req.messages : []
  return 10 + estimateSystemTokens(req?.system) + estimateToolsTokens(req?.tools)
    + msgs.reduce((n, m) => n + estimateMessageTokens(m), 0)
}

function safeJson(v) {
  try { return JSON.stringify(v) ?? '' } catch { return '' }
}

// ── Trimming ────────────────────────────────────────────────────────────────

function hasToolResult(msg) {
  return Array.isArray(msg?.content) && msg.content.some(b => b && b.type === 'tool_result')
}

/**
 * Indices c where messages[c..] may start the kept region after `pin` pinned
 * messages. Roles must keep alternating across the seam (the turn after the
 * last pinned one has the other role; with nothing pinned the region opens on
 * a user turn), and a user turn may open it only if it holds no tool_result,
 * whose tool_use would have been dropped. `last` is the first index that can
 * never be dropped (the latest turn, plus the assistant turn its tool_results
 * answer).
 */
function validCuts(messages, pin, last) {
  const cuts = []
  const want = pin > 0 ? (messages[pin - 1]?.role === 'user' ? 'assistant' : 'user') : 'user'
  for (let c = pin + 1; c <= last; c++) {
    const m = messages[c]
    if (!m || m.role !== want) continue
    if (m.role === 'user' && hasToolResult(m)) continue
    cuts.push(c)
  }
  return cuts
}

function protectedStart(messages) {
  const n = messages.length
  if (n === 0) return 0
  const lastIdx = n - 1
  // The latest turn is never dropped; a tool_result turn keeps the assistant
  // turn holding its tool_use calls.
  if (hasToolResult(messages[lastIdx]) && lastIdx > 0 && messages[lastIdx - 1]?.role === 'assistant') return lastIdx - 1
  return lastIdx
}

function withNote(content, where) {
  if (typeof content === 'string') return where === 'start' ? `${TRIM_NOTE}\n${content}` : `${content}\n${TRIM_NOTE}`
  const block = { type: 'text', text: TRIM_NOTE }
  const arr = Array.isArray(content) ? content : []
  return where === 'start' ? [block, ...arr] : [...arr, block]
}

function stripImages(content) {
  let removed = 0
  const out = content.map((b) => {
    if (b && b.type === 'image') { removed++; return { type: 'text', text: IMAGE_STUB } }
    if (b && b.type === 'tool_result' && Array.isArray(b.content) && b.content.some(x => x && x.type === 'image')) {
      const inner = b.content.map(x => (x && x.type === 'image') ? (removed++, { type: 'text', text: IMAGE_STUB }) : x)
      return { ...b, content: inner }
    }
    return b
  })
  return { content: out, removed }
}

function cutText(s, maxChars) {
  if (typeof s !== 'string' || s.length <= maxChars) return s
  return s.slice(0, maxChars) + RESULT_CUT_NOTE
}

function shortenToolResults(content, maxChars) {
  let cut = 0
  const out = content.map((b) => {
    if (!b || b.type !== 'tool_result') return b
    if (typeof b.content === 'string' && b.content.length > maxChars) {
      cut++
      return { ...b, content: cutText(b.content, maxChars) }
    }
    if (Array.isArray(b.content)) {
      let changed = false
      const inner = b.content.map((x) => {
        if (x && x.type === 'text' && typeof x.text === 'string' && x.text.length > maxChars) {
          changed = true
          return { ...x, text: cutText(x.text, maxChars) }
        }
        return x
      })
      if (changed) { cut++; return { ...b, content: inner } }
    }
    return b
  })
  return { content: out, cut }
}

/**
 * Fit a request under the ceiling (default: CONTEXT_SAFETY_FRACTION of the
 * model's hard limit; no limit known = nothing to do). Pure: returns a new
 * messages array (input untouched) plus a report. `system` and `tools` are
 * only read.
 *
 * @param {{model?:string, system?:any, tools?:any[], messages:any[]}} req
 * @param {{ceiling?:number, quantum?:number, pinFirst?:number}} [opts]
 *   pinFirst: leading messages that are never dropped (the bot's seed turn).
 * @returns {{messages:any[], changed:boolean, estBefore:number, estAfter:number,
 *   droppedMessages:number, strippedImages:number, shortenedResults:number, stillOver:boolean}}
 */
export function fitPromptBudget(req, opts = {}) {
  const limit = contextLimitFor(req?.model)
  const ceiling = opts.ceiling ?? (limit ? Math.floor(limit * CONTEXT_SAFETY_FRACTION) : Infinity)
  const quantum = Math.max(1, opts.quantum ?? (limit ? Math.floor(limit * TRIM_QUANTUM_FRACTION) : 1))
  const messages = Array.isArray(req?.messages) ? req.messages : []
  const fixed = 10 + estimateSystemTokens(req?.system) + estimateToolsTokens(req?.tools)
  const sizes = messages.map(estimateMessageTokens)
  const estBefore = fixed + sizes.reduce((a, b) => a + b, 0)
  const report = {
    messages, changed: false, ceiling, estBefore, estAfter: estBefore,
    droppedMessages: 0, strippedImages: 0, shortenedResults: 0, stillOver: false,
  }
  if (estBefore <= ceiling) return report

  const pin = Math.min(Math.max(0, opts.pinFirst ?? 0), messages.length)
  let out = messages
  let est = estBefore

  // Stage 1: drop the oldest whole turns, quantized (see the header).
  const last = protectedStart(messages)
  const cuts = validCuts(messages, pin, last)
  if (cuts.length > 0) {
    const over = est - ceiling
    const need = Math.ceil(over / quantum) * quantum
    // cum = tokens from the start of the droppable region up to index c.
    let chosen = -1
    let cum = 0
    let k = pin
    for (const c of cuts) {
      while (k < c) { cum += sizes[k]; k++ }
      chosen = c
      if (cum >= need) break
    }
    if (chosen > pin) {
      const dropped = chosen - pin
      const droppedTokens = sizes.slice(pin, chosen).reduce((a, b) => a + b, 0)
      out = [...messages.slice(0, pin), ...messages.slice(chosen)]
      // The note rides inside an existing user turn, never as its own message,
      // so role alternation is untouched: it opens the first kept turn when
      // that is a user turn, else it closes the last pinned (user) turn. Both
      // spots sit after every cache breakpoint the pinned prefix carries.
      const at = out[pin]?.role === 'user' ? pin : (pin > 0 && out[pin - 1]?.role === 'user' ? pin - 1 : -1)
      if (at >= 0) {
        const m = out[at]
        const before = estimateMessageTokens(m)
        out[at] = { ...m, content: withNote(m.content, at === pin ? 'start' : 'end') }
        est += estimateMessageTokens(out[at]) - before
      }
      est -= droppedTokens
      report.droppedMessages = dropped
    }
  }

  // Stage 2: images outside the latest message become a stub, oldest first.
  if (est > ceiling) {
    const lastIdx = out.length - 1
    for (let i = 0; i < lastIdx && est > ceiling; i++) {
      const m = out[i]
      if (!Array.isArray(m?.content)) continue
      const { content, removed } = stripImages(m.content)
      if (removed > 0) {
        if (out === messages) out = messages.slice()
        const before = estimateMessageTokens(m)
        out[i] = { ...m, content }
        est += estimateMessageTokens(out[i]) - before
        report.strippedImages += removed
      }
    }
  }

  // Stage 3: shorten big tool results, oldest first, the latest turn last.
  for (const maxChars of [6_000, 2_000, 600]) {
    if (est <= ceiling) break
    for (let i = 0; i < out.length && est > ceiling; i++) {
      const m = out[i]
      if (m?.role !== 'user' || !Array.isArray(m.content)) continue
      const { content, cut } = shortenToolResults(m.content, maxChars)
      if (cut > 0) {
        if (out === messages) out = messages.slice()
        const before = estimateMessageTokens(m)
        out[i] = { ...m, content }
        est += estimateMessageTokens(out[i]) - before
        report.shortenedResults += cut
      }
    }
  }

  report.messages = out
  report.changed = out !== messages
  report.estAfter = est
  report.stillOver = est > ceiling
  return report
}

/**
 * Guard a Messages request body before it is sent. MUTATES `req.messages`
 * only when the safety net fires (callers build a fresh body per call, as
 * with applyAnthropicModelDefaults). Returns null when there is nothing to
 * report, else `{model, estBefore, longTier, trim}`: `longTier` = the
 * estimate is over the model's price tier (logged, never trimmed), `trim` =
 * the fitPromptBudget report when the context safety net ran.
 *
 * @param {Record<string, any>} req
 * @param {{pinFirst?:number, ceiling?:number, quantum?:number}} [opts]
 */
export function applyPromptBudget(req, opts = {}) {
  if (!req || !Array.isArray(req.messages)) return null
  const tier = longPromptTierFor(req.model)
  const limit = contextLimitFor(req.model)
  if (tier === null && limit === null && opts.ceiling === undefined) return null
  const ceiling = opts.ceiling ?? (limit ? Math.floor(limit * CONTEXT_SAFETY_FRACTION) : Infinity)
  // Fast path for the common case: the estimator never gives a character
  // more than 1.4 tokens, and the only things it counts above their JSON size
  // are images (up to 4,800 each) and schema-less tools (up to 3,000 each),
  // so a body under this bound cannot reach either threshold and the full
  // estimate (a few ms on a 30k prompt) is skipped.
  const floor = Math.min(tier ?? Infinity, ceiling)
  const json = safeJson({ s: req.system, t: req.tools, m: req.messages })
  const images = json.split('"type":"image"').length - 1
  const tools = Array.isArray(req.tools) ? req.tools.length : 0
  if (json.length * 1.4 + images * 4_800 + tools * 3_000 + 500 <= floor) return null
  const estBefore = estimateRequestTokens(req)
  const longTier = tier !== null && estBefore > tier
  let trim = null
  if (estBefore > ceiling) {
    trim = fitPromptBudget(req, { ...opts, ceiling })
    if (trim.changed) req.messages = trim.messages
  }
  if (!longTier && !trim) return null
  return { model: req.model, estBefore, longTier, trim }
}

/** One log line for a report from applyPromptBudget. */
export function describeBudgetReport(r, label = '') {
  const k = (n) => `${Math.round(n / 100) / 10}k`
  const head = `[sei/budget]${label ? ` ${label}` : ''} ${r.model} prompt est ${k(r.estBefore)}`
  if (!r.trim) {
    return `${head} > ${k(LONG_PROMPT_TIER_TOKENS)}: over the long-prompt tier, sent untouched (bills 5x if the real count is over too)`
  }
  const t = r.trim
  return `${head} > ${k(t.ceiling)} context safety net: dropped ${t.droppedMessages} old message(s), ` +
    `stubbed ${t.strippedImages} image(s), shortened ${t.shortenedResults} tool result(s) -> est ${k(t.estAfter)}` +
    (t.stillOver ? ' (STILL OVER: sent as is, the API may reject it)' : '')
}
