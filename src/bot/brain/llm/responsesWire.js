// 261017 (issue #46): OpenAI Responses API wire format for the ChatGPT-plan
// provider ("Continue with ChatGPT"). Pure functions, no I/O. Shared by BOTH
// LLM layers: the bot's chatgptProvider.js (game brains) and main's
// src/main/llm/chatgptResponses.ts (chat, voice, folds, chess, Draw!,
// backseat, persona expansion), so the two can never drift on the request
// contract the plan route enforces.
//
// Contract (OpenAI SIWC docs, "Preview limitations" + "Models and inference",
// read 261017; ~/suisei/research/siwc/openai-siwc-docs.txt):
//   - ONLY `POST /v1/responses`, every request `store:false` + `stream:true`.
//     Inference counts as successful only after `response.completed`; a usage
//     limit can arrive as `response.failed` mid-stream.
//   - Full history in `input` every time (no previous_response_id).
//   - System text goes in `instructions` (explicit role:"system" items are
//     rejected).
//   - Omit background, conversation, max_output_tokens, max_tool_calls,
//     metadata, moderation, multi_agent, prompt, prompt_cache_retention,
//     safety_identifier, temperature, top_logprobs, top_p, truncation, user.
//     buildResponsesBody never sets any of them; UNSUPPORTED_BODY_FIELDS is
//     asserted by the tests.
//   - Function tools must be grouped in a namespace (TOOL_NAMESPACE below).
//   - Text and image input are supported; audio input is not (Sei never sends
//     audio to the LLM: STT runs before the brain).
//
// The orchestrator and every main-side surface speak Anthropic-shaped
// messages (text / image / tool_use / tool_result / thinking blocks). This
// module maps them onto Responses input items and folds the SSE event stream
// back into the Anthropic-shaped result both layers return.

import { randomUUID } from 'crypto'

/** The one namespace every Sei tool rides in (the plan route requires one). */
export const TOOL_NAMESPACE = 'sei'
const TOOL_NAMESPACE_DESCRIPTION = 'Tools for the Sei game companion: speaking, acting in the game, and memory.'

/** Body fields the plan route rejects. Never sent; the tests assert it. */
export const UNSUPPORTED_BODY_FIELDS = Object.freeze([
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier',
  'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
])

// â”€â”€â”€ Request mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Anthropic system (string or text blocks) â†’ one instructions string. */
export function flattenInstructions(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n\n')
}

function imageUrlOf(blk) {
  const src = blk?.source
  if (!src) return null
  if (src.type === 'url' && typeof src.url === 'string') return src.url
  if (typeof src.data !== 'string') return null
  if (src.data.startsWith('data:')) return src.data
  return `data:${src.media_type || 'image/png'};base64,${src.data}`
}

function inputImage(blk) {
  const url = imageUrlOf(blk)
  return url ? { type: 'input_image', image_url: url, detail: 'auto' } : null
}

/** A tool_result's content â†’ function_call_output `output` (string or parts). */
function toolResultOutput(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  const parts = []
  for (const b of content) {
    if (!b) continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'input_text', text: b.text })
    else if (b.type === 'image') {
      const img = inputImage(b)
      if (img) parts.push(img)
    }
  }
  if (parts.length === 0) return ''
  // Text-only results stay a plain string (the most widely accepted shape);
  // an image forces the content-array form.
  if (parts.every(p => p.type === 'input_text')) return parts.map(p => p.text).join('\n')
  return parts
}

/**
 * Anthropic messages â†’ Responses `input` items.
 *
 * user turn:      tool_result blocks â†’ function_call_output items (FIRST, so
 *                 each output directly follows its call); text/image blocks â†’
 *                 one {type:'message', role:'user'} with input_text/input_image.
 * assistant turn: text â†’ {type:'message', role:'assistant'} output_text;
 *                 tool_use â†’ {type:'function_call', call_id, name, namespace,
 *                 arguments}. No item `id` is sent: with store:false an id
 *                 refers to nothing server-side, and reasoning models reject a
 *                 function_call id that arrives without its reasoning item.
 * thinking / redacted_thinking / server tool blocks (Anthropic-only) drop.
 */
