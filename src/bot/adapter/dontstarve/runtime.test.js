// Game-adapters M2 (260908): the DST runtime against the fake mod
// (scripts/fake-dst-mod.mjs) — connect, summon timeout, poll hold,
// heartbeat loss, death, stop. No Electron, no game.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRuntime, createDstLink, adapterConfigFrom, botUsernameFor, checkJoinTarget } from './runtime.js'
import { createFakeMod, sleep } from '../../../../scripts/fake-dst-mod.mjs'

const quiet = { info: () => {}, warn: () => {}, error: () => {} }

function dstConfig(overrides = {}) {
  return {
    adapter: {
      kind: 'dontstarve',
      dontstarve: {
        username: 'Sui', session: 'S1', label: 'Fake World', day: 3, season: 'autumn', phase: 'day', caves: false,
        nearUserid: 'KU_fake', nearName: 'Steve', prefab: 'wilson', survivorBrief: 'You are playing as Wilson.',
        announce: true, spawn_timeout_ms: 5000, heartbeat_loss_ms: 1500, cmd_hold_ms: 400, ...overrides,
      },
    },
    player_username: 'Steve',
    persona: { name: 'Sui', expanded: 'x' },
    _seiCompanions: [],
  }
}

function hooks(extra = {}) {
  const brain = { stop: vi.fn(async () => {}), setCompanions: vi.fn() }
  const h = {
    logger: quiet,
    summonDeadlineAt: Date.now() + 30_000,
    createBrain: vi.fn(async (adapter) => { h.adapter = adapter; adapter.attach(h.handlers); return brain }),
    handlers: { onChat: vi.fn(), onAttacked: vi.fn(), onDeath: vi.fn(), onSpawn: vi.fn(), onPlayerJoined: vi.fn(), onPlayerLeft: vi.fn() },
    onBrainReady: vi.fn(), onBrainLost: vi.fn(), onConnected: vi.fn(), onDisconnected: vi.fn(), onError: vi.fn(),
    onDashboard: vi.fn(), emitVisionCapability: vi.fn(), postPortMessage: vi.fn(),
    brain,
    ...extra,
  }
  return h
}

let cleanup = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) { try { await fn() } catch {} }
})

describe('runtime exports', () => {
  it('names the body from the character and builds the adapter block from the join target', () => {
    expect(botUsernameFor({ name: '  Sui\nStar  ' })).toBe('Sui Star')
    expect(botUsernameFor({ name: '' })).toBe('Sei')
    const jt = { session: 'S', label: 'W', nearName: 'Steve', announce: false, survivors: { c1: { prefab: 'wigfrid', brief: 'b' } }, defaultPrefab: 'wilson', defaultBrief: 'd' }
    const block = adapterConfigFrom({ joinTarget: jt, botUsername: 'Sui', character: { id: 'c1' } })
    expect(block).toMatchObject({ username: 'Sui', session: 'S', label: 'W', prefab: 'wigfrid', survivorBrief: 'b', nearName: 'Steve', announce: false })
    // No stored pick for this character: the default row.
    expect(adapterConfigFrom({ joinTarget: jt, botUsername: 'Sui', character: { id: 'c2' } })).toMatchObject({ prefab: 'wilson', survivorBrief: 'd' })
    expect(adapterConfigFrom({ joinTarget: null, botUsername: 'Sui' }).prefab).toBe('wilson')
    expect(checkJoinTarget(null)?.error).toBe('GAME_WORLD_NOT_OPEN')
    expect(checkJoinTarget({ session: 'S' })).toBeNull()
  })
})

