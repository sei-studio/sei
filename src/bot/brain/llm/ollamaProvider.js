// Ollama local provider — uses `/api/chat` (NOT `/v1/chat/completions`).
// Per ROADMAP Phase 14 Pitfall 7, Ollama's OpenAI-compatibility endpoint
// silently drops `tool_calls` under streaming. The native `/api/chat` route
// returns tool calls reliably with `stream: false`.

import { randomUUID } from 'crypto'
import {
  flattenSystemBlocks,
  anthropicToOllamaMessages,
  anthropicToolsToOpenAITools,
} from './messageMappers.js'
import { chooseOllamaNumCtx, estimateOllamaPromptTokens } from './ollamaContext.js'

/**
 * Local floor for one call (261010), same value as src/main/llm/ollama.ts
 * LOCAL_TIMEOUT_FLOOR_MS. The orchestrator budgets a turn at
 * anthropic.timeout_ms (12s), sized for a cloud API. A local model's first
 * turn includes loading it into memory and evaluating a ~12k-token prompt, and
 * a model that does not fit in VRAM runs partly on the CPU, so every turn of a
 * larger model was aborted at 12s and dropped without a word: "anything bigger
 * flat out does not work". A player chat or an attack still cuts a slow call
 * short through the caller's signal.
 */
export const LOCAL_TIMEOUT_FLOOR_MS = 120_000

/**
 * Error codes the orchestrator turns into a clear user-facing stop instead of
 * a silent dead loop (261010). Both are permanent for this model: every turn
 * would fail the same way.
 */
export const OLLAMA_MODEL_NO_TOOLS = 'OLLAMA_MODEL_NO_TOOLS'
export const OLLAMA_MODEL_MISSING = 'OLLAMA_MODEL_MISSING'
export const OLLAMA_UNREACHABLE = 'OLLAMA_UNREACHABLE'

function codedError(code, message) {
  const e = new Error(`${code}: ${message}`)
  e.code = code
  return e
}

/**
 * Ollama vision by model NAME. MIRRORS ollamaVisionHeuristic in
 * src/shared/llmCatalog.ts (this process cannot import the shared TS;
 * llmCatalogSync.test.js pins the two together). Only a fallback: the
 * provider asks Ollama itself (POST /api/show `capabilities`) at creation.
 * 'unknown' means "not a name we know", and the bot treats it as no vision
 * until /api/show answers, because an image sent to a text-only model is a
 * 400 that kills the turn.
 */
export function ollamaVisionHeuristic(model) {
  const m = String(model || '').toLowerCase().trim()
  const colon = m.lastIndexOf(':')
  const name = colon > m.lastIndexOf('/') && colon >= 0 ? m.slice(0, colon) : m
  const tag = name === m ? '' : m.slice(colon + 1)
  if (/(^|\/)gemma-?3$/.test(name)) return /^(270m|1b)\b/.test(tag) ? 'no' : 'yes'
  if (/llava|moondream|minicpm-v|vision|vl\b|internvl|llama4|gemma-?4|mistral-small-?3\.[12]|ministral-3|deepseek-ocr/.test(name)) {
    return 'yes'
  }
  return 'unknown'
}

const SHOW_TIMEOUT_MS = 3_000

/**
 * Ollama's own verdict for one model: true/false from /api/show
 * `capabilities`, or null when it cannot say (unreachable, error, an Ollama
 * too old to report capabilities). Never throws.
 */
