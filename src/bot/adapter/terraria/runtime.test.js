// Terraria runtime + adapter against the fake mod (scripts/fake-terraria-mod.mjs):
// connect, spawn, brain start, verbs with progress, say, pause, telemetry,
// the terminal spawn refusals, the token failure, reconnect after a drop,
// and the world-closed end. No game, no Electron.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createFakeTerrariaMod } from '../../../../scripts/fake-terraria-mod.mjs'
import { createRuntime, adapterConfigFrom, checkJoinTarget, botUsernameFor, connectTimeoutFor, spawnErrorMessage } from './runtime.js'
import { progressFromText } from './index.js'
import { classifyConnectError } from './errors.js'
import { ConfigSchema } from '../../config.js'

const quiet = { info: () => {}, warn: () => {}, error: () => {} }

function configFor(port, token = 'test-token', extra = {}) {
  return ConfigSchema.parse({
    player_username: 'Ouen',
    persona: { name: 'Sui', expanded: 'x' },
    anthropic: { api_key: 'k' },
    adapter: { kind: 'terraria', terraria: { ...adapterConfigFrom({ joinTarget: { port, token, ...extra }, botUsername: 'Sui' }), reconnect_delay_ms: 50 } },
  })
}

function hooksWith(overrides = {}) {
  const brain = { stop: vi.fn(async () => {}) }
  const hooks = {
    logger: quiet,
    summonDeadlineAt: Date.now() + 8000,
    createBrain: vi.fn(async (adapter) => {
      adapter.attach({ onSpawn: vi.fn(), onChat: vi.fn(), onAttacked: vi.fn(), onDeath: vi.fn(), onPlayerJoined: vi.fn(), onPlayerLeft: vi.fn() })
      return brain
    }),
    onBrainReady: vi.fn(),
    onBrainLost: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onError: vi.fn(),
    onDashboard: vi.fn(),
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

describe('terraria runtime helpers', () => {
  it('names the body, builds the adapter block, refuses an empty join target, and maps errors', () => {
    expect(botUsernameFor({ name: 'Sui' })).toBe('Sui')
    expect(botUsernameFor({ username: ' Marv ', name: 'x' })).toBe('Marv')
    expect(botUsernameFor({ name: '[Sui]<x>' })).toBe('Suix')
    expect(botUsernameFor({ name: 'A very long companion name here' })).toHaveLength(20)
    expect(botUsernameFor({})).toBe('Sei')
    expect(adapterConfigFrom({ joinTarget: { port: 1, token: 't' }, botUsername: 'Sui' })).toEqual({ host: 'localhost', port: 1, token: 't', username: 'Sui' })
    expect(adapterConfigFrom({ joinTarget: { port: 1, token: 't', owner: 'Ouen', appearance: { hair: 2 } }, botUsername: 'Sui' })).toMatchObject({ owner: 'Ouen', appearance: { hair: 2 } })
    expect(checkJoinTarget(null)?.error).toBe('GAME_WORLD_NOT_OPEN')
    expect(checkJoinTarget({ port: 1 })?.error).toBe('GAME_WORLD_NOT_OPEN')
    expect(checkJoinTarget({ port: 1, token: 't' })).toBeNull()
    expect(connectTimeoutFor(null)).toBe(20_000)
    expect(connectTimeoutFor(Date.now() + 1000)).toBe(5000)
    expect(spawnErrorMessage('NO_WORLD')).toMatch(/^GAME_WORLD_NOT_OPEN/)
    expect(spawnErrorMessage('NOT_HOST')).toMatch(/^GAME_WORLD_NOT_OPEN/)
    expect(spawnErrorMessage('NO_SLOT')).toMatch(/^GAME_NOT_ANSWERING/)
    expect(classifyConnectError('GAME_VERSION_UNSUPPORTED: x')).toBe('GAME_VERSION_UNSUPPORTED')
    expect(progressFromText('mined 3/5')).toEqual({ dug: 3, total: 5 })
    expect(progressFromText('chopped 1/2')).toEqual({ dug: 1, total: 2 })
    expect(progressFromText('walking to the Work Bench')).toBeNull()
  })
})

describe('terraria runtime against the fake mod', () => {
  let mod
  afterEach(async () => { if (mod) await mod.close(); mod = null })

  it('connects, spawns with looks and owner, runs verbs with progress, talks, pauses, streams telemetry, and despawns', async () => {
    mod = createFakeTerrariaMod({ obsHz: 10 })
    const port = await mod.ready
    const { hooks, brain } = hooksWith()
    const handle = await createRuntime(configFor(port, 'test-token', { owner: 'Ouen', appearance: { hair: 5, hairColor: '#ffffff' } }), hooks)
    expect(hooks.onError).not.toHaveBeenCalled()
    expect(hooks.onConnected).toHaveBeenCalledTimes(1)
    expect(hooks.onBrainReady).toHaveBeenCalledWith(brain)
    expect(mod.state.frames.find((f) => f.t === 'spawn')).toMatchObject({ name: 'Sui', owner: 'Ouen', appearance: { hair: 5 } })

    const a = handle.adapter
    expect(a.gameName).toBe('Terraria')
    expect(a.backgroundActions).toEqual({ follow: 'unfollow' })
    expect(a.listActions()).toHaveLength(14)
    expect(a.getLatestObservation()?.self?.name).toBe('Sui')
    expect(a.getWorldIdentity()).toEqual({ fingerprint: 'terraria:d8967c12-0000-4121-bda2-207c9a551c95', label: 'SeiSpike' })
    expect(Object.keys(a.getKnownPlayers())).toEqual(['Ouen'])
    expect(a.carriedCounts(['Wood', 'Gel'])).toEqual({ Wood: 45, Gel: 0 })
    expect(a.createSnapshotComposer().next()).toContain('owner Ouen')

    const onProgress = vi.fn()
    expect(await a.executeAction('mine', { block: 'Dirt Block', count: 5 }, { onProgress })).toBe('mined 5/5: got Dirt Block x5')
    expect(onProgress).toHaveBeenCalledWith({ dug: 1, total: 5 })
    expect(mod.state.frames.find((f) => f.t === 'cmd' && f.name === 'mine').args).toEqual({ block: 'Dirt Block', count: 5 })
    const gave = await a.executeAction('give', { item: 'Wood', count: 10 }, {})
    expect(a.handOverResult('give', gave)).toBe(true)
    expect(a.handOverDetail('give', gave)).toEqual({ item: 'Wood', n: 10, to: 'Ouen' })
    expect(a.handOverResult('give', 'failed: no Wood in my bag')).toBe(false)

    a.chat('hello there')
    a.chat('/kill')
    await until(() => mod.state.said.length === 1)
    expect(mod.state.said).toEqual(['hello there'])

    a.setWorldPaused(true)
    expect(await a.executeAction('come', {}, {})).toMatch(/^paused/)
    await until(() => mod.state.paused === true)
    a.setWorldPaused(false)

    handle.setDashboardWatch(true)
    await until(() => hooks.onDashboard.mock.calls.length > 0)
    expect(hooks.onDashboard.mock.calls[0][0]).toMatchObject({ game: 'terraria', health: 100, stance: 'defensive' })
    handle.setDashboardWatch(false)

    await handle.stop()
    expect(brain.stop).toHaveBeenCalled()
    expect(mod.state.frames.some((f) => f.t === 'despawn')).toBe(true)
  })

  it('aborting a running verb sends cancel and resolves "aborted"', async () => {
    mod = createFakeTerrariaMod({ commandDelayMs: 500 })
    const port = await mod.ready
    const { hooks } = hooksWith()
    const handle = await createRuntime(configFor(port), hooks)
    const ctrl = new AbortController()
    const p = handle.adapter.executeAction('chop', {}, { signal: ctrl.signal })
    await wait(50)
    ctrl.abort()
    expect(await p).toBe('aborted')
    await until(() => mod.state.frames.some((f) => f.t === 'cancel'))
    await handle.stop()
  })

  it('no world loaded or a joined client is GAME_WORLD_NOT_OPEN at once, with one spawn try', async () => {
    for (const opts of [{ worldLoaded: false }, { role: 'client' }]) {
      mod = createFakeTerrariaMod(opts)
      const port = await mod.ready
      const { hooks } = hooksWith()
      await createRuntime(configFor(port), hooks)
      expect(hooks.onError).toHaveBeenCalledTimes(1)
      expect(hooks.onError.mock.calls[0][0].error).toBe('GAME_WORLD_NOT_OPEN')
      expect(hooks.onConnected).not.toHaveBeenCalled()
      expect(mod.state.frames.filter((f) => f.t === 'spawn')).toHaveLength(1)
      await mod.close()
      mod = null
    }
  })

  it('a wrong token is terminal and says so', async () => {
    mod = createFakeTerrariaMod({ token: 'real' })
    const port = await mod.ready
    const { hooks } = hooksWith()
    await createRuntime(configFor(port, 'wrong'), hooks)
    expect(hooks.onError).toHaveBeenCalledTimes(1)
    expect(hooks.onError.mock.calls[0][0].error).toBe('GAME_NOT_ANSWERING')
    expect(hooks.onError.mock.calls[0][0].message).toMatch(/token/)
  })

  it('gives up after 3 attempts on a dead port', async () => {
    const probe = createFakeTerrariaMod({})
    const port = await probe.ready
    await probe.close()
    const { hooks } = hooksWith()
    await createRuntime(configFor(port), hooks)
    expect(hooks.onError).toHaveBeenCalledTimes(1)
    expect(hooks.onError.mock.calls[0][0].error).toBe('GAME_NOT_ANSWERING')
    expect(hooks.onDisconnected.mock.calls.filter((c) => c[0].willRetry).length).toBe(2)
  })

  it('reconnects after a drop while the world is open, without a second summon-ready', async () => {
    mod = createFakeTerrariaMod({ obsHz: 0 })
    const port = await mod.ready
    const { hooks } = hooksWith()
    const handle = await createRuntime(configFor(port), hooks)
    mod.dropClients()
    await until(() => hooks.onBrainLost.mock.calls.length >= 1)
    await until(() => hooks.onBrainReady.mock.calls.length >= 2, 4000)
    expect(hooks.onDisconnected).toHaveBeenCalledWith(expect.objectContaining({ willRetry: true }))
    expect(hooks.onError).not.toHaveBeenCalled()
    expect(hooks.onConnected).toHaveBeenCalledTimes(1)
    expect(mod.state.frames.filter((f) => f.t === 'spawn')).toHaveLength(2)
    await handle.stop()
  })

  it('a drop with the world closed is terminal GAME_WORLD_NOT_OPEN with endReason world_closed', async () => {
    mod = createFakeTerrariaMod({ obsHz: 0 })
    const port = await mod.ready
    const { hooks } = hooksWith()
    await createRuntime(configFor(port), hooks)
    mod.state.worldLoaded = false
    mod.dropClients()
    await until(() => hooks.onError.mock.calls.length >= 1, 4000)
    expect(hooks.onError.mock.calls[0][0]).toMatchObject({ error: 'GAME_WORLD_NOT_OPEN', endReason: 'world_closed' })
    expect(hooks.onDisconnected).toHaveBeenLastCalledWith(expect.objectContaining({ willRetry: false }))
  })
})

describe('terraria session stats', () => {
  let mod
  afterEach(async () => { if (mod) await mod.close(); mod = null })

  it('counts verbs by outcome and reflexes, and posts the final snapshot on stop', async () => {
    mod = createFakeTerrariaMod({ obsHz: 0 })
    const port = await mod.ready
    const postPortMessage = vi.fn()
    const { hooks } = hooksWith({ postPortMessage })
    const handle = await createRuntime(configFor(port), hooks)
    await handle.adapter.executeAction('come', {}, {})
    await handle.adapter.executeAction('craft', { item: 'Nope' }, {})
    mod.broadcast({ t: 'survival', kind: 'healed', hp: 80, maxHp: 100 })
    mod.broadcast({ t: 'damaged', by: 'Zombie', amount: 5, hp: 75, maxHp: 100 })
    mod.broadcast({ t: 'event', kind: 'boss_spawn', text: 'The Eye of Cthulhu has awoken!' })
    await wait(100)
    await handle.stop()
    const last = postPortMessage.mock.calls.at(-1)[0]
    expect(last.type).toBe('terraria-stats')
    expect(last.stats.verbs.come).toEqual({ n: 1, ok: 1, fail: {} })
    expect(last.stats.reflex).toMatchObject({ healed: 1, fight: 1 })
    expect(last.stats.alerts.boss_spawn).toBe(1)
  })
})
