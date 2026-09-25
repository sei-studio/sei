// Runtime lifecycle against the fake mod (scripts/fake-stardew-mod.mjs):
// connect + spawn + brain start + summon-ready, the refused-spawn and
// unreachable-port terminal paths, the token failure, reconnect after a drop
// with the world still open, terminal after a drop with the world gone,
// and stop() despawning. No Electron, no game.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeMod } from '../../../../scripts/fake-stardew-mod.mjs'
import { createRuntime, adapterConfigFrom, checkJoinTarget, botUsernameFor, connectTimeoutFor, spawnErrorMessage } from './runtime.js'
import { ConfigSchema } from '../../config.js'
import { ACTION_RULES, ACTION_RULES_LEGACY } from './prompts.js'

const quiet = { info: () => {}, warn: () => {}, error: () => {} }

function configFor(port, token = 'test-token') {
  return ConfigSchema.parse({
    player_username: 'Ouen',
    persona: { name: 'Sui', expanded: 'x' },
    anthropic: { api_key: 'k' },
    adapter: { kind: 'stardew', stardew: { ...adapterConfigFrom({ joinTarget: { port, token }, botUsername: 'Sui' }), reconnect_delay_ms: 50 } },
  })
}

function hooksWith(overrides = {}) {
  const brain = { stop: vi.fn(async () => {}), setCompanions: vi.fn() }
  const hooks = {
    logger: quiet,
    summonDeadlineAt: Date.now() + 8000,
    createBrain: vi.fn(async (adapter) => {
      // The real brain calls attach; a fake does too so the spawn signal lands.
      adapter.attach({ onSpawn: vi.fn(), onChat: vi.fn(), onAttacked: vi.fn(), onDeath: vi.fn(), onPlayerJoined: vi.fn(), onPlayerLeft: vi.fn() })
      return brain
    }),
    onBrainReady: vi.fn(),
    onBrainLost: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onError: vi.fn(),
    onDashboard: vi.fn(),
    emitVisionCapability: vi.fn(),
    connectTimeoutMs: 3000,
    ...overrides,
  }
  return { hooks, brain }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, ms = 3000) {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await wait(20)
  }
}

describe('stardew runtime helpers', () => {
  it('names the body from the persona, builds the adapter block, and refuses an empty join target', () => {
    expect(botUsernameFor({ name: 'Sui!' })).toBe('Sui')
    expect(botUsernameFor({ username: 'Marv_2', name: 'x' })).toBe('Marv_2')
    expect(botUsernameFor({})).toBe('Sei')
    expect(adapterConfigFrom({ joinTarget: { port: 1, token: 't' }, botUsername: 'Sui' })).toEqual({ host: 'localhost', port: 1, token: 't', username: 'Sui' })
    expect(checkJoinTarget(null)?.error).toBe('GAME_WORLD_NOT_OPEN')
    expect(checkJoinTarget({ port: 1 })?.error).toBe('GAME_WORLD_NOT_OPEN')
    expect(checkJoinTarget({ port: 1, token: 't' })).toBeNull()
    expect(connectTimeoutFor(null)).toBe(20_000)
    expect(connectTimeoutFor(Date.now() + 30_000)).toBeGreaterThan(25_000)
    expect(connectTimeoutFor(Date.now() + 1000)).toBe(5000)
    expect(spawnErrorMessage('NO_SAVE')).toMatch(/^GAME_WORLD_NOT_OPEN/)
    expect(spawnErrorMessage('FARMHAND_NO_MOD')).toMatch(/^STARDEW_FARMHAND_NO_MOD/)
  })
})

