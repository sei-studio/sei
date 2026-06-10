import Anthropic from '@anthropic-ai/sdk'
import { logHaikuQuery, logHaikuResponse, logHaikuError } from './log.js'

/**
 * 260502-h6i: Stamp `cache_control: {type:'ephemeral'}` on the LAST tool entry
 * so Anthropic's prompt-cache boundary lands at the end of the tools array.
 * Marking only the last system block leaves `tools` outside the cached prefix
 * (cache_read stays at 0). Exported for the verify harness.
 */
export function stampLastToolCacheControl(tools) {
  if (!tools?.length) return undefined
  return tools.map((t, i) => i === tools.length - 1
    ? { ...t, cache_control: { type: 'ephemeral' } }
    : t)
}

/**
 * Build SDK constructor options. When `config.anthropic.cloudMode` is set, the
 * client is configured to route through the Sei Fly.io proxy with the user's
 * Supabase JWT as a Bearer token. Otherwise the legacy BYOK path (apiKey) is
 * preserved verbatim (D-57).
 *
 * SDK semantics verified against node_modules/@anthropic-ai/sdk/client.js
 * v0.91.1 (13-15 CHECKER warning #1 + #2):
 *   - `authToken` is stored on `this.authToken` at construction (line 78) and
 *     read PER REQUEST by `bearerAuth()` (lines 129-134). So live rotation
 *     works by mutating `sdk.authToken = newJwt` — no SDK re-init needed.
 *   - `process.env.ANTHROPIC_AUTH_TOKEN` is read ONCE at construction
 *     (`readEnv` on line 50). A per-call env read does NOT propagate to the
 *     SDK after construction. We therefore expose `setAuthToken()` for the
 *     rotation pump (13-14) to push new JWTs into the live SDK instance.
 *   - `authHeaders()` concatenates BOTH `apiKey`-based `X-Api-Key` AND
 *     `authToken`-based `Authorization: Bearer` headers if both are set
 *     (lines 120-134). Passing a dummy `apiKey: 'unused'` would leak
 *     `X-Api-Key: unused` upstream. We pass `apiKey: null` instead — line 77
 *     coerces non-string to null, and `apiKeyAuth()` returns undefined when
 *     `this.apiKey == null` (line 124), so NO X-Api-Key header is emitted.
 */
function buildSdkOptions(config) {
  // 260610: SDK auto-retries are OFF — `call()` owns retrying. The SDK's
  // retry loop honors a server `Retry-After` header by `await sleep(...)`
  // with NO abort-signal wiring and NO cap in v0.91.1 ("If the API asks us
  // to wait a certain amount of time, just do what it says"). The Sei proxy's
  // rate-limit gate sends `Retry-After: <seconds-to-window-reset>` (up to
  // 60); one such 429 parked a messages.create() in a 30s un-abortable sleep
  // that ignored BOTH the 20s deadline controller and the player-chat
  // preempt abort — the bot read as frozen for 30s (260609 incident).
  // call() re-implements the single rescue retry with a short, ABORTABLE
  // sleep under the same deadline controller.
  const maxRetries = 0
  if (config.anthropic.cloudMode) {
    return {
      baseURL: config.anthropic.cloudMode.baseURL,
      authToken: config.anthropic.cloudMode.authToken,
      apiKey: null,
      maxRetries,
    }
  }
  return { apiKey: config.anthropic.api_key, maxRetries }
}

// ── Retry policy for call()'s own (SDK-independent) retry ─────────────────
// One rescue retry, only when the failure is transient and there is enough
// budget left for the second attempt to plausibly finish.
const RETRY_MIN_REMAINING_MS = 2_500
// Sleep before the rescue attempt: server Retry-After when present, but never
// more than this — a denied early retry is a cheap rejection, a long sleep is
// a frozen bot.
const RETRY_SLEEP_CAP_MS = 2_000

