// 261017 (issue #46): ChatGPT-plan provider for the bot brains ("Continue
// with ChatGPT"). Responses API over the shared wire module
// (responsesWire.js), with the same call shape as every other bot provider.
//
// Credentials: the bot never holds a refresh token. The access token arrives
// in the init payload (llm.providers.chatgpt.api_key + token_expires_at) and
// is replaced by main's pushes (chatgptTokenBridge.onChatgptToken). When it
// is about to expire, or a call comes back 401, the provider asks main for a
// fresh one (requestChatgptToken); main refreshes single-flight. A 401 is
// retried exactly once with the fresh token; a 401 on that retry is the
// terminal CHATGPT_AUTH_REJECTED (the sign-in itself is refused, so asking
// again every turn would only loop).
//
// A 400 before this provider has had any request accepted, or on the first
// request that carries a tool result, is the terminal
// CHATGPT_REQUEST_REJECTED: the request SHAPE is refused (a preview API
// change), every turn would fail the same way, and the companion would stand
// there mute. After a success a 400 stays an ordinary error.
//
// Voice-call latency parity with anthropicClient: `onSay` fires the moment
// the FIRST say() function call's item completes in the stream, and
// `spokenSay` (the orchestrator's timeout retry) suppresses a second emit and
// collapses the retried response's say calls onto the line already heard.
//
// Errors: terminal plan answers (usage limit, not eligible, signed out, ...)
// carry `code` in TERMINAL_CHATGPT_CODES and NO `status`, so the
// orchestrator halts the session (onTerminalError) instead of redriving.
// A blown budget is an AbortError with isTimeout, like anthropicClient.

import { buildResponsesBody, requestRejectedError, retried401Error, streamResponses } from './responsesWire.js'
import { onChatgptToken, requestChatgptToken } from './chatgptTokenBridge.js'
import { logHaikuError, logHaikuQuery, logHaikuResponse } from '../log.js'

const RESPONSES_URL = 'https://api.openai.com/v1/responses'
// Ask main for a fresh token this long before the current one expires.
const TOKEN_MARGIN_MS = 2 * 60_000
// The plan's efficient tier; main normally ships the account catalog's pick.
export const CHATGPT_DEFAULT_MODEL = 'gpt-6-luna'

// toolSteps: the model treats each function call as one step of its turn
// and expects the call's output back before the turn is over (the OpenAI
// tool loop: the turn ends with a response that calls nothing). Measured in
// the quality eval (261029, gpt-6-luna at low effort): an order was answered
// with say() alone ("on my way", "on your six", "yep, coal run") and the
// action was meant for the next step, but the orchestrator ended the loop on
// a say()-only turn, so the action never ran (8 of 9 off order lines). With
// this flag the orchestrator sends those outputs back once and lets the
// model take its next step (see talkOnlyNextStepFor in orchestrator.js).
const CAPABILITIES = { vision: true, cached: true, local: false, toolSteps: true }

