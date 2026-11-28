// 261128: quality pass 68. While shelter() ran, the in_flight line read
// "shelter() started=8.5s ago" and nothing else, and she told the player "im
// almost done with the walls" and "shelter's almost up, you're safe in here"
// while it was still digging dirt with no wall placed (11-28 scorecard
// night_social-02). The shelter now reports its stage in words
// (behaviors/shelter.js, tested in shelter.test.js) and the line shows them.
//
// The same scorecard (work_session-02): she gave the player 6 logs, then a
// dirt block her follow walked over hit the loud inventory banner ("the
// player handed you something, ..."), and to "thanks for the help" she said
// "you're the one who gave me the logs". A pickup with no sign of a mob or a
// toss is now a quiet "picked up off the ground" line (itemSources.js).

import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { describe, it, expect } from 'vitest'
import { getInFlightLineForSnapshot } from './inflight.js'
import { trackItemSources, pickupSourcesSince } from '../adapter/minecraft/observers/itemSources.js'
import { attributePickups, createSnapshotComposer } from '../adapter/minecraft/observers/snapshot.js'
import { describeInventoryGain, createInventoryGainRecorder, createHandOverLedger } from './sessionEvents.js'

const shelter = (progress) => ({ name: 'shelter', args: { size: 3 }, startedAt: 0, progress })

describe('shelter in_flight line', () => {
  it('shows the stage text the shelter reports', () => {
    const text = 'still digging up blocks to build it with, about 2s each (8 of the 25 it needs so far). Nothing is built yet: no wall or roof is placed'
    expect(getInFlightLineForSnapshot(shelter({ text }), 8_500)).toBe(`in_flight: shelter() started=8.5s ago — ${text}`)
  })

  it('keeps the bare line with no progress', () => {
    expect(getInFlightLineForSnapshot(shelter(null), 1_000)).toBe('in_flight: shelter() started=1.0s ago')
  })

  it('a build keeps its own placed count', () => {
    const l = getInFlightLineForSnapshot({ name: 'build', args: {}, startedAt: 0, progress: { placed: 4, skipped: 0, total: 9 } }, 1_000)
    expect(l).toContain('placed 4 of 9 so far')
  })
})

function itemBot(inv = []) {
  const bot = new EventEmitter()
  const alex = { id: 2, username: 'Alex', type: 'player', position: new Vec3(10, 64, 0) }
  Object.assign(bot, {
    version: '1.21.1', username: 'Sui', health: 20, food: 20, experience: { level: 0 },
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    entities: { 2: alex }, players: { Alex: { username: 'Alex', entity: alex }, Sui: { username: 'Sui', entity: null } },
    time: { timeOfDay: 6000, day: 1 },
    inventory: { items: () => inv, slots: [] },
    blockAt: () => ({ name: 'air' }), findBlocks: () => [],
    game: { dimension: 'overworld' },
  })
  bot.players.Sui.entity = bot.entity
  return bot
}
const item = (id, pos, name, count) => ({ id, name: 'item', position: pos, getDroppedItem: () => ({ name, count }) })

describe('a pickup off the ground', () => {
  it('is tagged ground when no mob or toss explains it', () => {
    const bot = itemBot()
    trackItemSources(bot)
    const t0 = Date.now() - 1
    const dirt = item(52, new Vec3(-5, 64.2, 0), 'dirt', 1)
    const bread = item(51, new Vec3(10, 65.32, 0), 'bread', 3)
    bot.emit('entitySpawn', dirt)
    bot.emit('entitySpawn', bread)
    bot.emit('playerCollect', bot.entity, dirt)
    bot.emit('playerCollect', bot.entity, bread)
    const src = pickupSourcesSince(bot, t0)
    expect(src.get('dirt')).toEqual({ kind: 'ground', name: '' })
    expect(src.get('bread')).toEqual({ kind: 'player', name: 'Alex' })
    const { ground, other, drops } = attributePickups([{ item: 'dirt', n: 1 }, { item: 'bread', n: 3 }], src)
    expect(ground).toEqual([{ item: 'dirt', n: 1, from: { kind: 'ground', name: '' } }])
    expect(other).toEqual([{ item: 'bread', n: 3, from: { kind: 'player', name: 'Alex' } }])
    expect(drops).toEqual([])
  })

  it('is a quiet line, not the inventory banner, and goes to the record', () => {
    const inv = [{ name: 'oak_log', count: 2 }]
    const bot = itemBot(inv)
    const c = createSnapshotComposer({ bot })
    const seen = []
    c.next({ onUnexplainedGains: (g) => seen.push(g) })
    const dirt = item(52, new Vec3(1, 64.2, 0), 'dirt', 1)
    bot.emit('entitySpawn', dirt)
    bot.emit('playerCollect', bot.entity, dirt)
    inv.push({ name: 'dirt', count: 1 })
    const snap = c.next({ onUnexplainedGains: (g) => seen.push(g) })
    expect(snap).toContain('since last tick you picked up off the ground: +1 dirt (already counted on the inventory line above)')
    expect(snap).not.toContain('INVENTORY JUST CHANGED')
    // dirt is neither gear nor food, so the record is not told
    expect(seen).toEqual([])
  })

  it('a gain with no pickup at all (a /give) still gets the banner', () => {
    const inv = []
    const bot = itemBot(inv)
    const c = createSnapshotComposer({ bot })
    c.next({})
    inv.push({ name: 'bread', count: 4 })
    const snap = c.next({})
    expect(snap).toContain('INVENTORY JUST CHANGED')
    expect(snap).not.toContain('off the ground')
  })

  it('the record says it was picked up off the ground and the ledger leaves it out', () => {
    expect(describeInventoryGain([{ item: 'iron_sword', n: 1, from: { kind: 'ground', name: '' } }]))
      .toBe('you picked up 1 iron_sword off the ground')
    const recorded = []
    const rec = createInventoryGainRecorder({ record: (t) => recorded.push(t), spokeBetween: () => false })
    rec([{ item: 'bread', n: 2, from: { kind: 'ground', name: '' } }])
    rec([{ item: 'bread', n: 1 }])
    expect(recorded.at(-1)).toBe('you picked up 2 bread off the ground; 1 bread came into your inventory')
    const l = createHandOverLedger()
    l.received([{ item: 'bread', n: 2, from: { kind: 'ground', name: '' } }])
    expect(l.describe()).not.toContain('bread')
  })
})

