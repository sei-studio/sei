// LlmProvider factory. Picks an adapter based on `config.llm.provider`
// (defaults to 'anthropic' for backwards compatibility with existing
// config.json files that pre-date this phase).
//
// All adapters expose the same call shape consumed by orchestrator.js:
//   call({ systemBlocks, tools, messages, signal, timeoutMs, maxTokens, thinking })
//     -> { toolUses: [{id,name,input}], text, content, usage, stopReason }
//   buildCachedSystem(staticBlocks, tools) -> systemBlocks
//   setAuthToken(token): void   (no-op outside Anthropic cloud-proxy mode)
//   capabilities: { vision, cached, local }
//   model: string

import { createAnthropicProvider } from './anthropicProvider.js'
import { createOpenAICompatProvider } from './openaiCompatProvider.js'
import { createGeminiProvider } from './geminiProvider.js'
import { createOllamaProvider } from './ollamaProvider.js'

// 10 providers share the OpenAI Chat Completions wire format with
// provider-specific baseURL + bearer auth.
const OPENAI_COMPAT = {
  openai:     'https://api.openai.com/v1',
  grok:       'https://api.x.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek:   'https://api.deepseek.com/v1',
  mistral:    'https://api.mistral.ai/v1',
  together:   'https://api.together.xyz/v1',
  groq:       'https://api.groq.com/openai/v1',
  fireworks:  'https://api.fireworks.ai/inference/v1',
  cerebras:   'https://api.cerebras.ai/v1',
  perplexity: 'https://api.perplexity.ai',
}

export const SUPPORTED_PROVIDERS = [
  'anthropic',
  ...Object.keys(OPENAI_COMPAT),
  'gemini',
  'ollama',
]

export function createLlmProvider(config, deps = {}) {
  const kind = config.llm?.provider ?? 'anthropic'
  if (kind === 'anthropic') return createAnthropicProvider(config)
  if (kind === 'gemini')    return createGeminiProvider(config, deps)
  if (kind === 'ollama')    return createOllamaProvider(config, deps)
  if (OPENAI_COMPAT[kind]) {
    return createOpenAICompatProvider(config, { ...deps, kind, defaultBaseURL: OPENAI_COMPAT[kind] })
  }
  throw new Error(`Unknown llm.provider: ${kind}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`)
}