export function createChatgptProvider(config, { fetchImpl = globalThis.fetch, url = RESPONSES_URL, now = () => Date.now() } = {}) {
  const pcfg = config.llm?.providers?.chatgpt ?? {}
  const model = pcfg.model || CHATGPT_DEFAULT_MODEL
  const reasoningEffort = typeof pcfg.reasoning_effort === 'string' && pcfg.reasoning_effort ? pcfg.reasoning_effort : null
  const defaultTimeoutMs = config.anthropic?.timeout_ms ?? 20_000
  let token = pcfg.api_key || ''
  let expiresAt = Number.isFinite(pcfg.token_expires_at) ? pcfg.token_expires_at : null
  // Vision follows the model (the catalog said so when main resolved it).
  const capabilities = { ...CAPABILITIES, vision: pcfg.vision !== false }
  // Request-shape bookkeeping for CHATGPT_REQUEST_REJECTED (see the header).
  let anyAccepted = false
  let toolRoundTripAccepted = false

  const unsubscribe = onChatgptToken((t, exp) => {
    token = t || ''
    expiresAt = exp
  })

  async function freshToken(force) {
    const r = await requestChatgptToken({ force })
    token = r.token
    expiresAt = r.expiresAt
    return token
  }

  async function currentToken() {
    if (!token) return freshToken(false)
    if (expiresAt !== null && expiresAt - now() < TOKEN_MARGIN_MS) {
      try { return await freshToken(false) } catch (err) {
        // Main unreachable or its refresh failed transiently: an unexpired token still works.
        if ((err?.code === 'CHATGPT_TOKEN_TIMEOUT' || err?.code === 'CHATGPT_TOKEN_UNAVAILABLE') && expiresAt > now()) return token
        throw err
      }
    }
    return token
  }

  async function call({ systemBlocks, tools, messages, signal, timeoutMs, onSay, spokenSay, namedUserBlocks }) {
    // Same [haiku?]/[haiku!]/[haiku✗] turn log as anthropicClient, so the
    // LogsBar, the quality-eval harness (snapshots, usage, scratchpad) and
    // post-mortems read a ChatGPT session the same way.
    logHaikuQuery({ messages, tools, systemBlocks, namedUserBlocks })
    const startedAt = now()
    const budgetMs = timeoutMs ?? defaultTimeoutMs
    const ctrl = new AbortController()
    let timedOut = false
    const onExternalAbort = () => ctrl.abort()
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    // Idle deadline: re-armed on every network chunk (the stream opens with
    // response.created at once, so a stall is what trips it).
    let timer = null
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; ctrl.abort() }, budgetMs)
    }
    arm()

    let sayFired = !!spokenSay
    const onCall = (c) => {
      if (sayFired || typeof onSay !== 'function' || c.name !== 'say') return
      sayFired = true
      try { onSay(String(c.input?.text ?? ''), c.id) } catch { /* caller's problem */ }
    }
    const body = buildResponsesBody({ model, system: systemBlocks, messages, tools, reasoningEffort })

    const carriesToolResult = Array.isArray(messages) && messages.some(m =>
      Array.isArray(m?.content) && m.content.some(b => b?.type === 'tool_result'))

    const attempt = (tok) => streamResponses({ fetchImpl, url, token: tok, body, signal: ctrl.signal, onChunk: arm, onCall })
    try {
      let resp
      try {
        const used = await currentToken()
        try {
          resp = await attempt(used)
        } catch (err) {
          if (err?.code !== 'CHATGPT_AUTH') throw err
          const fresh = await freshToken(true)
          // The forced refresh changed nothing (earliest_refresh_at): the
          // same token would 401 again and prove nothing about the sign-in.
          if (fresh === used) throw err
          arm()
          try {
            resp = await attempt(fresh)
          } catch (again) {
            if (again?.code === 'CHATGPT_AUTH') throw retried401Error(again)
            throw again
          }
        }
      } catch (err) {
        const shapeSuspect = !anyAccepted || (carriesToolResult && !toolRoundTripAccepted)
        if (err?.code === 'CHATGPT_HTTP_ERROR' && err.httpStatus === 400 && shapeSuspect) throw requestRejectedError(err)
        throw err
      }
      anyAccepted = true
      if (carriesToolResult) toolRoundTripAccepted = true
      if (spokenSay) resp = collapseSay(resp, spokenSay)
      logHaikuResponse({ text: resp.text, toolUses: resp.toolUses, usage: resp.usage, stopReason: resp.stopReason, elapsedMs: now() - startedAt })
      return resp
    } catch (err) {
      const elapsedMs = now() - startedAt
      if (timedOut && !signal?.aborted) {
        logHaikuError({ elapsedMs, name: 'TimeoutError', message: `exceeded ${budgetMs}ms call budget` })
        const e = new Error(`chatgpt call exceeded ${budgetMs}ms budget`)
        e.name = 'AbortError'
        e.isTimeout = true
        throw e
      }
      if (signal?.aborted) logHaikuError({ elapsedMs, name: 'AbortError', message: 'aborted (preempt)' })
      else logHaikuError({ elapsedMs, name: err?.code || err?.name || 'Error', message: err?.message ?? String(err), status: err?.httpStatus })
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onExternalAbort)
    }
  }

  // Same prose tool list as the other non-Anthropic providers (the cached
  // prefix is the instructions string here; OpenAI caches long prefixes
  // automatically when they are byte-identical).
  function buildCachedSystem(staticBlocks, toolList) {
    const toolBlock = toolList?.length
      ? `Available actions:\n` + toolList.map(t => `- ${t.name}: ${t.description}`).join('\n')
      : 'No actions available.'
    return [
      ...staticBlocks.map(text => ({ type: 'text', text })),
      { type: 'text', text: toolBlock },
    ]
  }

  return {
    call,
    buildCachedSystem,
    // Deliberately a no-op: the orchestrator's setAuthToken carries the
    // cloud proxy's Supabase JWT, which must never replace the ChatGPT
    // access token. Rotation arrives only through chatgptTokenBridge.
    setAuthToken: () => {},
    dispose: unsubscribe,
    get model() { return model },
    capabilities,
    kind: 'chatgpt',
  }
}

/**
 * The retried response's say calls collapse onto the line already spoken
 * (same id + text), so the orchestrator's early-say bookkeeping pairs up and
 * the bot never says a second, different line. Mirrors anthropicClient's
 * replaySpokenSay.
 */
export function collapseSay(resp, spokenSay) {
  const spoken = { type: 'tool_use', id: spokenSay.id, name: 'say', input: { text: spokenSay.text ?? '' } }
  const content = []
  let placed = false
  for (const b of resp.content) {
    if (b.type === 'tool_use' && b.name === 'say') {
      if (!placed) { content.push(spoken); placed = true }
      continue
    }
    content.push(b)
  }
  if (!placed) content.push(spoken)
  const toolUses = content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input }))
  return { ...resp, content, toolUses }
}