describe('stardew runtime against the fake mod', () => {
  let mod
  afterEach(async () => { if (mod) await mod.close(); mod = null })

  it('gives the model the held-follow rule only when the mod reports 0.1.2 or later', async () => {
    mod = createFakeMod({ modVersion: '0.1.2' })
    const port = await mod.ready
    const { hooks } = hooksWith()
    const handle = await createRuntime(configFor(port), hooks)
    expect(hooks.onError).not.toHaveBeenCalled()
    expect(handle.adapter.actionRules()).toBe(ACTION_RULES)
    await handle.stop()
  })

  it('connects, spawns, starts the brain, fires onConnected once, streams observations, runs a verb, and despawns on stop', async () => {
    mod = createFakeMod({ obsHz: 10 })
    const port = await mod.ready
    const { hooks, brain } = hooksWith()
    const handle = await createRuntime(configFor(port), hooks)
    expect(hooks.onError).not.toHaveBeenCalled()
    expect(hooks.onConnected).toHaveBeenCalledTimes(1)
    expect(hooks.onBrainReady).toHaveBeenCalledWith(brain)
    expect(mod.state.bodies.has('Sui')).toBe(true)
    const adapter = handle.adapter
    expect(adapter.botUsername).toBe('Sui')
    expect(adapter.gameName).toBe('Stardew Valley')
    // The first observation was fetched on demand before the brain started.
    expect(adapter.getLatestObservation()?.location).toBe('Farm')
    expect(adapter.getWorldIdentity()).toEqual({ fingerprint: 'stardew:123456789', label: 'Sunny Farm' })
    expect(Object.keys(adapter.getKnownPlayers())).toEqual(['Ouen'])
    // The fake mod reports 0.1.0: the follow rule is the one that mod keeps.
    expect(adapter.actionRules()).toBe(ACTION_RULES_LEGACY)
    // A verb round-trips to the mod and returns its detail string.
    const out = await adapter.executeAction('water', {}, { signal: new AbortController().signal })
    expect(out).toBe('watered 12 crops (18/40 left in the can)')
    const bad = await adapter.executeAction('till', { x: 1, y: 2 }, {})
    expect(bad).toBe('tilled (1,2)')
    // say() reaches the mod.
    adapter.chat('hello there')
    adapter.chat('/kick everyone')
    await until(() => mod.state.said.length === 1)
    expect(mod.state.said).toEqual(['hello there'])
    // Telemetry streams while watched.
    handle.setDashboardWatch(true)
    await until(() => hooks.onDashboard.mock.calls.length > 0)
    expect(hooks.onDashboard.mock.calls[0][0]).toMatchObject({ game: 'stardew', location: 'Farm' })
    handle.setDashboardWatch(false)
    await handle.stop()
    expect(brain.stop).toHaveBeenCalled()
    expect(hooks.onBrainLost).toHaveBeenCalled()
    expect(mod.state.frames.some((f) => f.t === 'despawn')).toBe(true)
    expect(hooks.onConnected).toHaveBeenCalledTimes(1)
  })

  it('ships the appearance in the spawn frame when main sent one, and no field at all when it did not (260921)', async () => {
    const look = { gender: 'female', skin: 3, hair: 26, hairColor: '#c0c8ff', eyeColor: '#6a4cff', shirt: 1016, pants: 2, pantsColor: '#1b1b3a', accessory: -1 }
    expect(adapterConfigFrom({ joinTarget: { port: 1, token: 't', appearance: look }, botUsername: 'Sui' }).appearance).toEqual(look)
    mod = createFakeMod()
    const port = await mod.ready
    const config = ConfigSchema.parse({
      player_username: 'Ouen',
      persona: { name: 'Sui', expanded: 'x' },
      anthropic: { api_key: 'k' },
      adapter: { kind: 'stardew', stardew: { ...adapterConfigFrom({ joinTarget: { port, token: 'test-token', appearance: look }, botUsername: 'Sui' }), reconnect_delay_ms: 50 } },
    })
    const { hooks } = hooksWith()
    const handle = await createRuntime(config, hooks)
    expect(mod.state.frames.find((f) => f.t === 'spawn')).toMatchObject({ name: 'Sui', appearance: look })
    expect(mod.state.bodies.get('Sui').appearance).toEqual(look)
    await handle.stop()
    await mod.close()

    // No appearance from main (old app, first-summon timeout): the frame has
    // no such key, so the mod's own default is the only default there is.
    mod = createFakeMod()
    const port2 = await mod.ready
    const { hooks: hooks2 } = hooksWith()
    const handle2 = await createRuntime(configFor(port2), hooks2)
    expect('appearance' in mod.state.frames.find((f) => f.t === 'spawn')).toBe(false)
    await handle2.stop()

    // A malformed block never fails the bot config; it is dropped.
    const bad = ConfigSchema.parse({
      player_username: 'Ouen', persona: { name: 'Sui', expanded: 'x' }, anthropic: { api_key: 'k' },
      adapter: { kind: 'stardew', stardew: { ...adapterConfigFrom({ joinTarget: { port: 1, token: 't', appearance: { hair: 'long' } }, botUsername: 'Sui' }) } },
    })
    expect(bad.adapter.stardew.appearance).toBeUndefined()
  })

  it('aborting a running verb sends cancel and resolves "aborted"', async () => {
    mod = createFakeMod({ commandDelayMs: 500 })
    const port = await mod.ready
    const { hooks } = hooksWith()
    const handle = await createRuntime(configFor(port), hooks)
    const ctrl = new AbortController()
    const p = handle.adapter.executeAction('gather', { kind: 'wood', count: 3 }, { signal: ctrl.signal })
    await wait(50)
    ctrl.abort()
    expect(await p).toBe('aborted')
    await until(() => mod.state.frames.some((f) => f.t === 'cancel'))
    await handle.stop()
  })

  it('reports GAME_WORLD_NOT_OPEN at once when the mod has no save loaded (no retry loop)', async () => {
    mod = createFakeMod({ saveLoaded: false })
    const port = await mod.ready
    const { hooks } = hooksWith()
    await createRuntime(configFor(port), hooks)
    expect(hooks.onError).toHaveBeenCalledTimes(1)
    expect(hooks.onError.mock.calls[0][0].error).toBe('GAME_WORLD_NOT_OPEN')
    expect(hooks.onConnected).not.toHaveBeenCalled()
    expect(mod.state.frames.filter((f) => f.t === 'spawn')).toHaveLength(1)
  })

  it('maps a farmhand-without-mod refusal to STARDEW_FARMHAND_NO_MOD', async () => {
    mod = createFakeMod({ spawnError: 'FARMHAND_NO_MOD' })
    const port = await mod.ready
    const { hooks } = hooksWith()
    await createRuntime(configFor(port), hooks)
    expect(hooks.onError.mock.calls[0][0].error).toBe('STARDEW_FARMHAND_NO_MOD')
  })

  it('gives up after 3 attempts on a dead port with GAME_NOT_ANSWERING', async () => {
    const { hooks } = hooksWith()
    // Bind then release a port so nothing listens there.
    const probe = createFakeMod({})
    const port = await probe.ready
    await probe.close()
    await createRuntime(configFor(port), hooks)
    expect(hooks.onError).toHaveBeenCalledTimes(1)
    expect(hooks.onError.mock.calls[0][0].error).toBe('GAME_NOT_ANSWERING')
    expect(hooks.onDisconnected.mock.calls.filter((c) => c[0].willRetry).length).toBe(2)
  })

  it('a wrong token is terminal on the first attempt', async () => {
    mod = createFakeMod({ token: 'real' })
    const port = await mod.ready
    const { hooks } = hooksWith()
    await createRuntime(configFor(port, 'wrong'), hooks)
    expect(hooks.onError).toHaveBeenCalledTimes(1)
    expect(hooks.onError.mock.calls[0][0].error).toBe('GAME_NOT_ANSWERING')
    expect(hooks.onError.mock.calls[0][0].message).toMatch(/token/)
  })

  it('reconnects and re-adopts the body after a drop while the farm is still open, without a second summon-ready', async () => {
    mod = createFakeMod({ dropAfterMs: 150, obsHz: 0 })
    const port = await mod.ready
    const { hooks } = hooksWith()
    const handle = await createRuntime(configFor(port), hooks)
    expect(hooks.onConnected).toHaveBeenCalledTimes(1)
    mod.state.dropAfterMs = 0
    await until(() => hooks.onBrainLost.mock.calls.length >= 1)
    await until(() => hooks.onBrainReady.mock.calls.length >= 2, 4000)
    expect(hooks.onDisconnected).toHaveBeenCalledWith(expect.objectContaining({ willRetry: true }))
    expect(hooks.onError).not.toHaveBeenCalled()
    expect(hooks.onConnected).toHaveBeenCalledTimes(1)
    expect(mod.state.frames.filter((f) => f.t === 'spawn')).toHaveLength(2)
    expect(handle.adapter).not.toBeNull()
    await handle.stop()
  })

  it('a drop with the mod gone is terminal GAME_WORLD_NOT_OPEN', async () => {
    mod = createFakeMod({ obsHz: 0 })
    const port = await mod.ready
    const { hooks } = hooksWith()
    await createRuntime(configFor(port), hooks)
    await mod.close()
    mod = null
    await until(() => hooks.onError.mock.calls.length >= 1, 4000)
    expect(hooks.onError.mock.calls[0][0].error).toBe('GAME_WORLD_NOT_OPEN')
    expect(hooks.onDisconnected).toHaveBeenLastCalledWith(expect.objectContaining({ willRetry: false }))
  })
})
