// 261007: a kick that will repeat on every attempt ends the summon on the
// FIRST kick, with its own class, instead of spending the reconnect budget and
// landing on LAN_NOT_OPEN ("re-open the world to LAN") for a world that is
// open. Online mode (multiplayer.disconnect.unverified_username) joins the
// modded-host case here. connect.js and the adapter are mocked: this pins only
// runtime.js's onEnd routing.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ created: [], onEnds: [] }))

vi.mock('./connect.js', () => ({
  resolveServerVersion: vi.fn(async () => '1.21.11'),
  createBotInstance: vi.fn((opts) => {
    const bot = { _sei_startChat: () => {} }
    h.created.push(bot)
    h.onEnds.push(opts.onEnd)
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

const { createRuntime } = await import('./runtime.js')

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

describe('runtime onEnd: permanent kicks fail fast (261007)', () => {
  beforeEach(() => {
    h.created.length = 0
    h.onEnds.length = 0
  })

  it('an online-mode kick fails once as ONLINE_MODE_REJECTED and never reconnects', async () => {
    const hk = hooks()
    await createRuntime(config(), hk)
    expect(h.created).toHaveLength(1)
    h.onEnds[0]('This world checks Minecraft accounts (online mode)', { onlineMode: true, modded: false, kickCode: 'unverified_username' })
    await new Promise((r) => setTimeout(r, 40))
    expect(h.created).toHaveLength(1)
    expect(hk.onError).toHaveBeenCalledTimes(1)
    expect(hk.onError.mock.calls[0][0]).toMatchObject({ error: 'ONLINE_MODE_REJECTED' })
    expect(hk.onError.mock.calls[0][0].message).toMatch(/^ONLINE_MODE_REJECTED: /)
    expect(hk.onDisconnected).toHaveBeenCalledWith(expect.objectContaining({ willRetry: false }))
  })

  it('the modded fast-fail still wins over online mode', async () => {
    const hk = hooks()
    await createRuntime(config(), hk)
    h.onEnds[0]('This world runs Fabric with mods', { onlineMode: false, modded: true, kickCode: 'modded' })
    expect(hk.onError.mock.calls[0][0]).toMatchObject({ error: 'MODDED_HOST_REJECTED' })
  })

  it('an ordinary pre-spawn drop still retries', async () => {
    const hk = hooks()
    await createRuntime(config(), hk)
    h.onEnds[0]('Could not reach the world', { onlineMode: false, modded: false })
    await new Promise((r) => setTimeout(r, 40))
    expect(hk.onError).not.toHaveBeenCalled()
    expect(h.created.length).toBeGreaterThan(1)
  })
})
