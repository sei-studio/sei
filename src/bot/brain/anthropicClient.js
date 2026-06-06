import Anthropic from '@anthropic-ai/sdk'
import { logHaikuQuery, logHaikuResponse } from './log.js'

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
  if (config.anthropic.cloudMode) {
    return {
      baseURL: config.anthropic.cloudMode.baseURL,
      authToken: config.anthropic.cloudMode.authToken,
      apiKey: null,
    }
  }
  return { apiKey: config.anthropic.api_key }
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
    const resp = await sdk.messages.create(req, { signal, timeout: timeoutMs ?? defaultTimeoutMs })
    const content = resp.content ?? []
    const toolUses = content
      .filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }))
    const text = content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
    logHaikuResponse({ text, toolUses, usage: resp.usage, stopReason: resp.stop_reason })
    return { toolUses, text, content, usage: resp.usage, stopReason: resp.stop_reason }
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