export function anthropicToResponsesInput(messages) {
  const out = []
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg) continue
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: String(msg.content ?? '') }]
    if (msg.role === 'user') {
      const parts = []
      for (const blk of blocks) {
        if (!blk) continue
        if (blk.type === 'tool_result') {
          out.push({
            type: 'function_call_output',
            call_id: String(blk.tool_use_id ?? ''),
            output: toolResultOutput(blk.content),
          })
        } else if (blk.type === 'text') {
          if (typeof blk.text === 'string' && blk.text) parts.push({ type: 'input_text', text: blk.text })
        } else if (blk.type === 'image') {
          const img = inputImage(blk)
          if (img) parts.push(img)
        }
      }
      if (parts.length > 0) out.push({ type: 'message', role: 'user', content: parts })
    } else if (msg.role === 'assistant') {
      const texts = []
      const calls = []
      for (const blk of blocks) {
        if (!blk) continue
        if (blk.type === 'text' && typeof blk.text === 'string' && blk.text) texts.push(blk.text)
        else if (blk.type === 'tool_use') {
          calls.push({
            type: 'function_call',
            call_id: String(blk.id ?? ''),
            name: String(blk.name ?? ''),
            namespace: TOOL_NAMESPACE,
            arguments: JSON.stringify(blk.input ?? {}),
          })
        }
      }
      if (texts.length > 0) {
        out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: texts.join('') }] })
      }
      out.push(...calls)
    }
  }
  return out
}

/**
 * Anthropic tool defs â†’ ONE namespace tool. `strict:false` is explicit: the
 * Responses API defaults function tools to strict mode, which demands
 * additionalProperties:false and every property required, and the Zod-emitted
 * schemas satisfy neither. cache_control markers are dropped.
 */
export function anthropicToolsToResponsesTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return [{
    type: 'namespace',
    name: TOOL_NAMESPACE,
    description: TOOL_NAMESPACE_DESCRIPTION,
    tools: tools.filter(t => t && t.name).map(t => ({
      type: 'function',
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
      strict: false,
    })),
  }]
}

/** Prompt note that backs up a forced tool choice (mirrors main's mapper). */
export function forcedToolNote(name) {
  return `\n\nYou must answer by calling the ${name} tool exactly once. Do not reply with plain text.`
}

/**
 * The full request body. `reasoningEffort` rides `reasoning.effort` only when
 * the account's model catalog advertised levels (sending it to a model with
 * none would 400). `toolChoice` (a forced tool, e.g. chess) maps to
 * tool_choice:'required' plus a prompt note: a namespaced forced-function
 * shape is undocumented on this route, and 'required' with a one-tool list is
 * equivalent.
 */
/**
 * @param {{model: string, system?: any, messages: any[], tools?: any[],
 *   toolChoice?: {name: string} | null, reasoningEffort?: string | null}} p
 * @returns {Record<string, any>}
 */
export function buildResponsesBody({ model, system, messages, tools, toolChoice, reasoningEffort }) {
  let instructions = flattenInstructions(system)
  if (toolChoice?.name) instructions += forcedToolNote(toolChoice.name)
  const body = {
    model,
    input: anthropicToResponsesInput(messages),
    store: false,
    stream: true,
  }
  if (instructions) body.instructions = instructions
  const t = anthropicToolsToResponsesTools(tools)
  if (t) {
    body.tools = t
    if (toolChoice?.name) body.tool_choice = 'required'
  }
  if (typeof reasoningEffort === 'string' && reasoningEffort) body.reasoning = { effort: reasoningEffort }
  return body
}

// â”€â”€â”€ SSE parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Incremental SSE parser. `push(text)` returns the parsed JSON payloads of
 * every event completed so far (blank-line delimited; multi-line `data:`
 * joined). `[DONE]` and unparseable payloads are skipped. `flush()` returns a
 * trailing event that had no final blank line.
 */
