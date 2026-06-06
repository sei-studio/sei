// Ollama local provider — uses `/api/chat` (NOT `/v1/chat/completions`).
// Per ROADMAP Phase 14 Pitfall 7, Ollama's OpenAI-compatibility endpoint
// silently drops `tool_calls` under streaming. The native `/api/chat` route
// returns tool calls reliably with `stream: false`.

import { randomUUID } from 'crypto'
import {
  flattenSystemBlocks,
  anthropicToOpenAIMessages,
  anthropicToolsToOpenAITools,
} from './messageMappers.js'

const CAPABILITIES = { vision: false, cached: false, local: true }

export function createOllamaProvider(config, { fetchImpl = globalThis.fetch } = {}) {
  const pcfg = config.llm?.providers?.ollama ?? {}
  const baseURL = pcfg.base_url ?? 'http://localhost:11434'
  const model = pcfg.model ?? 'llama3.1'
  const defaultTimeoutMs = config.anthropic?.timeout_ms ?? 20_000

  async function call({ systemBlocks, tools, messages, signal, timeoutMs, maxTokens = 1024 }) {
    const systemText = flattenSystemBlocks(systemBlocks)
    // Ollama's /api/chat accepts OpenAI-style messages + tools[].function shape.
    // We reuse the OpenAI message mapper; the wire shape is the same.
    const body = {
      model,
      stream: false,
      options: { num_predict: maxTokens },
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
      resp = await fetchImpl(`${baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onParentAbort)
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
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
    capabilities: CAPABILITIES,
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
