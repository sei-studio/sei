// 261014: quality pass 7a, wrong counts and announced-but-not-taken actions.
//  - the gather in_flight line says what she holds now and how many are left,
//    read from the same inventory as the inventory line
//  - the gather tick carries its drop items and the starting count
//  - inventory changes her own actions explain are stated as hers and as
//    already counted, not under the "the player handed you something" banner
//  - a player line that arrives while nothing runs says so, instead of telling
//    her a say() "keeps the current action going"
//  - say() asks for the count on this turn's inventory line

import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { Vec3 } from 'vec3'
import { createInflightTracker, describeArgs, getInFlightLineForSnapshot } from './inflight.js'
import { createSnapshotComposer, splitOwnInventoryChanges, isGearOrFood, looksLikeWholeInventoryLost } from '../adapter/minecraft/observers/snapshot.js'
import { NUDGES, PERSONALITY_TOOL_DESCRIPTIONS } from './promptLibrary.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

describe('gather in_flight line from the live inventory', () => {
  const gather = (progress) => ({ name: 'gather', args: { name: 'oak_log', count: 6 }, startedAt: 0, progress })

  it('names the gathered block', () => {
    expect(describeArgs('gather', { name: 'oak_log', count: 6 })).toBe('oak_log')
    expect(getInFlightLineForSnapshot(gather(null), 1000)).toBe('in_flight: gather(oak_log) started=1.0s ago')
  })

  it('counts what she holds now, not the lagging tick', () => {
    // The tick still says 1 picked up; the inventory already has the second.
    const line = getInFlightLineForSnapshot(
      gather({ dug: 1, total: 6, items: ['oak_log'], before: 2 }), 3000, { inventory: { oak_log: 4, dirt: 3 } })
    expect(line).toBe('in_flight: gather(oak_log) started=3.0s ago — picked up 2 of the 6 oak_log asked for so far, 4 to go; you hold 4 oak_log right now')
  })

  it('never goes below zero to go, or below zero picked up', () => {
    expect(getInFlightLineForSnapshot(gather({ dug: 6, total: 6, items: ['oak_log'], before: 0 }), 0, { inventory: { oak_log: 7 } }))
      .toContain('picked up 7 of the 6 oak_log asked for so far, 0 to go; you hold 7 oak_log right now')
    expect(getInFlightLineForSnapshot(gather({ dug: 0, total: 6, items: ['oak_log'], before: 3 }), 0, { inventory: {} }))
      .toContain('picked up 0 of the 6 oak_log asked for so far, 6 to go; you hold 0 oak_log right now')
  })

  it('keeps the blocks-broken wording without an inventory or drop items', () => {
    expect(getInFlightLineForSnapshot(gather({ dug: 1, total: 6, items: ['oak_log'], before: 0 }), 0))
      .toContain('broke 1 of the 6 blocks asked for so far')
    expect(getInFlightLineForSnapshot(gather({ dug: 1, total: 6 }), 0, { inventory: { oak_log: 1 } }))
      .toContain('broke 1 of the 6 blocks asked for so far')
  })
})

describe('inflight tracker history', () => {
  it('keeps finished actions with their last progress, plus the running one', () => {
    const t = createInflightTracker()
    const a = t.start({ name: 'gather', args: { name: 'oak_log' } })
    t.updateProgress(a, { dug: 3, total: 3, items: ['oak_log'], before: 0 })
    t.end(a)
    const b = t.start({ name: 'craft', args: { item: 'oak_planks' } })
    const r = t.recent()
    expect(r.map(e => e.name)).toEqual(['gather', 'craft'])
    expect(r[0].endedAt).toEqual(expect.any(Number))
    expect(r[0].progress.items).toEqual(['oak_log'])
    expect(r[1].endedAt).toBeNull()
    t.end(b)
    t.end(b)
    expect(t.recent().length).toBe(2)
  })

  it('is bounded', () => {
    const t = createInflightTracker()
    for (let i = 0; i < 20; i++) t.end(t.start({ name: 'goTo', args: {} }))
    expect(t.recent().length).toBe(8)
  })
})