export function createSseParser() {
  let buf = ''
  let dataLines = []
  let eventName = null
  const takeEvent = (out) => {
    if (dataLines.length === 0) { eventName = null; return }
    const payload = dataLines.join('\n')
    dataLines = []
    const name = eventName
    eventName = null
    if (!payload || payload === '[DONE]') return
    try {
      const obj = JSON.parse(payload)
      if (obj && typeof obj === 'object' && !obj.type && name) obj.type = name
      out.push(obj)
    } catch { /* keep-alive or junk: skip */ }
  }
  function push(text) {
    const out = []
    buf += text
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line === '') { takeEvent(out); continue }
      if (line.startsWith(':')) continue
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('event:')) eventName = line.slice(6).trim()
    }
    return out
  }
  function flush() {
    const out = []
    if (buf) { push('\n'); buf = '' }
    takeEvent(out)
    return out
  }
  return { push, flush }
}

// â”€â”€â”€ Stream accumulation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Accumulator for one streamed response. `fold(event)` returns
 * `{ textDelta?, completedCall? }`: the text to forward to a streaming sink,
 * and a function call whose arguments just finished (the say() early emit).
 */
export function createResponsesAccumulator() {
  const items = new Map() // output_index â†’ item under construction
  const byId = new Map()  // item id â†’ output_index
  const state = {
    items,
    status: null,          // 'completed' | 'failed' | 'incomplete' | null (stream cut)
    error: null,           // {code, message, param} from response.failed / error
    incompleteReason: null,
    usage: null,
    finalOutput: null,     // response.completed's response.output (authoritative)
    refusal: '',
  }
  const indexOf = (ev) => {
    if (typeof ev.output_index === 'number') return ev.output_index
    if (ev.item_id && byId.has(ev.item_id)) return byId.get(ev.item_id)
    return -1
  }
  const ensure = (idx, seed) => {
    let it = items.get(idx)
    if (!it) {
      it = { type: seed?.type ?? 'message', text: '', arguments: '', ...(seed ?? {}) }
      if (typeof it.arguments !== 'string') it.arguments = ''
      if (typeof it.text !== 'string') it.text = ''
      items.set(idx, it)
    }
    if (it.id) byId.set(it.id, idx)
    return it
  }
  function fold(ev) {
    if (!ev || typeof ev !== 'object') return {}
    switch (ev.type) {
      case 'response.output_item.added': {
        const idx = indexOf(ev)
        const it = ensure(idx, { ...ev.item, text: '', arguments: ev.item?.arguments ?? '' })
        if (ev.item?.id) byId.set(ev.item.id, idx)
        return { _item: it }
      }
      case 'response.output_text.delta': {
        const idx = indexOf(ev)
        const it = ensure(idx, { type: 'message' })
        const d = typeof ev.delta === 'string' ? ev.delta : ''
        it.text += d
        return d ? { textDelta: d } : {}
      }
      case 'response.refusal.delta': {
        if (typeof ev.delta === 'string') state.refusal += ev.delta
        return {}
      }
      case 'response.function_call_arguments.delta': {
        const it = ensure(indexOf(ev), { type: 'function_call' })
        if (typeof ev.delta === 'string') it.arguments += ev.delta
        return {}
      }
      case 'response.function_call_arguments.done': {
        const it = ensure(indexOf(ev), { type: 'function_call' })
        if (typeof ev.arguments === 'string') it.arguments = ev.arguments
        return {}
      }
      case 'response.output_item.done': {
        const idx = indexOf(ev)
        const prev = items.get(idx)
        const done = ev.item ?? {}
        if (done.type === 'function_call') {
          const it = ensure(idx, { type: 'function_call' })
          Object.assign(it, done, { arguments: typeof done.arguments === 'string' ? done.arguments : it.arguments })
          return { completedCall: callOf(it) }
        }
        if (done.type === 'message') {
          const it = ensure(idx, { type: 'message' })
          const t = textOfMessageItem(done)
          // Only adopt the final text when nothing streamed (keeps deltas and
          // the final value consistent).
          if (!prev?.text && t) it.text = t
          it.type = 'message'
        } else if (done.type) {
          ensure(idx, done)
        }
        return {}
      }
      case 'response.completed': {
        state.status = 'completed'
        state.usage = ev.response?.usage ?? state.usage
        if (Array.isArray(ev.response?.output)) state.finalOutput = ev.response.output
        return {}
      }
      case 'response.incomplete': {
        state.status = 'incomplete'
        state.usage = ev.response?.usage ?? state.usage
        state.incompleteReason = ev.response?.incomplete_details?.reason ?? 'unknown'
        if (Array.isArray(ev.response?.output)) state.finalOutput = ev.response.output
        return {}
      }
      case 'response.failed': {
        state.status = 'failed'
        const e = ev.response?.error ?? {}
        state.error = { code: e.code ?? null, message: e.message ?? null, param: e.param ?? null }
        return {}
      }
      case 'error': {
        state.status = 'failed'
        const e = ev.error && typeof ev.error === 'object' ? ev.error : ev
        state.error = { code: e.code ?? null, message: e.message ?? null, param: e.param ?? null }
        return {}
      }
      default:
        return {}
    }
  }
  return { state, fold }
}

