// 260828 (BYOK-switch fix): orchestrator.setBackend must REBUILD the live
// provider through the factory when a mid-session backend switch changes the
// provider kind. Before this, setBackend delegated straight to the provider's
// own setBackend — which only the Anthropic provider implements — so:
//   - a cloud→local switch DROPPED the configured non-Anthropic provider
//     (the bot silently kept running Anthropic with stale defaults), and
//   - a local non-Anthropic session switching to cloud no-op'd entirely
//     (kept routing BYOK instead of the proxy).
// These tests run a REAL orchestrator + REAL provider factory (no network —
// nothing is dispatched) against a mock adapter.

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator } from './orchestrator.js'
import { ConfigSchema } from '../config.js'
import { applyLlmInit } from '../llmInit.js'

function makeAdapter() {
  const ACTIONS = ['follow', 'unfollow', 'goTo', 'gather', 'dig']
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: () => Promise.resolve('done'),
  }
}

const rawBase = (anthropic) => ({
  player_username: 'Steve',
  persona: { name: 'Sui', expanded: 'A sharp little companion.' },
  anthropic,
  adapter: {
    kind: 'minecraft',
    minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: 'Sui' },
  },
})

// A parsed CLOUD-PROXY session config (what a live cloud bot holds).
const cloudConfig = () =>
  ConfigSchema.parse(rawBase({
    api_key: '',
    cloudMode: { baseURL: 'https://api.sei.gg', authToken: 'jwt' },
  }))

// A parsed LOCAL session config already on a non-Anthropic provider.
const localOpenaiConfig = () =>
  ConfigSchema.parse(applyLlmInit(
    rawBase({ api_key: 'sk-local' }),
    { provider: 'openai', model: 'gpt-5-mini', api_key: 'sk-local' },
    'sk-local',
  ))

describe('orchestrator.setBackend — provider rebuild on kind change', () => {
  it('cloud→local reroutes onto the configured provider and re-renders the system blocks', () => {
    const config = cloudConfig()
    const orch = createOrchestrator({ adapter: makeAdapter(), config })
    expect(orch._internal.anthropic.kind).toBe('anthropic')
    // Anthropic buildCachedSystem stamps cache_control on the last block.
    const before = orch._internal.getCachedSystemBlocks()
    expect(before.at(-1).cache_control).toEqual({ type: 'ephemeral' })

    orch.setBackend({
      api_key: 'sk-local',
      llm: { provider: 'openai', model: 'gpt-5-mini', api_key: 'sk-local' },
    })

    expect(orch._internal.anthropic.kind).toBe('openai')
    expect(orch._internal.anthropic.model).toBe('gpt-5-mini')
    expect(config.anthropic.cloudMode).toBeUndefined()
    expect(config.llm.provider).toBe('openai')
    // The cached system was rebuilt by the NEW provider (openai-compat emits
    // no cache_control marker — proves the blocks are not the stale set).
    const after = orch._internal.getCachedSystemBlocks()
    expect(after.at(-1).cache_control).toBeUndefined()
  })

  it('local(non-anthropic)→cloud rebuilds back onto the anthropic proxy path', () => {
    const config = localOpenaiConfig()
    const orch = createOrchestrator({ adapter: makeAdapter(), config })
    expect(orch._internal.anthropic.kind).toBe('openai')

    orch.setBackend({ cloudMode: { baseURL: 'https://api.sei.gg', authToken: 'jwt2' } })

    expect(orch._internal.anthropic.kind).toBe('anthropic')
    expect(config.llm.provider).toBe('anthropic')
    expect(config.anthropic.cloudMode).toEqual({ baseURL: 'https://api.sei.gg', authToken: 'jwt2' })
    expect(orch._internal.getCachedSystemBlocks().at(-1).cache_control).toEqual({ type: 'ephemeral' })
  })

  it('a rebuild failure (missing key for the target provider) still leaves the cloud path — falls back to anthropic BYOK', () => {
    const config = cloudConfig()
    const orch = createOrchestrator({ adapter: makeAdapter(), config, logger: { warn: () => {}, log: () => {}, error: () => {} } })

    // openai-compat throws at construction without an api_key. The dominant
    // safety property: the old cloud-wired instance must NOT survive.
    orch.setBackend({ api_key: '', llm: { provider: 'openai', api_key: '' } })

    expect(config.anthropic.cloudMode).toBeUndefined()
    expect(orch._internal.anthropic.kind).toBe('anthropic')
    expect(config.llm.provider).toBe('anthropic')
  })

  it('anthropic→anthropic keeps the SAME provider instance (in-place SDK flip preserves cache identity)', () => {
    const config = cloudConfig()
    const orch = createOrchestrator({ adapter: makeAdapter(), config })
    const instance = orch._internal.anthropic
    orch.setBackend({ api_key: 'sk-local' }) // no llm section → anthropic path
    expect(orch._internal.anthropic).toBe(instance)
    expect(config.anthropic.cloudMode).toBeUndefined()
    expect(config.anthropic.api_key).toBe('sk-local')
  })

  it('the harness override seam still routes an anthropic-shaped switch to the override', () => {
    const setBackend = vi.fn()
    const override = {
      call: async () => ({ text: '', toolUses: [] }),
      buildCachedSystem: (blocks) => blocks,
      setAuthToken() {},
      setBackend,
    }
    const config = cloudConfig()
    const orch = createOrchestrator({ adapter: makeAdapter(), config, _anthropicOverride: override })
    orch.setBackend({ api_key: 'sk' })
    expect(setBackend).toHaveBeenCalledWith({ api_key: 'sk' })
    expect(orch._internal.anthropic).toBe(override)
  })
})
