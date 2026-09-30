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
} from '../shared/llmCatalog'
import { ConfigSchema, LLM_PROVIDER_KINDS } from './config.js'
import { BASE_URLS } from './brain/llm/index.js'
import { COMPAT_DEFAULT_MODELS } from './brain/llm/openaiCompatProvider.js'

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
})