describe('splitOwnInventoryChanges', () => {
  const now = 100_000
  const since = 90_000
  const running = (name, progress) => ({ name, startedAt: 80_000, endedAt: null, progress })

  it('credits a gather with its own drop items only', () => {
    const r = splitOwnInventoryChanges(
      [{ item: 'oak_log', n: 2 }, { item: 'bread', n: 1 }],
      [running('gather', { items: ['oak_log'] })], since, now)
    expect(r.own).toEqual([{ item: 'oak_log', n: 2 }])
    expect(r.ownNames).toEqual(['gather'])
    expect(r.other).toEqual([{ item: 'bread', n: 1 }])
  })

  it('credits a craft with its output and the ingredients it used', () => {
    const r = splitOwnInventoryChanges(
      [{ item: 'oak_planks', n: 4 }, { item: 'oak_log', n: -1 }],
      [{ name: 'craft', args: { item: 'oak_planks', count: 4 }, startedAt: 91_000, endedAt: 92_000 }], since, now)
    expect(r.own.length).toBe(2)
    expect(r.other).toEqual([])
  })

  it('does not credit a walk or a follow with what she picked up', () => {
    const r = splitOwnInventoryChanges([{ item: 'oak_log', n: 3 }], [running('follow'), running('goTo')], since, now)
    expect(r.own).toEqual([])
    expect(r.other).toEqual([{ item: 'oak_log', n: 3 }])
  })

  it('ignores an action that finished well before the last tick', () => {
    const r = splitOwnInventoryChanges([{ item: 'oak_log', n: 1 }],
      [{ name: 'gather', startedAt: 50_000, endedAt: 60_000, progress: { items: ['oak_log'] } }], since, now)
    expect(r.own).toEqual([])
  })

  it('handles no actions', () => {
    expect(splitOwnInventoryChanges([{ item: 'dirt', n: 1 }], undefined, since, now).other.length).toBe(1)
  })
})

describe('splitOwnInventoryChanges: gifts and deaths (261014 follow-up)', () => {
  const now = 100_000
  const since = 90_000
  const running = (name, args, progress) => ({ name, args, startedAt: 80_000, endedAt: null, progress })

  it('a fight explains no gain: a sword and bread tossed mid-fight are not hers', () => {
    const r = splitOwnInventoryChanges(
      [{ item: 'iron_sword', n: 1 }, { item: 'bread', n: 3 }, { item: 'rotten_flesh', n: 1 }],
      [running('attackEntity', { target: 'zombie' })], since, now)
    expect(r.own).toEqual([])
    expect(r.other.length).toBe(3)
  })

  it('a craft owns its output and the parts it makes, not a tool or food that arrived alongside', () => {
    const r = splitOwnInventoryChanges(
      [{ item: 'stone_pickaxe', n: 1 }, { item: 'stick', n: 2 }, { item: 'oak_planks', n: 1 },
        { item: 'iron_sword', n: 1 }, { item: 'bread', n: 2 }, { item: 'cobblestone', n: 5 }],
      [running('craft', { item: 'stone_pickaxe', count: 1 })], since, now)
    expect(r.own.map(d => d.item)).toEqual(['stone_pickaxe', 'stick', 'oak_planks'])
    expect(r.other.map(d => d.item)).toEqual(['iron_sword', 'bread', 'cobblestone'])
  })

  it('dig, pickup and withdraw own plain blocks but not gear or food they did not name', () => {
    const deltas = [{ item: 'cobblestone', n: 3 }, { item: 'diamond_pickaxe', n: 1 }, { item: 'cooked_beef', n: 4 }]
    for (const a of [running('dig', { block: 'stone' }), running('pickup', {}), running('withdrawItem', { item: 'cobblestone' })]) {
      const r = splitOwnInventoryChanges(deltas, [a], since, now)
      expect(r.own.map(d => d.item)).toEqual(['cobblestone'])
      expect(r.other.map(d => d.item)).toEqual(['diamond_pickaxe', 'cooked_beef'])
    }
  })

  it('a pickup or withdraw that names a tool or food owns it', () => {
    expect(splitOwnInventoryChanges([{ item: 'iron_sword', n: 1 }], [running('pickup', { item: 'iron_sword' })], since, now).own.length).toBe(1)
    expect(splitOwnInventoryChanges([{ item: 'bread', n: 5 }], [running('withdrawItem', { item: 'bread', count: 5 })], since, now).own.length).toBe(1)
  })

  it('a gather that names its drops owns them even when they are food; one that does not, owns no gear or food', () => {
    expect(splitOwnInventoryChanges([{ item: 'apple', n: 1 }], [running('gather', {}, { items: ['apple'] })], since, now).own.length).toBe(1)
    const r = splitOwnInventoryChanges([{ item: 'dirt', n: 2 }, { item: 'bread', n: 1 }], [running('gather', {}, null)], since, now)
    expect(r.own.map(d => d.item)).toEqual(['dirt'])
    expect(r.other.map(d => d.item)).toEqual(['bread'])
  })

  it('after a death no loss is blamed on the running action, and a tool breaking still is', () => {
    const lost = [{ item: 'oak_log', n: -12 }, { item: 'stone_axe', n: -1 }]
    const dead = splitOwnInventoryChanges(lost, [running('gather', {}, { items: ['oak_log'] })], since, now, { died: true })
    expect(dead.own).toEqual([])
    expect(dead.other).toEqual(lost)
    const worn = splitOwnInventoryChanges([{ item: 'stone_axe', n: -1 }], [running('gather', {}, { items: ['oak_log'] })], since, now)
    expect(worn.own).toEqual([{ item: 'stone_axe', n: -1 }])
  })

  it('classifies gear and food, using a registry list when given one', () => {
    for (const it of ['iron_sword', 'stone_pickaxe', 'diamond_chestplate', 'bow', 'shield', 'bread', 'cooked_beef']) expect(isGearOrFood(it)).toBe(true)
    for (const it of ['cobblestone', 'oak_log', 'stick', 'coal', 'oak_planks']) expect(isGearOrFood(it)).toBe(false)
    expect(isGearOrFood('weird_berry', (n) => n === 'weird_berry')).toBe(true)
    expect(isGearOrFood('bread', () => false)).toBe(false)
  })

  it('reads a whole inventory gone at once as a death', () => {
    expect(looksLikeWholeInventoryLost({ oak_log: 12, stone_axe: 1 }, {})).toBe(true)
    expect(looksLikeWholeInventoryLost({ oak_log: 1 }, {})).toBe(false)
    expect(looksLikeWholeInventoryLost({ oak_log: 12, stone_axe: 1 }, { stone_axe: 1 })).toBe(false)
    expect(looksLikeWholeInventoryLost(null, {})).toBe(false)
  })
})

