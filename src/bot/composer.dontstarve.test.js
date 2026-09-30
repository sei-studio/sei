// Game-adapters M2 (260908): the composer boots the REAL Don't Starve
// runtime (no mineflayer anywhere) against the fake mod, end to end:
// init-shaped config -> ConfigSchema -> runtime -> dst-listen -> spawned ->
// brain (stubbed) -> summon-ready.
import { describe, it, expect, vi, afterEach } from 'vitest'

const { startBrainSpy } = vi.hoisted(() => ({ startBrainSpy: vi.fn() }))
vi.mock('./brain/index.js', () => ({ start: startBrainSpy }))

import { start, loadRuntimeModule, resolveInitGame } from './index.js'
import { ConfigSchema } from './config.js'
import { createFakeMod, sleep } from '../../scripts/fake-dst-mod.mjs'

let cleanup = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) { try { await fn() } catch {} }
  startBrainSpy.mockReset()
})

async function waitFor(pred, timeoutMs = 4000) {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out')
    await sleep(20)
  }
}

describe("composer with the real 'dontstarve' runtime", () => {
  it('loads the runtime by kind, builds a valid config from the join target, and reaches summon-ready through the fake mod', async () => {
    const mod = await loadRuntimeModule('dontstarve')
    expect(typeof mod.createRuntime).toBe('function')
    const { game, joinTarget, worldLabel } = resolveInitGame({
      game: 'dontstarve',
      joinTarget: { session: 'S1', label: 'Fake World', day: 3, season: 'autumn', phase: 'day', caves: false, nearUserid: 'KU_fake', nearName: 'Steve', survivors: { c1: { prefab: 'wigfrid', brief: 'You are playing as Wigfrid.' } }, defaultPrefab: 'wilson', defaultBrief: 'You are playing as Wilson.', announce: true },
    })
    expect(game).toBe('dontstarve')
    expect(worldLabel).toBe('Fake World')
    const username = mod.botUsernameFor({ name: 'Sui' })
    const config = ConfigSchema.parse({
      player_username: 'Steve',
      world_label: worldLabel,
      persona: { name: username, expanded: 'x', proactiveness: 2 },
      anthropic: { api_key: 'k' },
      adapter: { kind: game, dontstarve: { ...mod.adapterConfigFrom({ joinTarget, botUsername: username, character: { id: 'c1' } }), spawn_timeout_ms: 5000 } },
      memory: { player_md_path: '/tmp/x/PLAYER.md', memory_md_path: '/tmp/x/MEMORY.md', heartbeat_md_path: '/tmp/x/HEARTBEAT.md', worlds_json_path: '/tmp/x/worlds.json' },
    })
    expect(config.adapter.dontstarve.prefab).toBe('wigfrid')
    expect(config.adapter.dontstarve.cmd_hold_ms).toBe(400)

    const brain = { stop: vi.fn(async () => {}), setCompanions: vi.fn(), visionCapable: () => false }
    startBrainSpy.mockImplementation(async ({ adapter }) => {
      adapter.attach({ onChat: vi.fn(), onAttacked: vi.fn(), onDeath: vi.fn(), onSpawn: vi.fn(), onPlayerJoined: vi.fn(), onPlayerLeft: vi.fn() })
      return brain
    })
    const onReady = vi.fn()
    const onError = vi.fn()
    const posted = []
    const handle = await start(config, { onReady, onError, postPortMessage: (m) => posted.push(m), onDashboard: () => {} })
    cleanup.push(() => handle.stop())
    expect(posted).toHaveLength(1)
    expect(posted[0].type).toBe('dst-listen')

    const fake = createFakeMod({ botPort: posted[0].port, token: posted[0].token, prefab: 'wigfrid' })
    cleanup.push(() => fake.stop())
    await fake.start()
    await waitFor(() => onReady.mock.calls.length === 1)
    expect(startBrainSpy).toHaveBeenCalledTimes(1)
    expect(startBrainSpy.mock.calls[0][0].adapter.gameName).toBe("Don't Starve Together")
    expect(onError).not.toHaveBeenCalled()
    // The play/pause forwarder reaches the body through the link.
    handle.setGamePaused(true)
    await handle.stop()
    expect(fake.received.some((c) => c.kind === 'despawn')).toBe(true)
    expect(brain.stop).toHaveBeenCalled()
  })

  it('a config for dontstarve without its block fails to parse', () => {
    expect(() => ConfigSchema.parse({ persona: { name: 'S', expanded: 'x' }, anthropic: { api_key: 'k' }, adapter: { kind: 'dontstarve' } })).toThrow(/adapter\.dontstarve is required/)
  })
})
