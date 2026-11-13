import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createFactorioAdapter, QUIET_PAUSED_MS } from './index.js'
import { createFactorioStats } from './stats.js'
import { resolveAdapterCaps } from '../../brain/adapterDefaults.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

function fakeClient({ commandResult = { success: true, msg: 'ok' }, lastReplyAt = Date.now() } = {}) {
  const em = new EventEmitter()
  const c = {
    lastReplyAt,
    requests: [],
    commands: [],
    on: (...a) => em.on(...a),
    off: (...a) => em.off(...a),
    emit: (...a) => em.emit(...a),
    request: vi.fn(async (req) => {
      c.requests.push(req)
      if (req.op === 'observe') return { ok: true, obs: { name: 'Sui', health: 100, at: [0, 0], owner: { name: 'Tester', dist: 3, dir: 'north' }, inv: { items: [['coal', 5]] } } }
      return { ok: true }
    }),
    command: vi.fn(async (cid, verb, args) => {
      c.commands.push({ cid, verb, args })
      return typeof commandResult === 'function' ? commandResult(verb, args) : commandResult
    }),
  }
  return c
}

function make(opts = {}) {
  const client = opts.client ?? fakeClient()
  const stats = createFactorioStats()
  const adapter = createFactorioAdapter({ client, cid: '1:sui', config: opts.config ?? {}, botUsername: 'Sui', hello: opts.hello ?? { world: '42-0', seed: 42 }, stats, logger: quiet, now: opts.now })
  return { client, stats, adapter }
}

describe('createFactorioAdapter', () => {
  it('satisfies the adapter contract', () => {
    const { adapter } = make()
    const caps = resolveAdapterCaps(adapter)
    expect(caps).toBeTruthy()
    expect(adapter.gameName).toBe('Factorio')
    expect(adapter.backgroundActions).toEqual({ follow: 'stay' })
    expect(adapter.supportsFollow).toBe(true)
    expect(adapter.listActions()).toContain('buildGhosts')
    expect(adapter.getActionDescription('gather')).toMatch(/\S/)
    expect(adapter.getActionSchema('gather')).toBeTruthy()
  })

  it('runs a tool, refreshes the view and counts the outcome', async () => {
    const { adapter, client, stats } = make()
    expect(await adapter.executeAction('gather', { resource: 'Wood', count: 5 }, {})).toBe('ok')
    expect(client.commands[0]).toEqual({ cid: '1:sui', verb: 'gather', args: { resource: 'wood', count: 5 } })
    expect(client.requests.some((r) => r.op === 'observe')).toBe(true)
    expect(adapter.getLatestObservation()?.name).toBe('Sui')
    expect(stats.snapshot().verbs.gather).toEqual({ n: 1, ok: 1, fail: {} })
  })

  it('counts bad args as a failure and rethrows for the brain', async () => {
    const { adapter, stats } = make()
    await expect(adapter.executeAction('defend', { stance: 'berserk' }, {})).rejects.toThrow()
    expect(stats.snapshot().verbs.defend.fail).toEqual({ refused: 1 })
  })

  it('answers at once while the app has paused her, without touching the game', async () => {
    const { adapter, client } = make()
    adapter.setWorldPaused(true)
    expect(client.requests.at(-1)).toMatchObject({ op: 'pause', paused: true })
    expect(await adapter.executeAction('come', {}, {})).toMatch(/^paused:/)
    expect(client.commands).toHaveLength(0)
  })

  it('says the game is not answering when it has gone quiet', async () => {
    const t0 = Date.now()
    const client = fakeClient({ lastReplyAt: t0 })
    const { adapter } = make({ client, now: () => t0 + QUIET_PAUSED_MS + 1 })
    expect(await adapter.executeAction('come', {}, {})).toMatch(/^failed: the game is not answering/)
  })

  it('holds the brain while the game is quiet and keeps an app pause in force', async () => {
    const { adapter } = make()
    const brain = { setGamePaused: vi.fn((p) => adapter.setWorldPaused(p)) }
    adapter.bindBrain(brain)
    adapter.setGameQuiet(true)
    expect(brain.setGamePaused).toHaveBeenLastCalledWith(true)
    // Our own pause is not mistaken for the player's.
    expect(await adapter.executeAction('come', {}, {})).not.toMatch(/^paused:/)
    adapter.setGameQuiet(false)
    expect(brain.setGamePaused).toHaveBeenLastCalledWith(false)

    // Player pauses in the app, then the game goes quiet and comes back: still paused.
    brain.setGamePaused.mockClear()
    adapter.setWorldPaused(true)
    adapter.setGameQuiet(true)
    adapter.setGameQuiet(false)
    expect(brain.setGamePaused).not.toHaveBeenCalled()
    expect(await adapter.executeAction('come', {}, {})).toMatch(/^paused:/)
  })

  it('says lines through the mod', () => {
    const { adapter, client } = make()
    adapter.chat('  hi there ')
    adapter.chat('')
    expect(client.commands).toEqual([{ cid: '1:sui', verb: 'say', args: { text: 'hi there' } }])
  })

  it('names the world from the save id', () => {
    expect(make().adapter.getWorldIdentity()).toEqual({ fingerprint: 'factorio:42-0', label: 'Factorio map 42' })
    expect(make({ config: { world_label: 'Rail world' } }).adapter.getWorldIdentity().label).toBe('Rail world')
    expect(make({ hello: {} }).adapter.getWorldIdentity()).toBeNull()
  })

  it('knows the player from the view and from joins, and counts reflexes', async () => {
    const { adapter, client, stats } = make()
    await adapter.refreshObservation()
    client.emit('event', { t: 'player_joined', name: 'Friend' })
    client.emit('event', { t: 'fight', enemy: 'small-biter' })
    expect(Object.keys(adapter.getKnownPlayers()).sort()).toEqual(['Friend', 'Tester'])
    expect(stats.snapshot().reflex.fight).toBe(1)
  })

  it('wires handlers on attach and raises spawn and the player on signalSpawned', async () => {
    const { adapter, client } = make()
    await adapter.refreshObservation()
    const h = { onSpawn: vi.fn(), onPlayerJoined: vi.fn(), onChat: vi.fn() }
    adapter.attach(h)
    adapter.signalSpawned()
    expect(h.onSpawn).toHaveBeenCalled()
    expect(h.onPlayerJoined).toHaveBeenCalledWith({ username: 'Tester', uuid: 'factorio:Tester' })
    client.emit('chat', { t: 'chat', from: 'Tester', text: 'hi' })
    expect(h.onChat).toHaveBeenCalled()
    adapter.detach()
    client.emit('chat', { t: 'chat', from: 'Tester', text: 'again' })
    expect(h.onChat).toHaveBeenCalledTimes(1)
  })
})