function textOfMessageItem(item) {
  if (!Array.isArray(item?.content)) return ''
  return item.content
    .filter(c => c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string')
    .map(c => c.text)
    .join('')
}

/**
 * Bare tool name for a function_call. The plan route returns the bare name
 * plus a separate `namespace`, but a `sei.say` / `sei__say` spelling is
 * accepted too so a format change degrades instead of silently dropping
 * every tool call.
 */
export function bareToolName(name, namespace) {
  let n = String(name ?? '')
  const ns = String(namespace || TOOL_NAMESPACE)
  for (const sep of ['.', '__', '/', ':']) {
    if (n.startsWith(ns + sep)) { n = n.slice(ns.length + sep.length); break }
  }
  return n
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }
  } catch {
    return { _raw: raw }
  }
}

function callOf(item) {
  return {
    id: String(item.call_id || item.id || `call_${randomUUID()}`),
    name: bareToolName(item.name, item.namespace),
    input: parseArgs(item.arguments),
  }
}

/** Responses usage â†’ the Anthropic-shaped usage both layers report. */
export function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return {}
  const total = Number(usage.input_tokens) || 0
  const cached = Number(usage.input_tokens_details?.cached_tokens) || 0
  return {
    input_tokens: Math.max(0, total - cached),
    output_tokens: Number(usage.output_tokens) || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  }
}

/**
 * Fold the accumulated stream into `{text, toolUses, content, usage,
 * stopReason}`. Throws a classified error when the stream did not end in
 * `response.completed` (failed, error event, or cut off), because only a
 * completed response counts as successful inference. `response.incomplete`
 * (e.g. the model hit its own output cap) still returns what arrived, with
 * stopReason 'max_tokens', so callers that tolerate a truncated turn keep it.
 */
