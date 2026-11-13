import { describe, it, expect, vi, afterEach } from 'vitest'
import { createFactorioClient } from './client.js'
import { createScriptedMod } from './fixtures/fakeMod.js'
import {
  createRuntime, botUsernameFor, adapterConfigFrom, checkJoinTarget, connectTimeoutFor, spawnErrorMessage,
  MIN_CONNECT_TIMEOUT_MS, REPORT_MARGIN_MS,
} from './runtime.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const handles = []
afterEach(async () => { while (handles.length) await handles.pop().stop() })

function baseConfig(over = {}) {
  return { adapter: { kind: 'factorio', factorio: { host: '127.0.0.1', port: 34990, username: 'Sui', reconnect_delay_ms: 10, quiet_ms: 200, idle_end_ms: 60_000, ...over } } }
}

function hooksFor(fake, extra = {}) {
  const brain = { stop: vi.fn(async () => {}), setGamePaused: vi.fn() }
  const h = {
    logger: quiet,
    summonDeadlineAt: null,
    createBrain: vi.fn(async () => brain),
    onBrainReady: vi.fn(),
    onBrainLost: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onError: vi.fn(),
    onDashboard: null,
    postPortMessage: vi.fn(),
    createClient: (opts) => createFactorioClient({ ...opts, dgramImpl: fake.dgram }),
    connectTimeoutMs: 600,
    watchIntervalMs: 25,
    ...extra,
  }
  return { h, brain }
}

async function start(mod, extra = {}, cfg = {}) {
  const { h, brain } = hooksFor(mod.fake, extra)
  const handle = await createRuntime(baseConfig(cfg), h)
  handles.push(handle)
  return { h, brain, handle }
}

describe('factorio runtime helpers', () => {
  it('names the companion plainly', () => {
    expect(botUsernameFor({ name: 'Zoë the Builder!' })).toBe('Zoe the Builder')
    expect(botUsernameFor({ username: '  ', name: '' })).toBe('Sei')
  })

  it('builds the adapter block from the join target', () => {
    expect(adapterConfigFrom({ joinTarget: { port: 34990, label: 'Factorio', color: { r: 1, g: 0.5, b: 0 } }, botUsername: 'Sui' }))
      .toEqual({ host: '127.0.0.1', port: 34990, username: 'Sui', label: 'Factorio', color: { r: 1, g: 0.5, b: 0 } })
    expect(checkJoinTarget({})).toMatchObject({ error: 'GAME_WORLD_NOT_OPEN' })
    expect(checkJoinTarget({ port: 1 })).toBeNull()
  })

  it('sizes the connect guard inside the supervisor deadline', () => {
    expect(connectTimeoutFor(10_000 + 20_000, 10_000)).toBe(20_000 - REPORT_MARGIN_MS)
    expect(connectTimeoutFor(10_000, 10_000)).toBe(MIN_CONNECT_TIMEOUT_MS)
    expect(spawnErrorMessage('this player already has 3 companions')).toMatch(/^GAME_NOT_ANSWERING: .*most companions/)
  })
})

describe('createRuntime', () => {
  it('says hello, spawns, starts the brain and reports ready', async () => {
    const mod = createScriptedMod()
    const { h, brain, handle } = await start(mod)
    expect(h.onConnected).toHaveBeenCalledTimes(1)
    expect(h.onError).not.toHaveBeenCalled()
    expect(h.onBrainReady).toHaveBeenCalledWith(brain)
    expect(mod.fake.sent.map((r) => r.op).slice(0, 2)).toEqual(['hello', 'spawn'])
    expect(handle.adapter.getWorldIdentity()).toMatchObject({ fingerprint: 'factorio:424242-0' })
    expect(handle.adapter.getLatestObservation()?.name).toBe('Sui')
  })

  it('reports a silent game as not answering after its retries', async () => {
    const mod = createScriptedMod()
    mod.state.silent = true
    const { h } = await start(mod)
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ error: 'GAME_NOT_ANSWERING' }))
    expect(h.onError.mock.calls[0][0].message).toMatch(/did not answer on port 34990/)
    expect(h.createBrain).not.toHaveBeenCalled()
    expect(mod.fake.sockets.length).toBe(3)
  }, 15_000)

  it('reports a closed port as no world open, without retrying', async () => {
    const mod = createScriptedMod()
    mod.fake.refuse(true)
    const { h } = await start(mod)
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ error: 'GAME_WORLD_NOT_OPEN' }))
    expect(mod.fake.sockets.length).toBe(1)
  })

  it('refuses a mod that speaks another protocol', async () => {
    const mod = createScriptedMod({ protocol: 2 })
    const { h } = await start(mod)
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ error: 'GAME_VERSION_UNSUPPORTED' }))
  })

  it('holds the brain while the game is quiet and releases it when it answers', async () => {
    const mod = createScriptedMod()
    const { brain } = await start(mod)
    mod.state.silent = true
    await vi.waitFor(() => expect(brain.setGamePaused).toHaveBeenCalledWith(true), { timeout: 2_000 })
    mod.state.silent = false
    await vi.waitFor(() => expect(brain.setGamePaused).toHaveBeenLastCalledWith(false), { timeout: 2_000 })
  })

  it('ends the session as world_closed when the game quits', async () => {
    const mod = createScriptedMod()
    const { h, brain } = await start(mod)
    mod.fake.refuse(true)
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ error: 'GAME_WORLD_NOT_OPEN', endReason: 'world_closed' })), { timeout: 2_000 })
    expect(brain.stop).toHaveBeenCalled()
    expect(h.postPortMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'factorio-stats' }))
  })

  it('spawns her again after a reloaded save, and ends on a different save', async () => {
    const mod = createScriptedMod()
    const { h } = await start(mod)
    mod.state.spawned = false // the save was reloaded: the mod forgot her
    await vi.waitFor(() => expect(mod.fake.sent.filter((r) => r.op === 'spawn').length).toBe(2), { timeout: 2_000 })
    expect(h.onError).not.toHaveBeenCalled()

    mod.state.world = 'other-save'
    mod.state.spawned = false
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ endReason: 'world_closed' })), { timeout: 2_000 })
    expect(h.onError.mock.calls[0][0].message).toMatch(/different Factorio save/)
  })

  it('despawns her and posts the last stats on stop', async () => {
    const mod = createScriptedMod()
    const { h, handle } = await start(mod)
    await handle.adapter.executeAction('come', {}, {})
    await handle.stop()
    handles.length = 0
    expect(mod.fake.sent.some((r) => r.op === 'despawn')).toBe(true)
    const last = h.postPortMessage.mock.calls.at(-1)[0]
    expect(last.type).toBe('factorio-stats')
    expect(last.stats.verbs.come).toEqual({ n: 1, ok: 1, fail: {} })
  })

  it('keeps sibling companions on the config across reconnects', async () => {
    const mod = createScriptedMod()
    const cfg = baseConfig()
    const { h } = hooksFor(mod.fake)
    const handle = await createRuntime(cfg, h)
    handles.push(handle)
    expect(handle.setCompanions(['Lyra', 'Sui', ''])).toEqual(['Lyra'])
    expect(cfg._seiCompanions).toEqual(['Lyra'])
  })
})