export async function probeOllamaVision(baseURL, model, fetchImpl = globalThis.fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SHOW_TIMEOUT_MS)
  timer.unref?.()
  try {
    const resp = await fetchImpl(`${baseURL}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    })
    if (!resp?.ok) return null
    const data = await resp.json()
    if (!Array.isArray(data?.capabilities)) return null
    return data.capabilities.includes('vision')
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function createOllamaProvider(config, { fetchImpl = globalThis.fetch } = {}) {
  const pcfg = config.llm?.providers?.ollama ?? {}
  const baseURL = pcfg.base_url ?? 'http://localhost:11434'
  const model = pcfg.model ?? 'llama3.1'
  const defaultTimeoutMs = config.anthropic?.timeout_ms ?? 20_000

  // 261010: vision was hard-coded false for every Ollama model, so look()/
  // explore pictures never reached qwen2.5vl/gemma3/llava. The orchestrator
  // reads capabilities.vision live, so the /api/show answer simply replaces
  // the name guess when it lands (milliseconds on localhost, long before the
  // first turn). visionReady lets the lifecycle push wait for it.
  const capabilities = { vision: ollamaVisionHeuristic(model) === 'yes', cached: false, local: true }
  const visionReady = probeOllamaVision(baseURL, model, fetchImpl).then((v) => {
    if (typeof v === 'boolean') capabilities.vision = v
    return capabilities.vision
  })

  async function call({ systemBlocks, tools, messages, signal, timeoutMs, maxTokens = 1024 }) {
    const systemText = flattenSystemBlocks(systemBlocks)
    // Native /api/chat message shape (string content + `images`, OBJECT tool
    // arguments). NOT the OpenAI mapper: its array content and JSON-string
    // arguments are 400s on this route (261010).
    const body = {
      model,
      stream: false,
      // Thinking OFF (260915): Ollama enables it by default on qwen3/deepseek-r1/
      // gemma4-class models and bills the reasoning against num_predict, so a
      // short turn came back with an EMPTY content and the bot fell silent.
      // Accepted by models without the capability too; see src/main/llm/ollama.ts.
      think: false,
      options: { num_predict: maxTokens },
      messages: anthropicToOllamaMessages(messages, systemText),
    }
    const t = anthropicToolsToOpenAITools(tools)
    if (t) body.tools = t
    // Context window sized to the prompt (261010, ollamaContext.js). Without
    // it Ollama ran 4096 tokens and cut the front of the ~12k-token Minecraft
    // prompt: persona, rules and tool definitions.
    body.options.num_ctx = await chooseOllamaNumCtx({
      baseURL,
      model,
      promptTokens: estimateOllamaPromptTokens(body),
      maxTokens,
      fetchImpl,
    })

    const controller = new AbortController()
    const onParentAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onParentAbort, { once: true })
    }
    const budgetMs = Math.max(timeoutMs ?? defaultTimeoutMs, LOCAL_TIMEOUT_FLOOR_MS)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, budgetMs)
    let resp
    try {
      resp = await fetchImpl(`${baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      // Same shape anthropicClient gives a blown budget: an AbortError with
      // isTimeout, so runIterations retries the turn once instead of silently
      // dropping it as if a preempt had cancelled it.
      if (timedOut && !signal?.aborted) {
        const e = new Error(`ollama call exceeded ${budgetMs}ms budget (model ${model} too slow to load or answer)`)
        e.name = 'AbortError'
        e.isTimeout = true
        throw e
      }
      if (err?.name === 'AbortError' || signal?.aborted) throw err
      const why = err?.cause?.message ?? err?.message ?? String(err)
      throw codedError(OLLAMA_UNREACHABLE, `couldn't reach Ollama at ${baseURL} (${why})`)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onParentAbort)
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      // Many Ollama models (gemma3, llava, qwen2.5vl, llama3.2-vision, ...)
      // have no tool support and Ollama refuses the whole request. The game
      // brain cannot run without tools (speech itself is the say() tool), so
      // this is a permanent, explainable stop, not a retry (261010).
      if (resp.status === 400 && /does not support tools/i.test(text)) {
        throw codedError(OLLAMA_MODEL_NO_TOOLS, `${model} does not support tools`)
      }
      if (resp.status === 404 && /model[^\n]{0,120}not found|try pulling/i.test(text)) {
        throw codedError(OLLAMA_MODEL_MISSING, `Ollama has no model named ${model}`)
      }
      throw new Error(`ollama API ${resp.status}: ${text.slice(0, 500)}`)
    }
    const data = await resp.json()
    return ollamaResponseToAnthropic(data)
  }

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
    setAuthToken: () => {},
    get model() { return model },
    capabilities,
    visionReady,
    kind: 'ollama',
  }
}

// Ollama /api/chat response shape: { message: { role, content, tool_calls? }, ... }
// tool_calls[i].function.arguments is already an OBJECT (not a JSON string like
// OpenAI). We normalize to {id, name, input}.
function ollamaResponseToAnthropic(data) {
  const msg = data?.message ?? {}
  const text = typeof msg.content === 'string' ? msg.content : ''
  const toolUses = []
  for (const call of msg.tool_calls ?? []) {
    const fn = call?.function ?? {}
    const input = (fn.arguments && typeof fn.arguments === 'object') ? fn.arguments : {}
    toolUses.push({ id: call.id ?? `toolu_${randomUUID()}`, name: fn.name, input })
  }
  return {
    toolUses,
    text,
    content: undefined,
    usage: { prompt_tokens: data?.prompt_eval_count, completion_tokens: data?.eval_count },
    stopReason: data?.done_reason ?? 'stop',
  }
}
