// 261113: quality pass 54.
// - A mob's drops she picked up are told apart from a gift (combat_night,
//   11-12 scorecard: "thanks for the rotten flesh lol" after her own zombie
//   kill). itemSources.js tags item spawns by where the game put them.
// - The player's death notice does not wake a second reaction when a turn
//   that showed the death has spoken since.
// - An order put off behind a delivery rides the walk to the player and is
//   kept past the give at the end of it (the goTo-then-give path).

import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { itemSourceAt, trackItemSources, pickupSourcesSince } from '../adapter/minecraft/observers/itemSources.js'
import { trackEntityDeaths } from '../adapter/minecraft/observers/entities.js'
import { attributePickups, createSnapshotComposer } from '../adapter/minecraft/observers/snapshot.js'
import { describeInventoryGain, createInventoryGainRecorder, createHandOverLedger } from './sessionEvents.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

// ─── item sources ───────────────────────────────────────────────────────

function itemBot(inv = []) {
  const bot = new EventEmitter()
  const alex = { id: 2, username: 'Alex', type: 'player', position: new Vec3(10, 64, 0) }
  Object.assign(bot, {
    version: '1.21.1', username: 'Sui', health: 20, food: 20, experience: { level: 0 },
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    entities: { 2: alex }, players: { Alex: { username: 'Alex', entity: alex }, Sui: { username: 'Sui', entity: null } },
    time: { timeOfDay: 14000, day: 1 },
    inventory: { items: () => inv, slots: [] },
    blockAt: () => ({ name: 'air' }), findBlocks: () => [],
    game: { dimension: 'overworld' },
  })
  bot.players.Sui.entity = bot.entity
  return bot
}
const item = (id, pos, name, count) => ({ id, name: 'item', position: pos, getDroppedItem: () => ({ name, count }) })
const zombie = (id, pos) => ({ id, name: 'zombie', type: 'hostile', position: pos })

describe('itemSourceAt', () => {
  it('a drop where a mob just died is that mob\'s', () => {
    const bot = itemBot()
    trackEntityDeaths(bot)
    bot.emit('entityDead', zombie(31, new Vec3(4, 64, 3)))
    expect(itemSourceAt(bot, new Vec3(4.2, 64.3, 2.8))).toEqual({ kind: 'mob', name: 'zombie' })
    // too far from where it died
    expect(itemSourceAt(bot, new Vec3(9, 64, 3))).toBe(null)
  })

  it('a death older than a drop\'s spawn window explains nothing', () => {
    const bot = itemBot()
    trackEntityDeaths(bot)
    bot.emit('entityDead', zombie(31, new Vec3(4, 64, 3)))
    expect(itemSourceAt(bot, new Vec3(4, 64.3, 3), Date.now() + 10_000)).toBe(null)
  })

  it('an item at a player\'s throwing height is their toss, never her own', () => {
    const bot = itemBot()
    expect(itemSourceAt(bot, new Vec3(10.2, 65.32, 0.1))).toEqual({ kind: 'player', name: 'Alex' })
    expect(itemSourceAt(bot, new Vec3(10, 64.97, 0))).toEqual({ kind: 'player', name: 'Alex' })
    // on the ground next to them: not a toss
    expect(itemSourceAt(bot, new Vec3(10, 64.1, 0))).toBe(null)
    // at her own throwing height: not tagged
    expect(itemSourceAt(bot, new Vec3(0, 65.32, 0))).toBe(null)
  })
})

