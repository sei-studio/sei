// src/bot/brain/index.sessionEvents.test.js
//
// 261014 (quality pass 7b): brain/index.js is where adapter events turn into
// the session's event record (sessionEvents.js, the "game:" lines of the
// conversation transcript). These drive the real start() with the
// orchestrator stubbed, and check what reaches recordGameEvent: a death with
// the hit that caused it, and a Stardew game notice as a short fact rather
// than the instruction text the turn reads.
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const orch = {
  recordGameEvent: vi.fn(),
  recordIncomingChat: vi.fn(),
  handleDispatch: vi.fn(async () => {}),
  handlePreempt: vi.fn(),
  replyWindowRemainingMs: () => 0,
  start: async () => {},
  noteSpawn: async () => {},
  dispose: () => {},
}
vi.mock('./orchestrator.js', () => ({ createOrchestrator: () => orch }))

const { start } = await import('./index.js')
const { wireStardewEvents } = await import('../adapter/stardew/fsmWires.js')

function makeAdapter() {
  let handlers = null
  const adapter = {
    listActions: () => [],
    getActionSchema: () => null,
    getActionDescription: () => '',
    executeAction: async () => '',
    createSnapshotComposer: () => ({ next: () => '' }),
    worldPrimer: () => '',
    attach: (h) => { handlers = h },
    chat: () => {},
    closeAnySessions: async () => {},
    supportsAutoEat: false,
    supportsFollow: false,
    botUsername: 'Sui',
    getKnownPlayers: () => ({}),
  }
  return { adapter, handlers: () => handlers }
}

function makeConfig() {
  return {
    player_username: 'Alex',
    persona: { name: 'Sui', expanded: 'x', proactiveness: 1 },
    llm: { idle_fallback_ms: 10_000_000 },
    memory: {
      player_md_path: path.join(os.tmpdir(), `sei-index-events-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`),
      spawn_settle_delay_ms: 10_000_000,
    },
  }
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

beforeEach(() => {
  orch.recordGameEvent.mockClear()
  orch.recordIncomingChat.mockClear()
})

describe('brain/index.js records game events', () => {
  it('a death is recorded with the hit that caused it', async () => {
    const { adapter, handlers } = makeAdapter()
    const brain = await start({ config: makeConfig(), adapter, logger: quiet })
    handlers().onAttacked({ attackerKind: 'hostile_mob', attackerLabel: 'skeleton' })
    handlers().onDeath({ pos: null })
    const calls = orch.recordGameEvent.mock.calls
    expect(calls[0]).toEqual(['attacked', expect.objectContaining({ attackerLabel: 'skeleton' })])
    expect(calls[1][0]).toBe('death')
    expect(calls[1][1].lastAttack).toMatchObject({ label: 'skeleton', kind: 'hostile_mob' })
    await brain.stop?.()
  })

  it('a death with no recent hit is still recorded', async () => {
    const { adapter, handlers } = makeAdapter()
    const brain = await start({ config: makeConfig(), adapter, logger: quiet })
    handlers().onDeath({ pos: null })
    expect(orch.recordGameEvent.mock.calls).toEqual([['death', {}]])
    await brain.stop?.()
  })

  // 261019 (pass 19): the death report now comes after the respawn and
  // carries the game's death message and the moment she died.
  it('a death carries the game death message, and the cause window is measured from diedAt', async () => {
    const { adapter, handlers } = makeAdapter()
    const brain = await start({ config: makeConfig(), adapter, logger: quiet })
    handlers().onAttacked({ attackerKind: 'hostile_mob', attackerLabel: 'zombie' })
    handlers().onDeath({ pos: null, diedAt: Date.now() + 40_000, deathText: 'Sui fell from a high place', lost: [] })
    const death = orch.recordGameEvent.mock.calls.find((c) => c[0] === 'death')
    expect(death[1]).toEqual({ deathText: 'Sui fell from a high place' })
    await brain.stop?.()
  })

  it('a mob hitting the player is not taken as what killed her', async () => {
    const { adapter, handlers } = makeAdapter()
    const brain = await start({ config: makeConfig(), adapter, logger: quiet })
    handlers().onAttacked({ attackerKind: 'defend', attackerLabel: 'zombie' })
    handlers().onDeath({ pos: null })
    const death = orch.recordGameEvent.mock.calls.find((c) => c[0] === 'death')
    expect(death[1]).toEqual({})
    await brain.stop?.()
  })

  it('a Stardew new-day notice is recorded as a fact, not as chat or instructions', async () => {
    vi.useFakeTimers()
    try {
      const { adapter, handlers } = makeAdapter()
      const brain = await start({ config: makeConfig(), adapter, logger: quiet })
      const e = new EventEmitter()
      const client = { on: (...a) => e.on(...a), off: (...a) => e.off(...a) }
      wireStardewEvents(client, handlers(), { botName: 'Sui' })
      e.emit('day_started', { day: 4, season: 'spring', weather: 'rain' })
      e.emit('obs', { obs: { day: 4, farm: { crops: 15, dryCrops: 15, readyCrops: 0 } } })
      e.emit('night_soon', { time: 2200 })
      expect(orch.recordIncomingChat).not.toHaveBeenCalled()
      const games = orch.recordGameEvent.mock.calls.filter((c) => c[0] === 'game').map((c) => c[1])
      expect(games).toHaveLength(2)
      expect(games[0].fact).toBe('a new day began (spring 4, rain)')
      expect(games[1].fact).toBe('it got to 10 PM')
      // The turn still gets the full notice.
      expect(games[0].text).toMatch(/This is a game event/)
      await brain.stop?.()
    } finally {
      vi.useRealTimers()
    }
  })
})