// 261128 (pass 68 review): 'ground' only with a sign of it. A toss we place
// wrong (a moving player, our copy of their position a tick behind) must
// still reach the banner, whose reasons include a hand-over.
describe("'ground' is conservative", () => {
  const block = (name, x, y, z) => ({ name, position: new Vec3(x, y, z) })
  const zombie = (id, pos) => ({ id, name: 'zombie', type: 'hostile', position: pos })

  it('a toss by a moving player, 1.2 off where we have them, is not ground: it gets the banner', () => {
    const inv = []
    const bot = itemBot(inv)
    const c = createSnapshotComposer({ bot })
    c.next({})
    const t0 = Date.now() - 1
    const bread = item(60, new Vec3(11.2, 65.32, 0), 'bread', 3)
    bot.emit('entitySpawn', bread)
    bot.emit('playerCollect', bot.entity, bread)
    expect(pickupSourcesSince(bot, t0).has('bread')).toBe(false)
    inv.push({ name: 'bread', count: 3 })
    const snap = c.next({})
    expect(snap).toContain('INVENTORY JUST CHANGED')
    expect(snap).not.toContain('off the ground')
  })

  it('an item at a block center next to the player, with no block broken there, is not ground', () => {
    const bot = itemBot()
    trackItemSources(bot)
    const t0 = Date.now() - 1
    const it = item(61, new Vec3(11.5, 64.4, 0.5), 'apple', 1)
    bot.emit('entitySpawn', it)
    bot.emit('playerCollect', bot.entity, it)
    expect(pickupSourcesSince(bot, t0).has('apple')).toBe(false)
  })

  it('dirt broken on her follow walk, beside the player, is ground (the block update comes after the drop)', () => {
    const bot = itemBot()
    trackItemSources(bot)
    const t0 = Date.now() - 1
    const dirt = item(62, new Vec3(10.62, 64.41, 1.38), 'dirt', 1)
    bot.emit('entitySpawn', dirt)
    bot.emit('blockUpdate', block('dirt', 10, 64, 1), block('air', 10, 64, 1))
    bot.emit('playerCollect', bot.entity, dirt)
    expect(pickupSourcesSince(bot, t0).get('dirt')).toEqual({ kind: 'ground', name: '' })
  })

  it('a block broken one cell over does not explain it', () => {
    const bot = itemBot()
    trackItemSources(bot)
    const t0 = Date.now() - 1
    const dirt = item(63, new Vec3(10.62, 64.41, 1.38), 'dirt', 1)
    bot.emit('entitySpawn', dirt)
    bot.emit('blockUpdate', block('dirt', 11, 64, 1), block('air', 11, 64, 1))
    bot.emit('playerCollect', bot.entity, dirt)
    expect(pickupSourcesSince(bot, t0).has('dirt')).toBe(false)
  })

  it('an item nobody else stood near is ground', () => {
    const bot = itemBot()
    trackItemSources(bot)
    const t0 = Date.now() - 1
    const stick = item(64, new Vec3(5.9, 64.02, 0.1), 'stick', 1)
    bot.emit('entitySpawn', stick)
    bot.emit('playerCollect', bot.entity, stick)
    expect(pickupSourcesSince(bot, t0).get('stick')).toEqual({ kind: 'ground', name: '' })
  })

  it("a mob's drop is the mob's even though vanilla sends the death after the drop spawns", () => {
    const bot = itemBot()
    trackItemSources(bot)
    const t0 = Date.now() - 1
    // the zombie died 1 block from Alex, so it is not "nobody near" either
    const flesh = item(65, new Vec3(9.3, 64.1, 0.7), 'rotten_flesh', 2)
    bot.emit('entitySpawn', flesh)
    bot.emit('entityDead', zombie(31, new Vec3(9.2, 64, 0.8)))
    bot.emit('playerCollect', bot.entity, flesh)
    expect(pickupSourcesSince(bot, t0).get('rotten_flesh')).toEqual({ kind: 'mob', name: 'zombie' })
  })

  it('a toss in the same spot as a mob death a minute ago is still the toss', () => {
    const bot = itemBot()
    trackItemSources(bot)
    bot._seiRecentLosses.set(31, { name: 'zombie', died: true, at: Date.now() - 60_000, pos: { x: 10, y: 64, z: 0 } })
    const t0 = Date.now() - 1
    const bread = item(66, new Vec3(10.2, 65.32, 0.1), 'bread', 1)
    bot.emit('entitySpawn', bread)
    bot.emit('playerCollect', bot.entity, bread)
    expect(pickupSourcesSince(bot, t0).get('bread')).toEqual({ kind: 'player', name: 'Alex' })
  })
})
