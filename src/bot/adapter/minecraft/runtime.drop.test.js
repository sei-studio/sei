// 261111 (user feedback ae9a758e): "Sui leaves the game and pops back in",
// and two sessions ended as world_closed on a world that was open again a
// minute later. The post-spawn liveness check now tries three pings before
// calling the world closed, and every drop is counted (with its class) in
// the session telemetry. connect.js and the adapter are mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ created: [], opts: [], ping: null }))

vi.mock('./connect.js', () => ({
  resolveServerVersion: vi.fn(async (o) => h.ping ? h.ping(o) : '1.21.11'),
  createBotInstance: vi.fn((opts) => {
    const bot = { _sei_startChat: () => {} }
    h.created.push(bot)
    h.opts.push(opts)
    return bot
  }),
}))
vi.mock('./index.js', () => ({
  createMinecraftAdapter: () => ({ detach() {}, createTelemetry: () => ({ stop() {}, setWatching() {} }) }),
}))
vi.mock('./render/povStackLoader.js', () => ({
  configurePovStackLoader: () => {},
  loadPovStack: async () => {},
}))

const { createRuntime, worldAnswers } = await import('./runtime.js')
const { sessionActionStats } = await import('../../brain/actionStats.js')

function hooks() {
  return {
    logger: { info() {}, warn() {}, error() {} },
    createBrain: async () => ({ stop: async () => {} }),
    onBrainReady: () => {},
    onBrainLost: () => {},
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onError: vi.fn(),
  }
}
const config = () => ({
  adapter: { minecraft: { host: '127.0.0.1', port: 50000, version: '1.21.11', auth: 'offline', username: 'Sui', reconnect_delay_ms: 10 } },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

describe('worldAnswers', () => {
  it('is true as soon as one ping answers, with growing timeouts', async () => {
    const seen = []
    let n = 0
    const ok = await worldAnswers(async (t) => { seen.push(t); if (++n < 3) throw new Error('timeout') }, { timeouts: [10, 20, 30], gapMs: 0 })
    expect(ok).toBe(true)
    expect(seen).toEqual([10, 20, 30])
  })

  it('is false when none answers, and stops early when stopped', async () => {
    expect(await worldAnswers(async () => { throw new Error('refused') }, { timeouts: [1, 1, 1], gapMs: 0 })).toBe(false)
    const ping = vi.fn(async () => { throw new Error('x') })
    expect(await worldAnswers(ping, { timeouts: [1, 1, 1], gapMs: 0, stopped: () => true })).toBe(false)
    expect(ping).not.toHaveBeenCalled()
  })
})

describe('post-spawn drop', () => {
  beforeEach(() => {
    h.created.length = 0
    h.opts.length = 0
    h.ping = null
    sessionActionStats._reset()
  })

  it('a world that misses the first ping but answers the second is rejoined, and the drop is counted', async () => {
    const hk = hooks()
    await createRuntime(config(), hk)
    h.opts[0].onSpawn()
    let pings = 0
    h.ping = async () => { if (++pings === 1) throw new Error('timeout'); return '1.21.11' }
    h.opts[0].onEnd('Lost connection', { dropClass: 'keepalive', kickCode: null })
    await wait(1300)
    expect(hk.onError).not.toHaveBeenCalled()
    expect(hk.onDisconnected).toHaveBeenCalledWith(expect.objectContaining({ willRetry: true }))
    expect(h.created.length).toBe(2)
    const c = sessionActionStats.snapshot().counters
    expect(c).toMatchObject({ body_drops: 1, body_rejoins: 1, drop_keepalive: 1 })
  })

  it('a world that answers no ping ends as world_closed, counted as a failed ping', async () => {
    const hk = hooks()
    await createRuntime(config(), hk)
    h.opts[0].onSpawn()
    h.ping = async () => { throw new Error('refused') }
    h.opts[0].onEnd('Lost connection', { dropClass: 'socket', kickCode: null })
    await wait(2500)
    expect(hk.onError).toHaveBeenCalledTimes(1)
    expect(hk.onError.mock.calls[0][0].endReason).toBe('world_closed')
    const c = sessionActionStats.snapshot().counters
    expect(c).toMatchObject({ body_drops: 1, drop_socket: 1, drop_ping_failed: 1 })
    expect(c.body_rejoins ?? 0).toBe(0)
  })
})
