// The composer boots the REAL sts2 runtime (dynamic import by kind) with the
// brain mocked, and the fake StS2 mod connects to the bot's link the way the
// companion's game window does. Pins that an `sts2` init lands on
// adapter/sts2/runtime.js, parses through ConfigSchema and reaches ready.
import { describe, it, expect, vi, afterEach } from 'vitest'
import net from 'node:net'

vi.mock('./brain/index.js', () => ({
  start: vi.fn(async ({ adapter }) => {
    adapter.attach({ onSpawn: vi.fn(), onChat: vi.fn(), onAttacked: vi.fn(), onDeath: vi.fn(), onPlayerJoined: vi.fn(), onPlayerLeft: vi.fn() })
    return {
      stop: vi.fn(async () => {}),
      setCompanions: vi.fn(),
      deliverSeiChat: vi.fn(),
      setGamePaused: vi.fn(),
      visionCapable: vi.fn(() => false),
    }
  }),
}))

import { start, loadRuntimeModule, resolveInitGame } from './index.js'
import { ConfigSchema } from './config.js'
import { createFakeMod } from './adapter/sts2/fixtures/fakeMod.js'
import * as brainMod from './brain/index.js'

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

describe('composer + real sts2 runtime + fake mod', () => {
  let mod
  afterEach(() => { mod?.close(); mod = null })

  it('loads adapter/sts2/runtime.js by kind and reaches summon-ready', async () => {
    const rt = await loadRuntimeModule('sts2')
    expect(typeof rt.createRuntime).toBe('function')
    expect(rt.checkJoinTarget({})).toMatchObject({ error: 'GAME_WORLD_NOT_OPEN' })
    const port = await freePort()
    const init = resolveInitGame({ game: 'sts2', joinTarget: { port, token: 'tok', label: 'Slay the Spire 2' } })
    const config = ConfigSchema.parse({
      player_username: 'Ouen',
      persona: { name: 'Sui', expanded: 'x' },
      anthropic: { api_key: 'k' },
      adapter: { kind: 'sts2', sts2: rt.adapterConfigFrom({ joinTarget: init.joinTarget, botUsername: rt.botUsernameFor({ name: 'Sui' }) }) },
    })
    expect(config.adapter.sts2).toMatchObject({ host: '127.0.0.1', port, token: 'tok', username: 'Sui' })
    config._seiSummonDeadlineAt = Date.now() + 8000
    // The companion's window comes up a moment after the link opens.
    const connectLater = (async () => {
      for (let i = 0; i < 100; i++) {
        mod = createFakeMod({ url: `ws://127.0.0.1:${port}/sei-sts2?token=tok` })
        try { await mod.connect(); return } catch { mod.close(); await new Promise((r) => setTimeout(r, 50)) }
      }
    })()
    const onReady = vi.fn()
    const onError = vi.fn()
    const handle = await start(config, { onReady, onError, onDashboard: () => {} })
    await connectLater
    expect(onError).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(brainMod.start).toHaveBeenCalledTimes(1)
    await handle.stop()
    const brain = await brainMod.start.mock.results[0].value
    expect(brain.stop).toHaveBeenCalled()
  })
})
