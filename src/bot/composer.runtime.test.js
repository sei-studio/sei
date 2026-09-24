// Game-adapters M0 (260908): the composer (src/bot/index.js) is game-agnostic.
//   - it boots against a FAKE 'stardew' runtime with no mineflayer anywhere;
//   - every port forwarder reaches the brain the runtime hands over;
//   - the init payload mapping accepts the new {game, joinTarget} shape AND
//     the legacy top-level Minecraft keys;
//   - nothing under ./adapter/ is imported statically.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, resolveInitGame, loadRuntimeModule } from './index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function fakeRuntime() {
  const seen = { hooks: null, config: null, stopped: 0, companions: null, watch: null }
  const brain = {
    deliverSeiChat: vi.fn(), observeSeiChat: vi.fn(), setVoiceCall: vi.fn(), setGamePaused: vi.fn(),
    setGameMode: vi.fn(), deliverVoiceCallGreeting: vi.fn(), setCompanions: vi.fn(), setAuthToken: vi.fn(),
    setBackend: vi.fn(), visionCapable: vi.fn(() => true), stop: vi.fn(async () => {}),
  }
  const telemetry = { setWatching: vi.fn(), setAction: vi.fn(), stop: vi.fn() }
  const mod = {
    async createRuntime(config, hooks) {
      seen.hooks = hooks
      seen.config = config
      // A connected body: hand the composer its brain like a real runtime would.
      hooks.onBrainReady(brain)
      hooks.onConnected()
      return {
        adapter: { botUsername: 'Sui' },
        telemetry,
        async stop() { seen.stopped += 1; hooks.onBrainLost() },
        setCompanions(names) { seen.companions = names; return names.filter((n) => n !== 'Sui') },
        setDashboardWatch(active) { seen.watch = active },
      }
    },
  }
  return { mod, seen, brain, telemetry }
}

const config = {
  adapter: { kind: 'stardew', stardew: {} },
  persona: { name: 'Sui', expanded: 'x' },
  _seiCompanions: ['Marv'],
  _seiSummonDeadlineAt: 123,
}

describe('composer start() against a fake stardew runtime', () => {
  it('boots without a minecraft adapter, wires the hooks, and forwards every port method to the brain', async () => {
    const { mod, seen, brain } = fakeRuntime()
    const onReady = vi.fn()
    const handle = await start(config, { runtime: mod, onReady, onDashboard: () => {} })
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(seen.config).toBe(config)
    for (const k of ['logger', 'createBrain', 'onBrainReady', 'onBrainLost', 'onConnected', 'onDisconnected', 'onError', 'onDashboard', 'emitVisionCapability']) {
      expect(typeof seen.hooks[k], k).toBe(k === 'logger' ? 'object' : 'function')
    }
    expect(seen.hooks.summonDeadlineAt).toBe(123)
    // The roster known before the brain was ready is applied on onBrainReady.
    expect(brain.setCompanions).toHaveBeenCalledWith(['Marv'])

    handle.deliverSeiChat({ from: 'Steve', text: 'hi' })
    expect(brain.deliverSeiChat).toHaveBeenCalledWith({ from: 'Steve', text: 'hi' })
    handle.observeSeiChat({ from: 'Marv', text: 'yo' })
    expect(brain.observeSeiChat).toHaveBeenCalled()
    handle.setVoiceCall(true)
    expect(brain.setVoiceCall).toHaveBeenCalledWith(true)
    handle.setGamePaused(true)
    expect(brain.setGamePaused).toHaveBeenCalledWith(true)
    handle.setGameMode('reactive')
    expect(brain.setGameMode).toHaveBeenCalledWith('reactive')
    handle.deliverVoiceCallGreeting()
    expect(brain.deliverVoiceCallGreeting).toHaveBeenCalled()
    handle.setAuthToken('jwt')
    expect(brain.setAuthToken).toHaveBeenCalledWith('jwt')
    handle.setBackend({ api_key: 'k' })
    expect(brain.setBackend).toHaveBeenCalledWith({ api_key: 'k' })
    expect(handle.visionCapable()).toBe(true)
    // Companions go through the runtime (own name filtered) then to the brain.
    handle.setCompanions(['Sui', 'Marv', 'Lyra'])
    expect(seen.companions).toEqual(['Sui', 'Marv', 'Lyra'])
    expect(brain.setCompanions).toHaveBeenLastCalledWith(['Marv', 'Lyra'])
    // Dashboard watch is a runtime concern, not a brain passthrough.
    handle.setDashboardWatch(true)
    expect(seen.watch).toBe(true)

    await handle.stop()
    expect(seen.stopped).toBe(1)
    // After the body is gone nothing is forwarded (no throw either).
    handle.deliverSeiChat({ from: 'Steve', text: 'again' })
    expect(brain.deliverSeiChat).toHaveBeenCalledTimes(1)
  })

  it('relays a terminal runtime error to the onError hook', async () => {
    const { mod, seen } = fakeRuntime()
    const onError = vi.fn()
    await start(config, { runtime: mod, onError })
    seen.hooks.onError({ error: 'GAME_WORLD_NOT_OPEN', message: 'farm closed' })
    expect(onError).toHaveBeenCalledWith({ error: 'GAME_WORLD_NOT_OPEN', message: 'farm closed' })
  })

  it('rejects a runtime module without createRuntime', async () => {
    await expect(start(config, { runtime: {} })).rejects.toThrow(/createRuntime/)
  })
})

