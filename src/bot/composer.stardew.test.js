// The composer boots the REAL stardew runtime (dynamic import by kind)
// against the fake mod, with the brain mocked: no mineflayer, no Electron,
// no game. Pins that a `stardew` init lands on adapter/stardew/runtime.js
// and that the port forwarders reach the brain the runtime hands over.
import { describe, it, expect, vi, afterEach } from 'vitest'

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
import { createFakeMod } from '../../scripts/fake-stardew-mod.mjs'
import * as brainMod from './brain/index.js'

describe('composer + real stardew runtime + fake mod', () => {
  let mod
  afterEach(async () => { if (mod) await mod.close(); mod = null })

  it('loads adapter/stardew/runtime.js by kind and reaches summon-ready', async () => {
    const rt = await loadRuntimeModule('stardew')
    expect(typeof rt.createRuntime).toBe('function')
    mod = createFakeMod({ obsHz: 0 })
    const port = await mod.ready
    const init = resolveInitGame({ game: 'stardew', joinTarget: { port, token: 'test-token', label: 'Sunny Farm' } })
    expect(init.worldLabel).toBe('Sunny Farm')
    const config = ConfigSchema.parse({
      player_username: 'Ouen',
      world_label: init.worldLabel,
      persona: { name: 'Sui', expanded: 'x' },
      anthropic: { api_key: 'k' },
      adapter: { kind: 'stardew', stardew: rt.adapterConfigFrom({ joinTarget: init.joinTarget, botUsername: rt.botUsernameFor({ name: 'Sui' }) }) },
    })
    config._seiSummonDeadlineAt = Date.now() + 8000
    const onReady = vi.fn()
    const onError = vi.fn()
    const handle = await start(config, { onReady, onError, onDashboard: () => {} })
    expect(onError).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(brainMod.start).toHaveBeenCalledTimes(1)
    expect(mod.state.bodies.has('Sui')).toBe(true)
    const brain = await brainMod.start.mock.results[0].value
    handle.deliverSeiChat({ from: 'Ouen', text: 'hi' })
    expect(brain.deliverSeiChat).toHaveBeenCalled()
    await handle.stop()
    expect(brain.stop).toHaveBeenCalled()
  })
})