describe('trackItemSources', () => {
  it('keeps her pickups of tagged items, by item', () => {
    const bot = itemBot()
    trackItemSources(bot)
    const t0 = Date.now() - 1
    bot.emit('entityDead', zombie(31, new Vec3(4, 64, 3)))
    const flesh = item(50, new Vec3(4, 64.3, 3), 'rotten_flesh', 2)
    bot.emit('entitySpawn', flesh)
    const bread = item(51, new Vec3(10, 65.32, 0), 'bread', 3)
    bot.emit('entitySpawn', bread)
    const dirt = item(52, new Vec3(-5, 64.2, 0), 'dirt', 1)
    bot.emit('entitySpawn', dirt)
    // someone else picking up is not hers
    bot.emit('playerCollect', bot.entities[2], bread)
    expect(pickupSourcesSince(bot, t0).size).toBe(0)
    bot.emit('playerCollect', bot.entity, flesh)
    bot.emit('playerCollect', bot.entity, dirt)
    const src = pickupSourcesSince(bot, t0)
    expect(src.get('rotten_flesh')).toEqual({ kind: 'mob', name: 'zombie' })
    expect(src.has('dirt')).toBe(false)
    expect(pickupSourcesSince(bot, Date.now() + 1000).size).toBe(0)
  })

  it('an item picked up from two sources has no single source', () => {
    const bot = itemBot()
    trackItemSources(bot)
    const t0 = Date.now() - 1
    bot.emit('entityDead', zombie(31, new Vec3(4, 64, 3)))
    const a = item(50, new Vec3(4, 64.3, 3), 'rotten_flesh', 1)
    const b = item(51, new Vec3(10, 65.32, 0), 'rotten_flesh', 1)
    bot.emit('entitySpawn', a)
    bot.emit('entitySpawn', b)
    bot.emit('playerCollect', bot.entity, a)
    bot.emit('playerCollect', bot.entity, b)
    expect(pickupSourcesSince(bot, t0).has('rotten_flesh')).toBe(false)
  })
})

describe('attributePickups', () => {
  it('moves mob drops out, names a toss, leaves the rest', () => {
    const sources = new Map([['rotten_flesh', { kind: 'mob', name: 'zombie' }], ['bread', { kind: 'player', name: 'Alex' }]])
    const { drops, other } = attributePickups([{ item: 'rotten_flesh', n: 2 }, { item: 'bread', n: 3 }, { item: 'iron_sword', n: 1 }, { item: 'rotten_flesh', n: -1 }], sources)
    expect(drops).toEqual([{ item: 'rotten_flesh', n: 2, from: { kind: 'mob', name: 'zombie' } }])
    expect(other).toEqual([
      { item: 'bread', n: 3, from: { kind: 'player', name: 'Alex' } },
      { item: 'iron_sword', n: 1 },
      { item: 'rotten_flesh', n: -1 },
    ])
  })
})

describe('snapshot composer: a pickup off a mob she killed', () => {
  it('is a quiet line naming the mob, not the inventory banner', () => {
    const inv = [{ name: 'stone_sword', count: 1 }]
    const bot = itemBot(inv)
    const c = createSnapshotComposer({ bot })
    const seen = []
    c.next({ onUnexplainedGains: (g) => seen.push(g) })
    bot.emit('entityDead', zombie(31, new Vec3(4, 64, 3)))
    const flesh = item(50, new Vec3(4, 64.3, 3), 'rotten_flesh', 2)
    bot.emit('entitySpawn', flesh)
    bot.emit('playerCollect', bot.entity, flesh)
    inv.push({ name: 'rotten_flesh', count: 2 })
    const snap = c.next({ onUnexplainedGains: (g) => seen.push(g) })
    expect(snap).toContain('since last tick you picked up what the zombie that died dropped: +2 rotten_flesh')
    expect(snap).not.toContain('INVENTORY JUST CHANGED')
    // the record still gets it, with where it came from
    expect(seen).toEqual([[{ item: 'rotten_flesh', n: 2, from: { kind: 'mob', name: 'zombie' } }]])
  })

  it('a gift with no source still gets the banner', () => {
    const inv = []
    const bot = itemBot(inv)
    const c = createSnapshotComposer({ bot })
    c.next({})
    inv.push({ name: 'bread', count: 4 })
    expect(c.next({})).toContain('INVENTORY JUST CHANGED')
  })

  it('a toss names the player on the banner', () => {
    const inv = []
    const bot = itemBot(inv)
    const c = createSnapshotComposer({ bot })
    c.next({})
    const bread = item(51, new Vec3(10, 65.32, 0), 'bread', 4)
    bot.emit('entitySpawn', bread)
    bot.emit('playerCollect', bot.entity, bread)
    inv.push({ name: 'bread', count: 4 })
    expect(c.next({})).toContain('+4 bread (Alex tossed it)')
  })
})