describe('snapshot composer: her own haul vs. a gift', () => {
  function fakeBot(inv) {
    const bot = new EventEmitter()
    Object.assign(bot, {
      version: '1.21.1', username: 'Sui', health: 20, food: 20, experience: { level: 0 },
      entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      entities: {}, players: {}, time: { timeOfDay: 6000, day: 1 },
      inventory: { items: () => inv, slots: [] },
      blockAt: () => ({ name: 'air' }), findBlocks: () => [],
      game: { dimension: 'overworld' },
    })
    return bot
  }

  it('states a gather\'s logs as hers and already counted', () => {
    const inv = [{ name: 'oak_log', count: 2 }]
    const c = createSnapshotComposer({ bot: fakeBot(inv) })
    c.next({})
    inv[0].count = 4
    const now = Date.now()
    const progress = { dug: 1, total: 6, items: ['oak_log'], before: 2 }
    const snap = c.next({
      inFlight: { id: 1, name: 'gather', args: { name: 'oak_log', count: 6 }, startedAt: now - 5000, progress },
      recentActions: [{ name: 'gather', startedAt: now - 5000, endedAt: null, progress }],
    })
    expect(snap).toContain('picked up 2 of the 6 oak_log asked for so far, 4 to go; you hold 4 oak_log right now')
    expect(snap).toContain('since last tick your own gather changed your inventory: +2 oak_log (already counted on the inventory line above)')
    expect(snap).not.toContain('INVENTORY JUST CHANGED')
    const lines = snap.split('\n')
    const i = lines.findIndex(l => l.startsWith('inventory ('))
    expect(lines[i + 1]).toMatch(/^since last tick your own gather/)
  })

  it('keeps the banner for a change no action of hers explains', () => {
    const inv = [{ name: 'oak_log', count: 2 }]
    const c = createSnapshotComposer({ bot: fakeBot(inv) })
    c.next({})
    inv.push({ name: 'bread', count: 3 })
    inv[0].count = 3
    const now = Date.now()
    const snap = c.next({ recentActions: [{ name: 'gather', startedAt: now - 3000, endedAt: null, progress: { items: ['oak_log'], before: 2 } }] })
    expect(snap).toContain('your own gather changed your inventory: +1 oak_log')
    expect(snap).toMatch(/INVENTORY JUST CHANGED \*\*\*: \+3 bread {2}<-/)
    const lines = snap.split('\n')
    const i = lines.findIndex(l => l.startsWith('inventory ('))
    expect(lines[i + 1]).toMatch(/^since last tick your own gather/)
    expect(lines[i + 2]).toMatch(/^\*\*\* INVENTORY JUST CHANGED/)
  })

  it('raises the banner for a sword and bread tossed to her mid-fight', () => {
    const inv = [{ name: 'oak_log', count: 2 }]
    const c = createSnapshotComposer({ bot: fakeBot(inv) })
    c.next({})
    inv.push({ name: 'iron_sword', count: 1 }, { name: 'bread', count: 3 })
    const now = Date.now()
    const snap = c.next({ recentActions: [{ name: 'attackEntity', args: { target: 'zombie' }, startedAt: now - 3000, endedAt: null }] })
    expect(snap).toMatch(/INVENTORY JUST CHANGED \*\*\*: \+1 iron_sword, \+3 bread/)
    expect(snap).not.toContain('your own attackEntity')
  })

  it('does not blame a death\'s dropped inventory on the gather that was running', () => {
    const inv = [{ name: 'oak_log', count: 12 }, { name: 'stone_axe', count: 1 }]
    const bot = fakeBot(inv)
    const c = createSnapshotComposer({ bot })
    c.next({})
    bot.emit('death')
    inv.length = 0
    inv.push({ name: 'oak_log', count: 1 })   // one log picked up again after the respawn
    const now = Date.now()
    const gather = { name: 'gather', startedAt: now - 9000, endedAt: now - 500, progress: { items: ['oak_log'], before: 0 } }
    const snap = c.next({ recentActions: [gather] })
    expect(snap).not.toMatch(/your own gather changed your inventory: .*-/)
    expect(snap).toMatch(/INVENTORY JUST CHANGED \*\*\*: -11 oak_log, -1 stone_axe {2}<-/)
    // The death flag lasts one window: the next tick's gather loss is hers again.
    inv[0].count = 0
    const snap2 = c.next({ recentActions: [{ ...gather, endedAt: null }] })
    expect(snap2).toContain('your own gather changed your inventory: -1 oak_log')
  })

  it('treats a whole inventory gone at once as a death even without the event', () => {
    const inv = [{ name: 'oak_log', count: 12 }, { name: 'stone_axe', count: 1 }]
    const c = createSnapshotComposer({ bot: fakeBot(inv) })
    c.next({})
    inv.length = 0
    const now = Date.now()
    const snap = c.next({ recentActions: [{ name: 'gather', startedAt: now - 9000, endedAt: null, progress: { items: ['oak_log'], before: 0 } }] })
    expect(snap).not.toContain('your own gather')
    expect(snap).toMatch(/INVENTORY JUST CHANGED \*\*\*: -12 oak_log, -1 stone_axe/)
  })
})

