// 260828: no-drift guard between the SHARED provider catalog
// (src/shared/llmCatalog.ts — the source of truth every app surface reads)
// and the bot's hand-mirrored copies. The bot ships as plain ESM JS and
// cannot import the shared TS module at runtime, so its tables are duplicated
// by hand — and they had drifted: openai gpt-4o-mini vs gpt-5-mini, grok
// grok-2-latest vs grok-4, gemini 2.0-flash vs 2.5-flash, and openrouter
// 'anthropic/claude-haiku-4-5' (the dash form is not a real OpenRouter slug).
// A BYOK user therefore ran a DIFFERENT model in Minecraft than on every
// other surface whenever the model reached the bot through a default instead
// of the init payload. This test (vitest CAN transform the TS import) pins
// every mirror to the catalog so the drift cannot recur. Change models in
// llmCatalog.ts FIRST; these mirrors follow.
//
// Note: qwen deliberately defaults to 'qwen-plus' in both tables — an old
// plan said qwen3-max; that was superseded, qwen-plus is correct.

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MODELS,
  OPENAI_COMPAT_BASE_URLS,
  SHOWN_PROVIDERS,
  GRANDFATHERED_PROVIDERS,
  ollamaVisionHeuristic as catalogOllamaVision,
} from '../shared/llmCatalog'
import { ConfigSchema, LLM_PROVIDER_KINDS } from './config.js'
import { BASE_URLS } from './brain/llm/index.js'
import { COMPAT_DEFAULT_MODELS } from './brain/llm/openaiCompatProvider.js'
import { ollamaVisionHeuristic as botOllamaVision, LOCAL_TIMEOUT_FLOOR_MS as BOT_LOCAL_FLOOR } from './brain/llm/ollamaProvider.js'
import * as botCtx from './brain/llm/ollamaContext.js'
import * as mainCtx from '../main/llm/ollamaContext'
import { LOCAL_TIMEOUT_FLOOR_MS as MAIN_LOCAL_FLOOR } from '../main/llm/ollama'

// Minimal ConfigSchema-valid raw config (BYOK shape).
const parsed = ConfigSchema.parse({
  player_username: 'Player',
  persona: { name: 'Sui', expanded: 'x' },
  anthropic: { api_key: 'sk-test' },
  adapter: {
    kind: 'minecraft',
    minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: 'Sui' },
  },
})

describe('bot mirrors of src/shared/llmCatalog.ts (no-drift)', () => {
  it('every catalog provider is a legal config.llm.provider kind (and vice versa)', () => {
    const catalogKinds = [...SHOWN_PROVIDERS, ...GRANDFATHERED_PROVIDERS].sort()
    expect([...LLM_PROVIDER_KINDS].sort()).toEqual(catalogKinds)
  })

  it('ConfigSchema per-provider default models equal catalog DEFAULT_MODELS', () => {
    const mismatches = []
    for (const [kind, model] of Object.entries(DEFAULT_MODELS)) {
      const botDefault =
        kind === 'anthropic' ? parsed.anthropic.model : parsed.llm.providers[kind]?.model
      if (botDefault !== model) mismatches.push(`${kind}: bot=${botDefault} catalog=${model}`)
    }
    expect(mismatches).toEqual([])
  })

  it('qwen stays qwen-plus in both tables (qwen3-max plan superseded)', () => {
    expect(DEFAULT_MODELS.qwen).toBe('qwen-plus')
    expect(parsed.llm.providers.qwen.model).toBe('qwen-plus')
  })

  it('openrouter default is the real dot-form slug, not the dash form', () => {
    expect(parsed.llm.providers.openrouter.model).toBe('anthropic/claude-haiku-4.5')
  })

  it('openaiCompatProvider fallback table equals the catalog for its kinds', () => {
    for (const [kind, model] of Object.entries(COMPAT_DEFAULT_MODELS)) {
      expect(`${kind}:${model}`).toBe(`${kind}:${DEFAULT_MODELS[kind]}`)
    }
    // and it covers exactly the OpenAI-compat set
    expect(Object.keys(COMPAT_DEFAULT_MODELS).sort()).toEqual(Object.keys(BASE_URLS).sort())
  })

  it('factory BASE_URLS equal catalog OPENAI_COMPAT_BASE_URLS', () => {
    expect(BASE_URLS).toEqual(OPENAI_COMPAT_BASE_URLS)
  })

  it('the bot Ollama vision heuristic equals the catalog one (261010)', () => {
    const names = [
      'qwen2.5vl:3b', 'qwen3-vl:2b-instruct', 'gemma3', 'gemma3:4b', 'gemma3:1b', 'gemma3:270m', 'gemma4:e4b',
      'llama3.2-vision', 'llama4:scout', 'llava', 'bakllava', 'moondream', 'minicpm-v', 'granite3.2-vision',
      'mistral-small3.1', 'ministral-3:8b', 'deepseek-ocr', 'internvl3', 'llama3.1', 'qwen2.5:0.5b', 'qwen3:1.7b',
      'gpt-oss:20b', 'hf.co/x/y-GGUF:Q4_K_M', 'someone/llava-x:latest', '',
    ]
    for (const n of names) expect(`${n}:${botOllamaVision(n)}`).toBe(`${n}:${catalogOllamaVision(n)}`)
  })

  it('the bot Ollama num_ctx sizing equals main (261010)', () => {
    expect(botCtx.OLLAMA_CTX_MIN).toBe(mainCtx.OLLAMA_CTX_MIN)
    expect(botCtx.OLLAMA_CTX_MAX).toBe(mainCtx.OLLAMA_CTX_MAX)
    expect(botCtx.OLLAMA_IMAGE_TOKENS).toBe(mainCtx.OLLAMA_IMAGE_TOKENS)
    for (const [p, m] of [[0, 0], [3000, 200], [12_053, 1024], [15_000, 1024], [40_000, 1024], [7_000, undefined]]) {
      expect(botCtx.neededNumCtx(p, m)).toBe(mainCtx.neededNumCtx(p, m))
    }
    const req = {
      messages: [{ role: 'system', content: 'You are Sui. 你好' }, { role: 'user', content: 'look', images: ['AAAA'] }],
      tools: [{ type: 'function', function: { name: 'say', parameters: {} } }],
    }
    expect(botCtx.estimateOllamaPromptTokens(req)).toBe(mainCtx.estimateOllamaPromptTokens(req))
  })

  it('the bot local timeout floor equals main (261010)', () => {
    expect(BOT_LOCAL_FLOOR).toBe(MAIN_LOCAL_FLOOR)
  })
})