export function finalizeResponses(acc) {
  const { state } = acc
  if (state.status === 'failed') {
    throw classifyResponsesError({ status: null, body: { error: state.error }, phase: 'stream' })
  }
  if (state.status !== 'completed' && state.status !== 'incomplete') {
    const e = new Error('CHATGPT_STREAM_INTERRUPTED: the response stream ended before it completed')
    e.code = 'CHATGPT_STREAM_INTERRUPTED'
    e.retryable = true
    throw e
  }
  // Authoritative output when the terminal event carried it; else the
  // accumulated items in output order.
  const ordered = state.finalOutput
    ? state.finalOutput.map(it => ({
      ...it,
      text: it.type === 'message' ? textOfMessageItem(it) : '',
      arguments: typeof it.arguments === 'string' ? it.arguments : '',
    }))
    : [...state.items.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
  // A completed response whose output array came back empty while text did
  // stream: trust the stream.
  const useStream = state.finalOutput && ordered.length === 0 && state.items.size > 0
  const list = useStream ? [...state.items.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) : ordered
  let text = ''
  const toolUses = []
  for (const it of list) {
    if (!it) continue
    if (it.type === 'message') text += it.text ?? ''
    else if (it.type === 'function_call') toolUses.push(callOf(it))
  }
  text = text.trim()
  const content = []
  if (text) content.push({ type: 'text', text })
  for (const tu of toolUses) content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
  const stopReason = state.status === 'incomplete'
    ? (state.incompleteReason === 'max_output_tokens' ? 'max_tokens' : state.incompleteReason)
    : toolUses.length > 0 ? 'tool_use' : 'end_turn'
  return { text, toolUses, content, usage: normalizeResponsesUsage(state.usage), stopReason }
}

// â”€â”€â”€ Errors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Typed error codes. TERMINAL ones must not be retried with the same request
 * (the docs: "do not repeat the same request or loop through OAuth"); the
 * callers latch on them and show the matching surface:
 *   CHATGPT_USAGE_LIMIT   429 subscription_sharing_usage_limit_exceeded â†’ usage-limit dialog
 *   CHATGPT_NOT_ELIGIBLE  403 subscription_sharing_user_not_eligible
 *   CHATGPT_FORBIDDEN     403 policy / region / chatpass_v2_* scope failures
 *   CHATGPT_UNSUPPORTED   400 subscription_sharing_unsupported_capability, route_not_supported
 *   CHATGPT_SIGNED_OUT    the token set is gone (terminal refresh error / revoked)
 *   CHATGPT_PLAN_DISABLED signed in, but plan usage (chatgpt.tokens.use.direct) not granted
 *   CHATGPT_AUTH_REJECTED a 401 again right after a forced token refresh: the
 *                         sign-in itself is not accepted, so retrying every
 *                         turn would only loop (authRejectedError)
 *   CHATGPT_REQUEST_REJECTED a 400 before any request (or tool round trip) of
 *                         the session succeeded: the request SHAPE is refused
 *                         (preview API change), so every turn would fail the
 *                         same way and the companion would go mute
 *                         (requestRejectedError)
 * Recoverable:
 *   CHATGPT_AUTH          401: refresh the access token once, then retry once
 *   CHATGPT_UNAVAILABLE   503 usage/user unavailable or direct routing down: bounded backoff
 *   CHATGPT_RATE_LIMITED  a 429 without the usage-limit code
 *   CHATGPT_HTTP_ERROR    anything else
 */
export const TERMINAL_CHATGPT_CODES = Object.freeze([
  'CHATGPT_USAGE_LIMIT', 'CHATGPT_NOT_ELIGIBLE', 'CHATGPT_FORBIDDEN', 'CHATGPT_UNSUPPORTED', 'CHATGPT_SIGNED_OUT',
  'CHATGPT_PLAN_DISABLED', 'CHATGPT_AUTH_REJECTED', 'CHATGPT_REQUEST_REJECTED',
])

const API_CODE_MAP = {
  subscription_sharing_usage_limit_exceeded: 'CHATGPT_USAGE_LIMIT',
  usage_limit_exceeded: 'CHATGPT_USAGE_LIMIT',
  subscription_sharing_user_not_eligible: 'CHATGPT_NOT_ELIGIBLE',
  subscription_sharing_usage_unavailable: 'CHATGPT_UNAVAILABLE',
  subscription_sharing_user_unavailable: 'CHATGPT_UNAVAILABLE',
  subscription_sharing_unsupported_capability: 'CHATGPT_UNSUPPORTED',
  subscription_sharing_route_not_supported: 'CHATGPT_UNSUPPORTED',
  subscription_sharing_invalid_user: 'CHATGPT_AUTH',
  chatpass_v2_scope_not_authorized: 'CHATGPT_FORBIDDEN',
  chatpass_v2_invalid_authorization_context: 'CHATGPT_FORBIDDEN',
}

const COPY = {
  CHATGPT_USAGE_LIMIT: 'ChatGPT plan usage limit reached',
  CHATGPT_NOT_ELIGIBLE: 'ChatGPT plan usage is not available for this account',
  CHATGPT_FORBIDDEN: 'ChatGPT plan usage was not permitted for this request',
  CHATGPT_UNSUPPORTED: 'the ChatGPT plan does not support part of this request',
  CHATGPT_AUTH: 'the ChatGPT sign-in was not accepted',
  CHATGPT_UNAVAILABLE: 'ChatGPT plan usage is temporarily unavailable',
  CHATGPT_RATE_LIMITED: 'too many requests to the ChatGPT plan right now',
  CHATGPT_HTTP_ERROR: 'the ChatGPT plan request failed',
  CHATGPT_AUTH_REJECTED: 'ChatGPT did not accept the sign-in, even after a fresh token',
  CHATGPT_REQUEST_REJECTED: "ChatGPT rejected Sei's request format",
}

/** Re-type a terminal answer from the cause, keeping its diagnostics. */
function terminalFrom(cause, code) {
  const e = new Error(`${code}: ${COPY[code]}${cause?.message ? ` (${String(cause.message).slice(0, 300)})` : ''}`)
  e.code = code
  e.apiCode = cause?.apiCode ?? null
  e.param = cause?.param ?? null
  e.requestId = cause?.requestId ?? null
  e.phase = cause?.phase ?? 'http'
  e.httpStatus = cause?.httpStatus ?? null
  e.terminal = true
  e.retryable = false
  return e
}

/**
 * A 401 on the retry that already used a force-refreshed token. Terminal
 * (no `status`), so neither layer asks again on the next turn; main latches
 * it and asks the player to sign in again.
 */
export function authRejectedError(cause) {
  return terminalFrom(cause, 'CHATGPT_AUTH_REJECTED')
}

/** A 400 that says the request shape itself is refused (see the code list). */
/**
 * The verdict on a 401 that came back AGAIN after a forced refresh produced a
 * new token (callers never retry when the refresh changed nothing, e.g. the
 * earliest_refresh_at window: that proves nothing about the sign-in).
 * subscription_sharing_invalid_user means the subscriber context could not be
 * validated, which a new sign-in does not fix unless the refresh itself was
 * terminal (that path is CHATGPT_SIGNED_OUT already), so it stops as a plan
 * restriction instead of asking the player to sign in again.
 */
export function retried401Error(cause) {
  if (cause?.apiCode === 'subscription_sharing_invalid_user') return terminalFrom(cause, 'CHATGPT_FORBIDDEN')
  return authRejectedError(cause)
}

export function requestRejectedError(cause) {
  return terminalFrom(cause, 'CHATGPT_REQUEST_REJECTED')
}

/**
 * Build a typed Error from an HTTP status + parsed body (either the standard
 * `{error:{code,message,param}}` object or a pre-stream admission body like
 * `{detail:"..."}`, which is diagnostic text only), or from a stream
 * `response.failed`. The message is prefixed with the code so string greps in
 * the renderer (chatFailureLine) and main can recognize it.
 *
 * Terminal codes carry the status on `httpStatus`, NOT `status`: the bot
 * orchestrator's generic 429 redrive and 401 JWT recovery key on `err.status`
 * and must never retry a usage-limit or eligibility failure.
 */
export function classifyResponsesError({ status, body, requestId = null, phase = 'http' }) {
  const errObj = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null
  const apiCode = errObj?.code ?? null
  const param = errObj?.param ?? null
  const detail = typeof body?.detail === 'string' ? body.detail : (typeof errObj?.message === 'string' ? errObj.message : '')
  let code = apiCode && API_CODE_MAP[apiCode]
  if (!code) {
    if (status === 401) code = 'CHATGPT_AUTH'
    else if (status === 403) code = 'CHATGPT_FORBIDDEN'
    else if (status === 503) code = 'CHATGPT_UNAVAILABLE'
    else if (status === 429) code = 'CHATGPT_RATE_LIMITED'
    else if (status === 400 && /unsupported/i.test(String(apiCode ?? detail))) code = 'CHATGPT_UNSUPPORTED'
    else code = 'CHATGPT_HTTP_ERROR'
  }
  const terminal = TERMINAL_CHATGPT_CODES.includes(code)
  const bits = [COPY[code] ?? 'ChatGPT plan request failed']
  if (status) bits.push(`HTTP ${status}`)
  if (apiCode) bits.push(String(apiCode))
  if (param) bits.push(`param ${param}`)
  if (detail) bits.push(String(detail).slice(0, 300))
  if (requestId) bits.push(`request ${requestId}`)
  const e = new Error(`${code}: ${bits.join(', ')}`)
  e.code = code
  e.apiCode = apiCode
  e.param = param
  e.requestId = requestId
  e.phase = phase
  e.httpStatus = status ?? null
  e.terminal = terminal
  e.retryable = code === 'CHATGPT_UNAVAILABLE' || code === 'CHATGPT_RATE_LIMITED'
  // Only non-terminal codes expose `status` (see the doc comment).
  if (!terminal && status && code !== 'CHATGPT_AUTH') e.status = status
  return e
}

/** Read a non-OK fetch Response into a classified error. Never throws itself. */
export async function errorFromResponse(resp) {
  let body = null
  try {
    const text = await resp.text()
    try { body = JSON.parse(text) } catch { body = text ? { detail: text.slice(0, 500) } : null }
  } catch { /* body unreadable */ }
  const requestId = resp.headers?.get?.('x-request-id') ?? resp.headers?.get?.('openai-request-id') ?? null
  return classifyResponsesError({ status: resp.status, body, requestId })
}

/**
 * Run one streamed request body through `fetchImpl` and fold it. Shared
 * transport for both layers: `onChunk` fires on every received network chunk
 * (both layers re-arm their idle timers there), `onEvent` sees every parsed
 * event, `onTextDelta` gets text deltas, and
 * `onCall` gets each completed function call as soon as its item closes.
 *
 * @param {{
 *   fetchImpl: (url: string, init: object) => Promise<any>,
 *   url: string,
 *   token: string,
 *   body: object,
 *   signal?: AbortSignal,
 *   onChunk?: () => void,
 *   onEvent?: (ev: object) => void,
 *   onTextDelta?: (text: string) => (void | Promise<void>),
 *   onCall?: (call: {id: string, name: string, input: object}) => void,
 * }} opts
 */
export async function streamResponses({ fetchImpl, url, token, body, signal, onChunk, onEvent, onTextDelta, onCall }) {
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) throw await errorFromResponse(resp)
  const acc = createResponsesAccumulator()
  const parser = createSseParser()
  const handle = async (events) => {
    for (const ev of events) {
      onEvent?.(ev)
      const r = acc.fold(ev)
      if (r.textDelta && onTextDelta) await onTextDelta(r.textDelta)
      if (r.completedCall && onCall) {
        try { onCall(r.completedCall) } catch { /* sink errors never break the stream */ }
      }
    }
  }
  if (!resp.body) {
    // No stream body (test doubles, odd proxies): parse the whole text.
    await handle(parser.push(await resp.text()))
  } else {
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onChunk?.()
      await handle(parser.push(decoder.decode(value, { stream: true })))
      // A caller cut (stop sequence, length cap, cancel) ends the read even
      // when the body source does not observe the signal itself.
      if (signal?.aborted) {
        try { reader.cancel().catch(() => {}) } catch { /* already closed */ }
        const e = new Error('The operation was aborted')
        e.name = 'AbortError'
        throw e
      }
    }
  }
  await handle(parser.flush())
  return finalizeResponses(acc)
}




