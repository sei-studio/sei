// 260816 (china-compat W2): pins the init-payload → config.llm mapping. The
// latent bug this guards against: UserConfig.provider was written by Settings
// and read by nothing, so every bot session ran Anthropic. applyLlmInit is the
// seam where the supervisor's `llm` init section becomes the bot's
// ConfigSchema llm sub-tree.

import { describe, it, expect } from 'vitest'
import { applyLlmInit } from './llmInit.js'
import { ConfigSchema } from './config.js'

// Minimal ConfigSchema-valid raw config (BYOK shape, mirrors bootstrapWithInit).
const rawFor = (over = {}) => ({
  player_username: 'Player',
  persona: { name: 'Sui', expanded: 'x' },
  anthropic: { api_key: 'sk-byok' },
  adapter: {
    kind: 'minecraft',
    minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: 'Sui' },
  },
  ...over,
})

describe('applyLlmInit', () => {
  it('maps provider + model + base_url + api_key into config.llm and survives ConfigSchema.parse', () => {
    const out = applyLlmInit(rawFor(), {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-byok',
    }, 'sk-byok')
    const cfg = ConfigSchema.parse(out)
    expect(cfg.llm.provider).toBe('deepseek')
    expect(cfg.llm.providers.deepseek).toMatchObject({
      api_key: 'sk-byok',
      model: 'deepseek-v4-pro',
      base_url: 'https://api.deepseek.com/v1',
    })
  })

  it('qwen with no overrides falls to the schema default model qwen-plus', () => {
    const out = applyLlmInit(rawFor(), { provider: 'qwen', api_key: 'qk' }, 'qk')
    const cfg = ConfigSchema.parse(out)
    expect(cfg.llm.provider).toBe('qwen')
    expect(cfg.llm.providers.qwen.model).toBe('qwen-plus')
    expect(cfg.llm.providers.qwen.api_key).toBe('qk')
  })

  it('falls back to the top-level apiKey when llm.api_key is absent', () => {
    const out = applyLlmInit(rawFor(), { provider: 'openai' }, 'sk-top')
    expect(out.llm.providers.openai.api_key).toBe('sk-top')
  })

  it('anthropic provider keeps the anthropic path and honors a model override', () => {
    const out = applyLlmInit(rawFor(), { provider: 'anthropic', model: 'claude-sonnet-4-5', api_key: 'sk-byok' }, 'sk-byok')
    expect(out.llm).toBeUndefined() // Zod default fills → provider 'anthropic'
    expect(out.anthropic.model).toBe('claude-sonnet-4-5')
    const cfg = ConfigSchema.parse(out)
    expect(cfg.llm.provider).toBe('anthropic')
  })

  it('cloud-proxy sessions (anthropic.cloudMode) are never rerouted', () => {
    const raw = rawFor({
      anthropic: { api_key: '', cloudMode: { baseURL: 'https://api.sei.gg', authToken: 'jwt' } },
    })
    const out = applyLlmInit(raw, { provider: 'deepseek', api_key: 'dk' }, 'dk')
    expect(out.llm).toBeUndefined()
    expect(ConfigSchema.parse(out).llm.provider).toBe('anthropic')
  })

  it('absent llm section (older main) leaves the config untouched', () => {
    const out = applyLlmInit(rawFor(), undefined, 'sk-byok')
    expect(out.llm).toBeUndefined()
    expect(ConfigSchema.parse(out).llm.provider).toBe('anthropic')
  })

  it('unknown provider falls to the anthropic default instead of failing the parse', () => {
    const out = applyLlmInit(rawFor(), { provider: 'palantir', api_key: 'k' }, 'k')
    expect(out.llm).toBeUndefined()
    expect(ConfigSchema.parse(out).llm.provider).toBe('anthropic')
  })

  it('a junk base_url is dropped rather than failing ConfigSchema', () => {
    const out = applyLlmInit(rawFor(), { provider: 'openai', base_url: 'not a url', api_key: 'k' }, 'k')
    expect(out.llm.providers.openai.base_url).toBeUndefined()
    expect(() => ConfigSchema.parse(out)).not.toThrow()
  })

  it('ollama gets model/base_url but no api_key field', () => {
    const out = applyLlmInit(rawFor(), {
      provider: 'ollama',
      model: 'llama3.1',
      base_url: 'http://localhost:11434',
    }, 'sk-unused')
    expect(out.llm.providers.ollama).toEqual({ model: 'llama3.1', base_url: 'http://localhost:11434' })
    const cfg = ConfigSchema.parse(out)
    expect(cfg.llm.provider).toBe('ollama')
  })

  it('grandfathered providers still map (mistral)', () => {
    const out = applyLlmInit(rawFor(), { provider: 'mistral', api_key: 'mk' }, 'mk')
    const cfg = ConfigSchema.parse(out)
    expect(cfg.llm.provider).toBe('mistral')
    expect(cfg.llm.providers.mistral.api_key).toBe('mk')
  })
})