describe('resolveInitGame (init payload mapping)', () => {
  it('reads the new shape', () => {
    const r = resolveInitGame({
      game: 'stardew',
      joinTarget: { port: 8123, token: 't', label: 'Sunny Farm' },
      packRoot: '/packs/stardew/1.0.0',
    })
    expect(r.game).toBe('stardew')
    expect(r.joinTarget).toEqual({ port: 8123, token: 't', label: 'Sunny Farm' })
    expect(r.worldLabel).toBe('Sunny Farm')
    expect(r.packRoot).toBe('/packs/stardew/1.0.0')
    expect(r.legacy).toBe(false)
  })

  it('folds the legacy top-level Minecraft keys into a minecraft joinTarget when game is absent', () => {
    const r = resolveInitGame({ lanPort: 25565, lanMotd: 'A Minecraft Server', mc_username: 'steve', skinServerBaseUrl: 'http://127.0.0.1:1' })
    expect(r.game).toBe('minecraft')
    expect(r.joinTarget).toEqual({ port: 25565, motd: 'A Minecraft Server', mc_username: 'steve', skinServerBaseUrl: 'http://127.0.0.1:1' })
    expect(r.worldLabel).toBe('A Minecraft Server')
    expect(r.packRoot).toBeNull()
    expect(r.legacy).toBe(true)
  })

  it('prefers an explicit worldLabel, blanks to null, and falls back to minecraft on junk', () => {
    expect(resolveInitGame({ game: 'minecraft', joinTarget: { port: 1, motd: '  ' } }).worldLabel).toBeNull()
    expect(resolveInitGame({ game: 'minecraft', joinTarget: { port: 1, motd: 'x' }, worldLabel: 'Y' }).worldLabel).toBe('Y')
    expect(resolveInitGame({ game: 'roblox' }).game).toBe('minecraft')
  })
})

describe('game-agnostic composer (source pins)', () => {
  const src = readFileSync(path.join(HERE, 'index.js'), 'utf8')

  it('has no static import from ./adapter/', () => {
    expect(src).not.toMatch(/^import .* from '\.\/adapter\//m)
  })

  it('awaits the pack loader before the dynamic runtime import', () => {
    expect(src.indexOf('await preparePackLoader(')).toBeGreaterThan(-1)
    expect(src.indexOf('await preparePackLoader(')).toBeLessThan(src.indexOf('await loadRuntimeModule(game)'))
  })

  it('refuses a kind outside GAME_KINDS', async () => {
    await expect(loadRuntimeModule('../brain/index')).rejects.toThrow(/unknown game kind/)
  })
})
