// Google Gemini adapter — uses the v1beta generateContent REST endpoint with
// the API key passed as a query string (per Google's quickstart). Tool calls
// use `functionDeclarations` + `tools.function_calling_config`. Non-streaming.

import {
  flattenSystemBlocks,
  anthropicToGeminiContents,
  anthropicToolsToGeminiTools,
  geminiResponseToAnthropic,
} from './messageMappers.js'

const CAPABILITIES = { vision: true, cached: true, local: false }

export function createGeminiProvider(config, { fetchImpl = globalThis.fetch } = {}) {
  const pcfg = config.llm?.providers?.gemini ?? {}
  const apiKey = pcfg.api_key ?? ''
  const baseURL = pcfg.base_url ?? 'https://generativelanguage.googleapis.com/v1beta'
  const model = pcfg.model ?? 'gemini-2.0-flash'
  const defaultTimeoutMs = config.anthropic?.timeout_ms ?? 20_000

  if (!apiKey) throw new Error(`gemini provider: api_key missing in llm.providers.gemini.api_key`)

  async function call({ systemBlocks, tools, messages, signal, timeoutMs, maxTokens = 1024 }) {
    const systemText = flattenSystemBlocks(systemBlocks)
    const body = {
      contents: anthropicToGeminiContents(messages),
      generationConfig: { maxOutputTokens: maxTokens },
    }
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] }
    const t = anthropicToolsToGeminiTools(tools)
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
      resp = await fetchImpl(`${baseURL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
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
      throw new Error(`gemini API ${resp.status}: ${text.slice(0, 500)}`)
    }
    const data = await resp.json()
    return geminiResponseToAnthropic(data)
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
    kind: 'gemini',
  }
}