describe('the session record of a sourced gain', () => {
  it('says a mob\'s drops were her pickup and names a toss', () => {
    expect(describeInventoryGain([{ item: 'rotten_flesh', n: 2, from: { kind: 'mob', name: 'zombie' } }]))
      .toBe('you picked up 2 rotten_flesh the zombie dropped when it died')
    expect(describeInventoryGain([{ item: 'bread', n: 3, from: { kind: 'player', name: 'Alex' } }, { item: 'iron_sword', n: 1 }]))
      .toBe('Alex tossed you 3 bread; 1 iron_sword came into your inventory')
  })

  it('the recorder keeps sources apart when it folds a run', () => {
    const recorded = []
    const rec = createInventoryGainRecorder({ record: (t) => recorded.push(t), spokeBetween: () => false })
    rec([{ item: 'rotten_flesh', n: 2, from: { kind: 'mob', name: 'zombie' } }])
    rec([{ item: 'rotten_flesh', n: 1 }])
    expect(recorded.at(-1)).toBe('you picked up 2 rotten_flesh the zombie dropped when it died; 1 rotten_flesh came into your inventory')
  })

  it('the hand-over ledger leaves a mob\'s drops out', () => {
    const l = createHandOverLedger()
    l.received([{ item: 'rotten_flesh', n: 2, from: { kind: 'mob', name: 'zombie' } }])
    expect(l.describe()).not.toContain('rotten_flesh')
    l.received([{ item: 'bread', n: 3 }])
    expect(l.describe()).toContain('3 bread came into your inventory')
  })
})

// ─── orchestrator harness ───────────────────────────────────────────────

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

// gather, dig and goTo run until settled or aborted; the rest are instant.
const HELD = new Set(['gather', 'dig', 'goTo'])
function makeAdapter(executed, running) {
  const ACTIONS = ['gather', 'dig', 'give', 'goTo', 'follow', 'explore', 'attackEntity']
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ name: z.string().optional(), item: z.string().optional(), player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT\nnext: make a furnace' }),
    handOverResult: (name, r) => (name === 'give' ? /^gave \d/.test(String(r ?? '')) : null),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, _args, opts = {}) => {
      executed.push(name)
      if (!HELD.has(name)) return Promise.resolve(name === 'give' ? 'gave 2 coal to Steve' : `${name} ok`)
      return new Promise((resolve) => {
        running[name] = resolve
        opts.signal?.addEventListener?.('abort', () => resolve(`aborted ${name}`), { once: true })
      })
    },
  }
}

