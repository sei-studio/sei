// 260816 (china-compat W2): pins the init-payload → config.llm mapping. The
// latent bug this guards against: UserConfig.provider was written by Settings
// and read by nothing, so every bot session ran Anthropic. applyLlmInit is the
// seam where the supervisor's `llm` init section becomes the bot's
// ConfigSchema llm sub-tree.

import { describe, it, expect } from 'vitest'
import { applyLlmInit, applyLlmSwitch } from './llmInit.js'
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

// ─── applyLlmSwitch (260828: mid-session backend-switch fold-in) ───────────

// A PARSED cloud-proxy session config (what a live cloud bot holds).
const cloudCfg = () =>
  ConfigSchema.parse(rawFor({
    anthropic: { api_key: '', cloudMode: { baseURL: 'https://api.sei.gg', authToken: 'jwt' } },
  }))

// A PARSED local session config on a given provider.
const localCfg = (llm) =>
  ConfigSchema.parse(applyLlmInit(rawFor(), llm, llm?.api_key ?? 'sk-byok'))

describe('applyLlmSwitch', () => {
  it('cloud→local reroutes to the configured provider (the BYOK-switch fix)', () => {
    const cfg = cloudCfg()
    const kind = applyLlmSwitch(cfg, {
      api_key: 'sk-local',
      llm: { provider: 'openai', model: 'gpt-5-mini', api_key: 'sk-local' },
    })
    expect(kind).toBe('openai')
    expect(cfg.anthropic.cloudMode).toBeUndefined()
    expect(cfg.anthropic.api_key).toBe('sk-local')
    expect(cfg.llm.provider).toBe('openai')
    expect(cfg.llm.providers.openai).toMatchObject({ api_key: 'sk-local', model: 'gpt-5-mini' })
    // Live knobs on config.llm survive (merged, never replaced wholesale).
    expect(cfg.llm.rate_limit_per_min).toBe(30)
    expect(cfg.llm.providers.deepseek).toBeDefined()
  })

  it('cloud→local with no llm section (older main) falls to the anthropic BYOK path', () => {
    const cfg = cloudCfg()
    const kind = applyLlmSwitch(cfg, { api_key: 'sk-local' })
    expect(kind).toBe('anthropic')
    expect(cfg.anthropic.cloudMode).toBeUndefined()
    expect(cfg.anthropic.api_key).toBe('sk-local')
    expect(cfg.llm.provider).toBe('anthropic')
  })

  it('local(non-anthropic)→cloud forces the anthropic+cloudMode path', () => {
    const cfg = localCfg({ provider: 'openai', model: 'gpt-5-mini', api_key: 'ok' })
    expect(cfg.llm.provider).toBe('openai')
    const kind = applyLlmSwitch(cfg, {
      cloudMode: { baseURL: 'https://api.sei.gg', authToken: 'jwt2' },
    })
    expect(kind).toBe('anthropic')
    expect(cfg.llm.provider).toBe('anthropic')
    expect(cfg.anthropic.cloudMode).toEqual({ baseURL: 'https://api.sei.gg', authToken: 'jwt2' })
    expect(cfg.anthropic.api_key).toBe('')
    // The openai block is untouched — a later switch back to local reuses it.
    expect(cfg.llm.providers.openai.model).toBe('gpt-5-mini')
  })

  it('anthropic target applies the model onto config.anthropic, never config.llm.providers', () => {
    const cfg = cloudCfg()
    const kind = applyLlmSwitch(cfg, {
      api_key: 'sk-a',
      llm: { provider: 'anthropic', model: 'claude-sonnet-4-5', api_key: 'sk-a' },
    })
    expect(kind).toBe('anthropic')
    expect(cfg.anthropic.model).toBe('claude-sonnet-4-5')
    expect(cfg.llm.provider).toBe('anthropic')
  })

  it('unknown provider falls to anthropic instead of throwing (no parse safety net at runtime)', () => {
    const cfg = cloudCfg()
    expect(applyLlmSwitch(cfg, { api_key: 'k', llm: { provider: 'palantir', api_key: 'k' } })).toBe('anthropic')
    expect(cfg.llm.provider).toBe('anthropic')
  })

  it('junk base_url is dropped (provider default base applies)', () => {
    const cfg = cloudCfg()
    applyLlmSwitch(cfg, { api_key: 'k', llm: { provider: 'openai', base_url: 'not a url', api_key: 'k' } })
    expect(cfg.llm.providers.openai.base_url).toBeUndefined()
  })

  it('ollama gets no api_key field and works with an empty key', () => {
    const cfg = cloudCfg()
    const kind = applyLlmSwitch(cfg, { api_key: '', llm: { provider: 'ollama', model: 'llama3.1' } })
    expect(kind).toBe('ollama')
    expect(cfg.llm.providers.ollama.api_key).toBeUndefined()
    expect(cfg.llm.providers.ollama.model).toBe('llama3.1')
  })

  it('llm.api_key falls back to the top-level api_key', () => {
    const cfg = cloudCfg()
    applyLlmSwitch(cfg, { api_key: 'sk-top', llm: { provider: 'grok' } })
    expect(cfg.llm.providers.grok.api_key).toBe('sk-top')
  })
})