function isRetryableError(err) {
  const s = err?.status
  if (s === 429 || s === 408 || (typeof s === 'number' && s >= 500)) return true
  // Connection-level failure (no HTTP status): APIConnectionError family.
  if (s === undefined && (err?.name === 'APIConnectionError' || err?.name === 'APIConnectionTimeoutError')) return true
  return false
}

/** Server-suggested retry delay in ms from an SDK APIError, or null. */
function retryAfterMsFrom(err) {
  try {
    const v = err?.headers?.get?.('retry-after')
    if (!v) return null
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n * 1000 : null
  } catch { return null }
}

/** setTimeout that resolves early (without throwing) when `signal` aborts. */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * @param {{anthropic:{api_key?:string,model:string,timeout_ms:number,cloudMode?:{baseURL:string,authToken:string}}}} config
 */
export function createAnthropicClient(config) {
  // `let` (not `const`): setBackend() rebuilds this instance on a live
  // cloud↔local switch (WR-05 follow-up). `call` reads `sdk` per invocation
  // through the closure, so a reassignment here is picked up by the next
  // outbound request without re-summoning the bot.
  let sdk = new Anthropic(buildSdkOptions(config))
  const model = config.anthropic.model
  const defaultTimeoutMs = config.anthropic.timeout_ms

  /**
   * Make a Messages API call.
   * @param {object} req
   * @param {{type:'text',text:string,cache_control?:{type:'ephemeral'}}[]} req.systemBlocks  // last block carries cache_control (D-17/D-18)
   * @param {{name:string,description:string,input_schema:object}[]} req.tools
   * @param {{role:'user'|'assistant',content:string|Array<any>}[]} req.messages — content may be a `ContentBlockParam[]` (text blocks, tool_use, tool_result). The SDK union accepts both `string` and block-array shapes; Loop.buildAnthropicPayload() emits the block-array form.
   * @param {AbortSignal} [req.signal]
   * @param {number} [req.timeoutMs]
   * @param {number} [req.maxTokens]
   * @param {Array<{role:string, content:Array<{type:string, name?:string, text?:string}>}>} [req.namedUserBlocks] Canonical pre-strip messages array carrying `name` fields on text blocks; used by log.js for cache-prefix hash elision. Logger-only; not sent to API.
   * @returns {Promise<{toolUses:Array<{id:string,name:string,input:any}>, text:string, usage:object, stopReason:string}>}
   */
  async function call({ systemBlocks, tools, messages, signal, timeoutMs, maxTokens = 1024, namedUserBlocks, thinking }) {
    logHaikuQuery({ messages, tools, systemBlocks, namedUserBlocks })
    // 260502-h6i: stamp cache_control on the LAST tool entry so the cache
    // boundary lands at the end of the tools array (system → tools is now
    // cached; cache_read can rise above 0).
    const _tools = stampLastToolCacheControl(tools)
    // Extended thinking: when enabled, the model emits private `thinking`
    // blocks BEFORE any text/tool_use. They are never relayed to chat but
    // MUST be preserved in conversation history when the same assistant turn
    // also produced a tool_use (Anthropic 400s otherwise). Caller gets the
    // raw content array so it can round-trip thinking blocks intact.
    // Budget is the smallest allowed (1024) by default — keeps latency low
    // while still giving the model a structured scratchpad to separate
    // private reasoning from in-character speech.
    const req = {
      model,
      max_tokens: maxTokens,
      system: systemBlocks,
      tools: _tools,
      messages,
    }
    if (thinking) req.thinking = thinking

    // 260607: bound the TOTAL wall-clock of this call across the SDK's internal
    // retries. The SDK `timeout` is PER-ATTEMPT, so maxRetries×timeout (+backoff)
    // is the true ceiling — that is the mechanism behind the 30-60s freezes.
    // A single controller aborts the request on EITHER the caller's signal (FSM
    // preempt) OR a wall-clock budget, whichever fires first, so the in-flight
    // request is actually cancelled (not left running to burn a proxy
    // reservation) and the player-visible stall is hard-capped at `budgetMs`.
    const budgetMs = timeoutMs ?? defaultTimeoutMs
    const ctrl = new AbortController()
    let timedOut = false
    const onExternalAbort = () => { try { ctrl.abort(signal.reason) } catch { ctrl.abort() } }
    if (signal) {
      if (signal.aborted) onExternalAbort()
      else signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    const deadline = setTimeout(() => { timedOut = true; ctrl.abort() }, budgetMs)

    const startedAt = Date.now()
    try {
      // Attempt loop: at most 2 attempts, both under the SAME deadline
      // controller. SDK auto-retry is disabled (buildSdkOptions) because its
      // Retry-After sleep is un-abortable and uncapped — the mechanism behind
      // the 30s frozen-bot incident (260609). Our rescue sleep is short,
      // capped, and aborts with the controller.
      let attempt = 0
      while (true) {
        attempt++
        try {
          // Per-attempt timeout sits just above the REMAINING budget so the
          // deadline controller is always the authoritative cap.
          const remainingMs = budgetMs - (Date.now() - startedAt)
          const resp = await sdk.messages.create(req, { signal: ctrl.signal, timeout: Math.max(1_000, remainingMs + 2_000) })
          const elapsedMs = Date.now() - startedAt
          const content = resp.content ?? []
          const toolUses = content
            .filter(b => b.type === 'tool_use')
            .map(b => ({ id: b.id, name: b.name, input: b.input }))
          const text = content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('')
          logHaikuResponse({ text, toolUses, usage: resp.usage, stopReason: resp.stop_reason, elapsedMs })
          return { toolUses, text, content, usage: resp.usage, stopReason: resp.stop_reason }
        } catch (err) {
          const elapsedMs = Date.now() - startedAt
          // Budget exhaustion: normalize to an AbortError so runIterations
          // treats it as a clean dropped-turn (loop + any in-flight
          // long-runner stay intact), not a hard error — and surface it
          // (previously a slow call was invisible: a [haiku?] with no
          // [haiku!]).
          if (timedOut) {
            logHaikuError({ elapsedMs, name: 'TimeoutError', message: `exceeded ${budgetMs}ms call budget` })
            const e = new Error(`anthropic call exceeded ${budgetMs}ms budget`)
            e.name = 'AbortError'
            e.isTimeout = true
            throw e
          }
          // External preempt (player chat / attack) is expected, not a
          // failure — bail out immediately, never retry across it.
          if (signal?.aborted || ctrl.signal.aborted) {
            logHaikuError({ elapsedMs, name: 'AbortError', message: 'aborted (preempt)', status: err?.status })
            throw err
          }
          // One rescue retry for transient failures (429 / 5xx / connection
          // blip), only with enough budget left to plausibly finish. Sleep
          // honors the server's Retry-After but hard-caps it: a denied early
          // retry is a cheap rejection; a long obedient sleep is a dead bot.
          const remainingMs = budgetMs - (Date.now() - startedAt)
          if (attempt === 1 && isRetryableError(err) && remainingMs > RETRY_MIN_REMAINING_MS) {
            const sleepMs = Math.max(100, Math.min(
              retryAfterMsFrom(err) ?? 500,
              RETRY_SLEEP_CAP_MS,
              remainingMs - RETRY_MIN_REMAINING_MS + 1_000,
            ))
            logHaikuError({
              elapsedMs,
              name: err?.name ?? 'Error',
              message: `${err?.message ?? String(err)} — retrying once in ${sleepMs}ms`,
              status: err?.status,
            })
            await abortableSleep(sleepMs, ctrl.signal)
            if (!ctrl.signal.aborted) continue
            // Aborted mid-sleep: loop once more; the create() call rejects
            // instantly on the aborted signal and routes through the
            // timedOut / preempt branches above with correct attribution.
            continue
          }
          // Terminal: 402 (depleted ledger), 4xx, exhausted retry — caller
          // handles by status.
          logHaikuError({
            elapsedMs,
            name: err?.name ?? 'Error',
            message: err?.message ?? String(err),
            status: err?.status,
          })
          throw err
        }
      }
    } finally {
      clearTimeout(deadline)
      if (signal) signal.removeEventListener('abort', onExternalAbort)
    }
  }

  /**
   * Helper: build the cached system prefix array. cache_control marker stays
   * on the LAST (tool) block per D-18. The caller provides the ordered list
   * of static text blocks; the tool block is appended automatically.
   *
   * Block order (current orchestrator wiring — see rebuildPersonalitySystem):
   *   0. baseline instructions (brain/prompts.js → BASELINE_INSTRUCTIONS)
   *   1. persona + still-learning line (brain/prompts.js → renderPersona)
   *   2. capability paragraph (adapter/<game>/prompts.js → CAPABILITY_PARAGRAPH)
   *   3. world primer (adapter/<game>/prompts.js → WORLD_PRIMER)
   *   4. game-specific action rules (adapter/<game>/prompts.js → ACTION_RULES)
   *   5. tool list ← cache_control here
   *
   * log.js indexes [1] for persona and [2] for capability — keep those slots
   * stable if you reorder.
   *
   * @param {string[]} staticBlocks
   * @param {{name:string,description:string,input_schema:object}[]} tools
   */
  function buildCachedSystem(staticBlocks, tools) {
    const toolBlock = tools.length
      ? `Available actions:\n` + tools.map(t => `- ${t.name}: ${t.description}`).join('\n')
      : 'No actions available.'
    return [
      ...staticBlocks.map(text => ({ type: 'text', text })),
      { type: 'text', text: toolBlock, cache_control: { type: 'ephemeral' } },
    ]
  }

  /**
   * Update the Bearer token used for cloud-proxy mode. The Anthropic SDK
   * reads `this.authToken` per-request in `bearerAuth()` (client.js:129-134),
   * so direct mutation propagates to the next outbound request without an
   * SDK re-init. No-op when cloudMode is not active (BYOK path keeps the
   * stamped apiKey).
   *
   * Called by the bot's parentPort message handler on `{type:'jwt'}` ticks
   * from the supervisor's `updateJwt()` (driven by jwtBridge in main, which
   * forwards Supabase TOKEN_REFRESHED events).
   *
   * @param {string|null} token New JWT, or null to clear (proxy will 401).
   */
  function setAuthToken(token) {
    if (!config.anthropic.cloudMode) return
    sdk.authToken = token
  }

  /**
   * Live-swap the backend between cloud-proxy and BYOK without re-summoning
   * the bot (WR-05 follow-up — was previously deferred to a "restart your bot"
   * banner). Rebuilds the SDK instance rather than mutating individual fields:
   * this is robust regardless of which options the SDK reads at construction
   * vs per-request (only `authToken` is documented as per-request; `baseURL`
   * and `apiKey` are read at construction in v0.91.1), and reuses the exact
   * `buildSdkOptions` semantics (apiKey:null suppresses X-Api-Key in cloud
   * mode). The captured `config.anthropic` is mutated in lockstep so
   * `setAuthToken`'s cloudMode guard stays correct after the switch — i.e. a
   * stray rotation tick no-ops once we're back on BYOK, and JWT rotation
   * resumes once we're on cloud.
   *
   * An in-flight `call` keeps using the SDK instance it already captured; the
   * NEXT call uses the rebuilt one. No re-validation through ConfigSchema —
   * we're past parse time, and BYOK-with-empty-key is a legal runtime state.
   *
   * @param {{cloudMode?:{baseURL:string,authToken:string}, api_key?:string}} backend
   */
  function setBackend(backend) {
    if (backend && backend.cloudMode) {
      config.anthropic.cloudMode = {
        baseURL: backend.cloudMode.baseURL,
        authToken: backend.cloudMode.authToken,
      }
      config.anthropic.api_key = ''
    } else {
      delete config.anthropic.cloudMode
      config.anthropic.api_key = (backend && typeof backend.api_key === 'string') ? backend.api_key : ''
    }
    sdk = new Anthropic(buildSdkOptions(config))
  }

  return { call, buildCachedSystem, model, setAuthToken, setBackend }
}