let seq = 0
const config = () => {
  const tag = `${process.pid}-${Date.now()}-${seq++}`
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-p54-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p54-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

const say = (id, text) => ({ id, name: 'say', input: { text } })
const act = (id, name, input = {}) => ({ id, name, input })
const turn = (...toolUses) => ({ text: '', toolUses })
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const DRAINED = new Set(['sei:action_complete', 'sei:chat_received', 'sei:action_tick'])
const flush = () => new Promise((r) => setTimeout(r, 5))
const allText = (call) => JSON.stringify(call?.messages ?? [])

function setup(script) {
  _setTickIntervalForTests(10_000_000)
  const executed = []
  const running = {}
  const queue = []
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter: makeAdapter(executed, running), config: config(),
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  const drain = async () => {
    for (let guard = 0; queue.length && guard < 20; guard++) {
      const next = queue.shift()
      if (DRAINED.has(next.event)) await orch.handleDispatch(next.event, next.data)
    }
  }
  return { orch, provider, executed, running, drain }
}

const LOGS = 'get me like 8 logs, i wanna build a dock'

describe('an order put off behind a delivery, walked back first', () => {
  async function walkThenGive(afterWalk) {
    const h = setup([
      turn(say('s1', 'on it'), act('a1', 'dig', { name: 'coal_ore' })),
      turn(say('s2', '8 logs for a dock, on it')),
      // the dig's completion turn walks back to the player
      turn(say('s3', 'got coal, coming'), act('w1', 'goTo', { player: 'Steve' })),
      // the walk's result
      ...afterWalk,
      turn(act('e9', 'end_loop')),
    ])
    await h.orch.handleDispatch('sei:chat_received', line('grab me some coal'))
    await h.orch.handleDispatch('sei:chat_received', line(LOGS))
    await flush()
    h.running.dig('dug coal_ore; 2 coal')
    await flush()
    await h.drain()
    await flush()
    expect(h.executed).toContain('goTo')
    h.running.goTo('reached Steve (1.4m away)')
    await flush()
    await h.drain()
    await flush()
    return h
  }

  it('is kept past the give at the end of the walk', async () => {
    const h = await walkThenGive([turn(act('g1', 'give', { item: 'coal', player: 'Steve' })), turn(act('e2', 'end_loop'))])
    expect(h.executed).toContain('give')
    const n = h.provider.calls.length
    await h.orch.handleDispatch('sei:idle', { quietMs: 7000 })
    await flush()
    expect(h.provider.calls.length).toBe(n + 1)
    const text = allText(h.provider.calls[n])
    expect(text).toContain('asked earlier')
    expect(text).toContain(LOGS)
  })

  it('other work on the walk\'s completion turn ends it', async () => {
    const h = await walkThenGive([turn(act('d2', 'dig', { name: 'stone' })), turn(act('e2', 'end_loop'))])
    h.running.dig?.('dug stone')
    await flush()
    await h.drain()
    await flush()
    const n = h.provider.calls.length
    await h.orch.handleDispatch('sei:idle', { quietMs: 7000 })
    await flush()
    expect(allText(h.provider.calls[n])).not.toContain('asked earlier')
  })
})

describe('the player\'s death notice after she already reacted', () => {
  const notice = (shownAt) => ({
    username: 'Steve', text: 'just DIED in-game: Steve was blown up by Creeper', message: 'Steve was blown up by Creeper',
    addressed: false, playerSpoke: false, noticeShownAt: () => shownAt,
  })

  it('does not wake a turn when a turn that showed the death spoke since', async () => {
    const h = setup([turn(say('s1', 'oof steve, the creeper got you')), turn(say('s2', 'again'))])
    const shownAt = Date.now()
    await h.orch.handleDispatch('sei:idle', { quietMs: 7000 })
    await flush()
    const n = h.provider.calls.length
    expect(n).toBeGreaterThan(0)
    await h.orch.handleDispatch('sei:chat_received', notice(shownAt))
    await flush()
    expect(h.provider.calls.length).toBe(n)
  })

  it('wakes a turn when no turn has shown it yet, or she has not spoken since', async () => {
    const h = setup([turn(say('s1', 'hey')), turn(say('s2', 'oof steve'))])
    await h.orch.handleDispatch('sei:idle', { quietMs: 7000 })
    await flush()
    const n = h.provider.calls.length
    await h.orch.handleDispatch('sei:chat_received', notice(null))
    await flush()
    expect(h.provider.calls.length).toBeGreaterThan(n)
    const m = h.provider.calls.length
    await h.orch.handleDispatch('sei:chat_received', notice(Date.now() + 60_000))
    await flush()
    expect(h.provider.calls.length).toBeGreaterThan(m)
  })
})