describe('prompt text', () => {
  it('the player-line hints no longer claim an action is running', () => {
    for (const k of ['playerInterruptHint', 'playerInterruptHintGroupVoice', 'playerInterruptHintGreetCrossed']) {
      expect(NUDGES[k]).not.toContain('keeps the current action going')
    }
    expect(NUDGES.replyWhileRunning).toContain('keeps the current action going')
    expect(NUDGES.replyWhileIdle).toContain('No action is running right now')
  })

  it('say() points at this turn\'s inventory line for counts', () => {
    expect(PERSONALITY_TOOL_DESCRIPTIONS.say).toContain('use the count on your inventory line this turn')
  })
})

describe('orchestrator: a player line while nothing runs', () => {
  function makeProvider(script) {
    let i = 0
    const calls = []
    return {
      calls,
      buildCachedSystem: (blocks) => blocks,
      setAuthToken() {},
      setBackend() {},
      async call(args) {
        calls.push(args)
        const r = script[Math.min(i, script.length - 1)]
        i += 1
        return typeof r === 'function' ? r(args) : r
      },
    }
  }
  function makeAdapter() {
    const ACTIONS = ['follow', 'unfollow', 'goTo', 'gather', 'dig']
    return {
      listActions: () => ACTIONS,
      getActionSchema: () => z.object({ player: z.string().optional(), name: z.string().optional() }),
      getActionDescription: (n) => `do ${n}`,
      capabilityParagraph: () => 'caps',
      worldPrimer: () => 'world',
      actionRules: () => 'rules',
      eventAddendum: () => '',
      createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
      chat: vi.fn(),
      closeAnySessions: async () => {},
      executeAction: (name) => (name === 'follow' || name === 'gather' ? new Promise(() => {}) : Promise.resolve('done')),
    }
  }
  const config = () => ({
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 30, debounce_ms: 0, max_hops: 5 },
    memory: { memory_md_path: path.join(os.tmpdir(), `sei-p7a-test-${process.pid}-${Date.now()}.md`), iteration_cap: 30 },
  })

  it('tells her nothing is running, so a promise needs its action this turn', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([{ text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'yo' } }] }])
    const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', { text: 'can you get wood', username: 'Steve', playerSpoke: true, ts: Date.now() })
    const turn = JSON.stringify(provider.calls[0].messages ?? provider.calls[0])
    expect(turn).toContain('can you get wood')
    expect(turn).toContain(NUDGES.replyWhileIdle)
    expect(turn).not.toContain('keeps the current action going')
    // 261029 (pass 30): it comes once, right after the closing "Answer it
    // with say().", not up in the event hints.
    const at = turn.indexOf(NUDGES.replyWhileIdle)
    expect(turn.indexOf(NUDGES.replyWhileIdle, at + 1)).toBe(-1)
    expect(at).toBeGreaterThan(turn.indexOf('Answer it with say().'))
    expect(at).toBeGreaterThan(turn.indexOf('can you get wood'))
  })

  it('a fresh loop opened while an earlier loop\'s action still runs says the reply keeps it going', async () => {
    // The drained batch case: a loop tore down, its leftover gather runs on
    // with no loop (tracked by the inflight tracker, not loop.inFlight), and
    // a player line opens a fresh loop.
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([{ text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'still chopping' } }] }])
    const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    const leftover = orch.inflight.start({ name: 'gather', args: { name: 'oak_log', count: 8 } })
    expect(orch.currentLoop).toBeNull()
    await orch.handleDispatch('sei:chat_received', { text: 'how is it going', username: 'Steve', playerSpoke: true, ts: Date.now() })
    expect(provider.calls.length).toBe(1)
    const turn = JSON.stringify(provider.calls[0].messages ?? provider.calls[0])
    expect(turn).toContain('how is it going')
    expect(turn).toContain(NUDGES.replyWhileRunning)
    expect(turn).not.toContain(NUDGES.replyWhileIdle)
    orch.inflight.end(leftover)
  })

  it('names the running action, not an end_loop from an earlier mid-action turn', async () => {
    // Shape of pass6b errands-02-A: the gather starts, a "hey" is answered
    // with end_loop alone (the gather keeps running), and the next player
    // line used to read "You're currently: end_loop".
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'g1', name: 'gather', input: { name: 'oak_log' } }] },
      { text: '', toolUses: [{ id: 'e1', name: 'end_loop', input: {} }] },
      { text: '', toolUses: [{ id: 's2', name: 'say', input: { text: 'chopping' } }] },
    ])
    const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', { text: 'can you get wood', username: 'Steve', playerSpoke: true, ts: Date.now() })
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
    await orch.handleDispatch('sei:chat_received', { text: 'hey', username: 'Steve', playerSpoke: true, ts: Date.now() })
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
    await orch.handleDispatch('sei:chat_received', { text: 'what are you doing', username: 'Steve', playerSpoke: true, ts: Date.now() })
    expect(provider.calls.length).toBe(3)
    const turn = JSON.stringify(provider.calls[2].messages ?? provider.calls[2])
    expect(turn).toContain('what are you doing')
    expect(turn).toContain("You're currently: gather oak_log")
    expect(turn).not.toContain("You're currently: end_loop")
  })
})
