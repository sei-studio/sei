// OpenAI-compatible adapter — covers OpenAI, Grok (x.ai), OpenRouter,
// DeepSeek, Mistral, Together, Groq, Fireworks. All speak `/v1/chat/completions`
// with bearer-auth headers. Per-provider baseURL is selected by the factory.
//
// Notes:
//   - Streaming is OFF. The bot loop consumes a non-streaming response.
//   - Tool calls use OpenAI's `tools[].function` shape. Each function's
//     `arguments` is a JSON string the adapter parses back into an object.
//   - Anthropic `system` blocks are flattened to a single string and prepended
//     as a `role:'system'` message.
//   - Anthropic `tool_result` user-turn blocks are split into separate
//     `role:'tool'` messages (OpenAI's protocol). See messageMappers.js.

import {
  flattenSystemBlocks,
  anthropicToOpenAIMessages,
  anthropicToolsToOpenAITools,
  openAIResponseToAnthropic,
} from './messageMappers.js'

const CAPABILITIES_BY_KIND = {
  openai:     { vision: true,  cached: true,  local: false },
  grok:       { vision: true,  cached: false, local: false },
  openrouter: { vision: true,  cached: true,  local: false },
  deepseek:   { vision: false, cached: false, local: false },
  mistral:    { vision: true,  cached: false, local: false },
  together:   { vision: true,  cached: false, local: false },
  groq:       { vision: false, cached: false, local: false },
  fireworks:  { vision: true,  cached: false, local: false },
  cerebras:   { vision: false, cached: false, local: false },
  perplexity: { vision: false, cached: false, local: false },
}

const DEFAULT_MODELS = {
  openai:     'gpt-4o-mini',
  grok:       'grok-2-latest',
  openrouter: 'anthropic/claude-haiku-4-5',
  deepseek:   'deepseek-chat',
  mistral:    'mistral-small-latest',
  together:   'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  groq:       'llama-3.3-70b-versatile',
  fireworks:  'accounts/fireworks/models/llama-v3p3-70b-instruct',
  cerebras:   'llama-3.3-70b',
  perplexity: 'sonar',
}

export function createOpenAICompatProvider(config, { kind, defaultBaseURL, fetchImpl = globalThis.fetch } = {}) {
  const pcfg = config.llm?.providers?.[kind] ?? {}
  const apiKey = pcfg.api_key ?? ''
  const baseURL = pcfg.base_url ?? defaultBaseURL
  const model = pcfg.model ?? DEFAULT_MODELS[kind] ?? 'gpt-4o-mini'
  const defaultTimeoutMs = config.anthropic?.timeout_ms ?? 20_000

  if (!baseURL) throw new Error(`openai-compat provider '${kind}': baseURL missing`)
  if (!apiKey)  throw new Error(`openai-compat provider '${kind}': api_key missing in llm.providers.${kind}.api_key`)

  async function call({ systemBlocks, tools, messages, signal, timeoutMs, maxTokens = 1024 }) {
    const systemText = flattenSystemBlocks(systemBlocks)
    const body = {
      model,
      max_tokens: maxTokens,
      messages: anthropicToOpenAIMessages(messages, systemText),
    }
    const t = anthropicToolsToOpenAITools(tools)
    if (t) body.tools = t

    const controller = new AbortController()
    const onParentAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onParentAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? defaultTimeoutMs)
    let resp
    try {
      resp = await fetchImpl(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onParentAbort)
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`${kind} API ${resp.status}: ${text.slice(0, 500)}`)
    }
    const data = await resp.json()
    return openAIResponseToAnthropic(data)
  }

  // System-block builder (parity with anthropicClient.buildCachedSystem). No
  // cache_control marker — these providers don't use it; the flatten step
  // would drop it anyway.
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
    capabilities: CAPABILITIES_BY_KIND[kind] ?? { vision: false, cached: false, local: false },
    kind,
  }
}