describe('createRuntime + fake mod', () => {
  it('reports dst-listen, spawns, wires the brain, resolves a command through the mod, and stops with a despawn', async () => {
    const h = hooks()
    const rt = await createRuntime(dstConfig(), h)
    cleanup.push(() => rt.stop())
    expect(h.postPortMessage).toHaveBeenCalledTimes(1)
    const { port, token, type } = h.postPortMessage.mock.calls[0][0]
    expect(type).toBe('dst-listen')
    expect(port).toBeGreaterThan(0)
    expect(token.length).toBeGreaterThanOrEqual(8)

    const mod = createFakeMod({ botPort: port, token })
    cleanup.push(() => mod.stop())
    await mod.start()
    await waitFor(() => h.onConnected.mock.calls.length === 1)
    expect(h.createBrain).toHaveBeenCalledTimes(1)
    expect(h.onBrainReady).toHaveBeenCalledWith(h.brain)
    expect(h.handlers.onSpawn).toHaveBeenCalledTimes(1)
    expect(rt.adapter.botUsername).toBe('Sui')
    expect(rt.adapter.getWorldIdentity()).toEqual({ fingerprint: 'dst:SESSION-FAKE-1', label: 'Fake World' })

    // A verb becomes one command and its result string comes back.
    await waitFor(() => rt.link.state.hasFull)
    const r = await rt.adapter.executeAction('gather', { item: 'twigs', count: 3 }, { signal: new AbortController().signal })
    expect(r).toBe('gathered 3 twigs')
    expect(mod.received.find((c) => c.kind === 'gather')).toMatchObject({ prefab: 'twigs', count: 3, source: 'sapling' })

    // Chat from the game reaches the brain as a player line.
    await mod.chat('hey sui come here')
    await waitFor(() => h.handlers.onChat.mock.calls.length === 1)
    expect(h.handlers.onChat.mock.calls[0][0]).toMatchObject({ username: 'Steve', playerSpoke: true, addressed: true })

    // Dashboard telemetry while watched.
    rt.setDashboardWatch(true)
    await waitFor(() => h.onDashboard.mock.calls.length >= 1)
    expect(h.onDashboard.mock.calls[0][0]).toMatchObject({ game: 'dontstarve', health: 150, day: 3, prefab: 'wilson' })

    // Stop: despawn command, brain stopped, link closed.
    await rt.stop()
    expect(mod.received.some((c) => c.kind === 'despawn')).toBe(true)
    expect(h.brain.stop).toHaveBeenCalled()
    expect(h.onBrainLost).toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('fails with GAME_NOT_ANSWERING when nothing contacts it before the deadline', async () => {
    vi.useFakeTimers()
    try {
      const h = hooks({ summonDeadlineAt: Date.now() + 9_000 })
      const rt = await createRuntime(dstConfig(), h)
      cleanup.push(() => rt.stop())
      await vi.advanceTimersByTimeAsync(6_500)
      expect(h.onError).toHaveBeenCalledTimes(1)
      expect(h.onError.mock.calls[0][0].error).toBe('GAME_NOT_ANSWERING')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails with DST_SPAWN_FAILED when the mod answers but never spawns', async () => {
    const h = hooks()
    const rt = await createRuntime(dstConfig({ spawn_timeout_ms: 1000 }), h)
    cleanup.push(() => rt.stop())
    const { port, token } = h.postPortMessage.mock.calls[0][0]
    const mod = createFakeMod({ botPort: port, token })
    cleanup.push(() => mod.stop())
    await mod.sendObs(true) // contact without a spawned event
    await waitFor(() => h.onError.mock.calls.length === 1, 8_000)
    expect(h.onError.mock.calls[0][0].error).toBe('DST_SPAWN_FAILED')
    expect(h.createBrain).not.toHaveBeenCalled()
  }, 10_000)

  it('treats heartbeat loss after spawn as the world closing (GAME_WORLD_NOT_OPEN)', async () => {
    const h = hooks()
    const rt = await createRuntime(dstConfig({ heartbeat_loss_ms: 1200 }), h)
    cleanup.push(() => rt.stop())
    const { port, token } = h.postPortMessage.mock.calls[0][0]
    const mod = createFakeMod({ botPort: port, token })
    cleanup.push(() => mod.stop())
    await mod.start()
    await waitFor(() => h.onConnected.mock.calls.length === 1)
    mod.silence(true)
    await waitFor(() => h.onError.mock.calls.length === 1, 6_000)
    expect(h.onError.mock.calls[0][0].error).toBe('GAME_WORLD_NOT_OPEN')
    expect(h.onDisconnected).toHaveBeenCalledWith({ reason: 'heartbeat lost', willRetry: false })
    expect(h.brain.stop).toHaveBeenCalled()
  })

  it('a death gives the brain a turn, then ends the session as DST_BODY_DIED', async () => {
    const h = hooks()
    const rt = await createRuntime(dstConfig({ death_grace_ms: 400 }), h)
    cleanup.push(() => rt.stop())
    const { port, token } = h.postPortMessage.mock.calls[0][0]
    const mod = createFakeMod({ botPort: port, token })
    cleanup.push(() => mod.stop())
    await mod.start()
    await waitFor(() => h.onConnected.mock.calls.length === 1)
    await mod.event('death', { x: 1, z: 2 })
    await waitFor(() => h.handlers.onDeath.mock.calls.length === 1)
    expect(h.handlers.onDeath.mock.calls[0][0]).toEqual({ pos: { x: 1, y: 0, z: 2 } })
    expect(h.onError).not.toHaveBeenCalled()
    await waitFor(() => h.onError.mock.calls.length === 1)
    expect(h.onError.mock.calls[0][0].error).toBe('DST_BODY_DIED')
    expect(mod.received.some((c) => c.kind === 'despawn')).toBe(true)
  })

  it('a pending command is cancelled by the abort signal and a stop is sent to the body', async () => {
    const h = hooks()
    const rt = await createRuntime(dstConfig(), h)
    cleanup.push(() => rt.stop())
    const { port, token } = h.postPortMessage.mock.calls[0][0]
    // A mod that never answers slotted commands.
    const mod = createFakeMod({ botPort: port, token, onCommand: (c) => (c.kind === 'action' ? false : null) })
    cleanup.push(() => mod.stop())
    await mod.start()
    await waitFor(() => h.onConnected.mock.calls.length === 1 && rt.link.state.hasFull)
    const ac = new AbortController()
    const p = rt.adapter.executeAction('chop', { target: 'evergreen' }, { signal: ac.signal })
    await waitFor(() => mod.received.some((c) => c.kind === 'action'))
    ac.abort()
    expect(await p).toBe('cancelled')
    await waitFor(() => mod.received.some((c) => c.kind === 'stop'))
  })
})

describe('the /cmd long-poll', () => {
  it('holds an empty poll for at most the configured hold (never over 400 ms) and releases instantly when a command lands', async () => {
    const link = createDstLink({ dst: { username: 'Sui', cmd_hold_ms: 400 }, logger: quiet })
    await link.listen()
    cleanup.push(() => link.close())
    const mod = createFakeMod({ botPort: link.port, token: link.token, onCommand: () => false })
    // Empty queue: bounded hold.
    const t0 = Date.now()
    const empty = await mod.pollOnce()
    const held = Date.now() - t0
    expect(empty).toEqual([])
    expect(held).toBeGreaterThanOrEqual(350)
    expect(held).toBeLessThan(400 + 150)
    // A command queued mid-hold releases the waiter right away.
    const t1 = Date.now()
    const pollP = mod.pollOnce()
    await sleep(60)
    const resP = link.send({ kind: 'say', text: 'hi' }, { timeoutMs: 2000 })
    const cmds = await pollP
    expect(Date.now() - t1).toBeLessThan(300)
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({ kind: 'say', text: 'hi' })
    await mod.result(cmds[0].id, true, 'said')
    expect(await resP).toBe('said')
    // Wrong token is refused before any handler runs.
    const res = await fetch(`http://127.0.0.1:${link.port}/cmd?since=0&t=nope`)
    expect(res.status).toBe(401)
  })

  it('delivers each command once: an acked seq is never re-sent', async () => {
    const link = createDstLink({ dst: { username: 'Sui', cmd_hold_ms: 0 }, logger: quiet })
    await link.listen()
    cleanup.push(() => link.close())
    const mod = createFakeMod({ botPort: link.port, token: link.token, onCommand: () => false })
    void link.send({ kind: 'follow', guid: 1 }, { timeoutMs: 500 })
    void link.send({ kind: 'unfollow' }, { timeoutMs: 500 })
    const first = await mod.pollOnce()
    expect(first.map((c) => c.kind)).toEqual(['follow', 'unfollow'])
    const second = await mod.pollOnce()
    expect(second).toEqual([])
  })
})

async function waitFor(pred, timeoutMs = 4_000, stepMs = 20) {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor: timed out')
    await sleep(stepMs)
  }
}

describe('DST link: what the helper reports at spawn', () => {
  const quiet = { info() {}, warn() {}, error() {} }
  for (const [version, caps] of [['0.3.0', true], [null, false]]) {
    it(`mod ${version ?? '(none)'}: modVersion, hasCaps and the body guid`, async () => {
      const link = createDstLink({ dst: { username: 'Sui', cmd_hold_ms: 0 }, logger: quiet })
      await link.listen()
      const mod = createFakeMod({ botPort: link.port, token: link.token, onCommand: () => false, modVersion: version })
      try {
        await mod.spawn()
        expect(link.modVersion).toBe(version)
        expect(link.hasCaps).toBe(caps)
        expect(link.guid).toBe(9001)
      } finally {
        await link.close()
      }
    })
  }
})

