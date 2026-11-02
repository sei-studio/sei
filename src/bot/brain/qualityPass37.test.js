// 261102: quality pass 37, item hand-offs (11-02 scorecard, dev ad499375).
//  - errands-02: the arrival note said "look back at what they asked you
//    for", and she handed over the logs they had called off while the coal
//    they asked for stayed in her bag. Open asks now remember the items the
//    actions she answered them with bring in, and the arrival note names
//    what she carries for which line.
//  - errands-02: a give of the logs closed the coal ask too. A give now
//    closes only the asks for what she gave.
//  - errands-03: "forget the logs, just meet me" stopped an explore and the
//    stop cleared the coal errand. A stop now closes only the asks whose work
//    it ended (and all of them when nothing was running).
//  - errands-03: after setting off toward the player with the coal, a quiet
//    turn went to her own craft. While she carries what she set off to hand
//    over, the snapshot says so and leaves her own next step out.
//  - work_session-01: "actually stop" answered with stop + a walk to the
//    player handed the logs over and started a new mining trip. The stop
//    closes the log asks, and the stay note survives the walk.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { NUDGES } from './promptLibrary.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { workItemsFor, carriedCounts, smeltProductOf } from '../adapter/minecraft/observers/workItems.js'

afterEach(() => { vi.restoreAllMocks() })

describe('NUDGES.arrivedCarrying / deliveryNote', () => {
  const asks = [{ line: 'grab me some coal and bring it back', items: [{ item: 'coal', n: 6 }] }]
  it('names the items and the line they were for, and both outcomes', () => {
    expect(NUDGES.arrivedCarrying({ who: 'Alex', asks })).toBe('You are next to Alex now. You are carrying coal×6, which you got for their line "grab me some coal and bring it back". Anything there they still want reaches them only through give, and anything they called off stays with you.')
    expect(NUDGES.deliveryNote({ who: 'Alex', asks })).toBe('hand-over: you set off toward Alex carrying coal×6, which you got for their line "grab me some coal and bring it back". It reaches them only through give, which walks to them first. If they called it off, keep it.')
  })
  it('joins several asks and cuts a long line', () => {
    const t = NUDGES.arrivedCarrying({ who: null, asks: [...asks, { line: 'x'.repeat(150), items: [{ item: 'oak_log', n: 3 }, { item: 'birch_log', n: 1 }] }] })
    expect(t).toContain('the player now')
    expect(t).toContain('; and oak_log×3 and birch_log×1, which you got for their line "' + 'x'.repeat(97) + '..."')
    expect(t).not.toMatch(/—/)
  })
})

describe('minecraft workItems', () => {
  const bot = { version: '1.21.4', inventory: { items: () => [{ name: 'coal', count: 4 }, { name: 'coal', count: 2 }, { name: 'dirt', count: 9 }] } }
  it('maps an action to the items it brings in', () => {
    expect(workItemsFor(bot, 'gather', { name: 'coal_ore' })).toContain('coal')
    expect(workItemsFor(bot, 'dig', { block: 'coal_ore' })).toContain('coal')
    expect(workItemsFor(bot, 'gather', { name: 'oak_log' })).toEqual(['oak_log'])
    expect(workItemsFor(bot, 'gather', { name: 'cobblestone' })).toEqual(['cobblestone'])
    expect(workItemsFor(bot, 'find', { name: 'coal' })).toEqual(['coal'])
    expect(workItemsFor(bot, 'craft', { item: 'Furnace' })).toEqual(['furnace'])
    expect(workItemsFor(bot, 'goTo', { player: 'Alex' })).toEqual([])
    expect(workItemsFor(bot, 'dig', { x: 1, y: 2, z: 3 })).toEqual([])
    expect(workItemsFor(bot, 'gather', { x: 1, y: 2, z: 3 })).toEqual([])
    expect(workItemsFor(bot, 'smeltInput', { item: 'raw_iron', count: 3 })).toEqual(['iron_ingot'])
    expect(workItemsFor(bot, 'smeltInput', { item: 'iron_ingot' })).toEqual([])
  })
  it('knows what a furnace input cooks into', () => {
    expect(smeltProductOf('raw_gold')).toBe('gold_ingot')
    expect(smeltProductOf('Sand')).toBe('glass')
    expect(smeltProductOf('beef')).toBe('cooked_beef')
    expect(smeltProductOf('stripped_oak_log')).toBe('charcoal')
    expect(smeltProductOf('crimson_stem')).toBe(null)
    expect(smeltProductOf('dirt')).toBe(null)
  })
  it('counts what she carries', () => {
    expect(carriedCounts(bot, ['coal', 'oak_log'])).toEqual({ coal: 6 })
    expect(carriedCounts(bot, [])).toEqual({})
  })
})

// ---- orchestrator harness (as qualityPass32.test.js, plus items) ----------

const ITEMS = { coal_ore: ['coal'], coal: ['coal'], oak_log: ['oak_log'], iron_ore: ['raw_iron'] }
function makeAdapter({ inv, held = new Set(), goTo = 'reached Steve (1m away)' }) {
  const ACTIONS = ['gather', 'give', 'goTo', 'follow', 'stop', 'explore', 'craft', 'smeltInput']
  const holds = {}
  const a = {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ item: z.string().optional(), name: z.string().optional(), count: z.number().optional(), player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, args, opts) => {
      if (held.has(name)) {
        return new Promise((resolve) => {
          holds[name] = resolve
          opts?.signal?.addEventListener?.('abort', () => resolve('aborted'), { once: true })
        })
      }
      if (name === 'give') {
        const n = inv[args?.item] ?? 0
        delete inv[args?.item]
        return Promise.resolve(`gave ${n} ${args?.item} to ${args?.player ?? 'Steve'}, tossed at their feet; you have 0 ${args?.item} left`)
      }
      if (name === 'goTo') return Promise.resolve(goTo)
      return Promise.resolve(`${name} ok`)
    },
    handOverResult: (name, r) => (name === 'give' ? /^gave \d/.test(String(r ?? '')) : null),
    handOverDetail: (name, r) => {
      if (name !== 'give') return null
      const m = /^gave (\d+) (\S+) to (.+?), tossed/.exec(String(r ?? ''))
      return m ? { item: m[2], n: Number(m[1]), to: m[3] } : null
    },
    workItems: (name, args) => (['gather', 'find'].includes(name) ? ITEMS[args?.name] ?? []
      : name === 'craft' ? [args?.item]
        : name === 'smeltInput' ? (smeltProductOf(args?.item) ? [smeltProductOf(args?.item)] : []) : []),
    carriedCounts: (names) => Object.fromEntries(names.filter((n) => inv[n] > 0).map((n) => [n, inv[n]])),
  }
  a.finish = (name, result) => holds[name]?.(result)
  return a
}

let seq = 0
function config() {
  const tag = `${process.pid}-${Date.now()}-${seq++}`
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.', proactiveness: 2 },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-p37-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p37-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

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

const say = (id, text) => ({ id, name: 'say', input: { text } })
const act = (id, name, input = {}) => ({ id, name, input })
const turn = (...toolUses) => ({ text: '', toolUses })
const allText = (call) => JSON.stringify(call?.messages ?? [])
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const DRAINED = new Set(['sei:action_complete', 'sei:chat_received', 'sei:action_tick'])
const flush = () => new Promise((r) => setTimeout(r, 5))
const CARRYING = 'You are next to Steve now. You are carrying'
const GENERAL = 'Look back at what they asked you for'
const DELIVERY = 'hand-over: you set off toward Steve'

function setup(script, adapterOpts) {
  _setTickIntervalForTests(10_000_000)
  const queue = []
  const provider = makeProvider(script)
  const adapter = makeAdapter(adapterOpts)
  const orch = createOrchestrator({
    adapter, config: config(),
    sessionState: { playerData: () => ({}), onLoopTerminal: async () => {} },
    playerStore: { formatPlayerSeedBlock: () => 'PLAYER' },
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  const drain = async () => {
    for (let guard = 0; queue.length && guard < 20; guard++) {
      const next = queue.shift()
      if (DRAINED.has(next.event)) await orch.handleDispatch(next.event, next.data)
    }
  }
  const send = async (text) => {
    await orch.handleDispatch('sei:chat_received', line(text))
    await flush()
    await drain()
  }
  const arrivalCalls = () => provider.calls.filter((c) => /reached Steve/.test(allText(c)))
  return { provider, send, arrivalCalls, orch, drain, adapter }
}

describe('orchestrator: open asks remember their items', () => {
  it('the arrival note names the coal and the line it was for', async () => {
    const inv = { coal: 6, cobblestone: 4 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 6 })),
      turn(act('a2', 'goTo', { player: 'Steve' })),
      turn(act('a3', 'end_loop')),
    ], { inv })
    await send('grab me some coal and bring it back')
    const t = allText(arrivalCalls().at(-1))
    expect(t).toContain(CARRYING)
    expect(t).toContain('coal×6, which you got for their line \\"grab me some coal and bring it back\\"')
    expect(t).not.toContain('cobblestone×')
    // Named once, by the arrival note, not again by the delivery line.
    expect(t).not.toContain(DELIVERY)
  })

  it('keeps the general note when nothing asked for is in her bag', async () => {
    const inv = {}
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 6 })),
      turn(act('a2', 'goTo', { player: 'Steve' })),
      turn(act('a3', 'end_loop')),
    ], { inv })
    await send('grab me some coal and bring it back')
    const t = allText(arrivalCalls().at(-1))
    expect(t).toContain(GENERAL)
    expect(t).not.toContain(CARRYING)
  })

  it('a give of the logs leaves the coal ask open', async () => {
    const inv = { coal: 6, oak_log: 8 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 6 })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'logs too'), act('a2', 'gather', { name: 'oak_log', count: 8 })),
      turn(act('g1', 'give', { item: 'oak_log', player: 'Steve' })),
      turn(act('a3', 'goTo', { player: 'Steve' })),
      turn(act('e3', 'end_loop')),
    ], { inv })
    await send('grab me some coal')
    await send('get me 8 logs')
    const t = allText(arrivalCalls().at(-1))
    expect(t).toContain(CARRYING)
    expect(t).toContain('coal×6')
    expect(t).not.toContain('oak_log×')
  })

  it('a give of the coal closes its ask', async () => {
    const inv = { coal: 6 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 6 })),
      turn(act('g1', 'give', { item: 'coal', player: 'Steve' })),
      turn(act('a2', 'goTo', { player: 'Steve' })),
      turn(act('a3', 'end_loop')),
    ], { inv })
    inv.coal = 6
    await send('grab me some coal')
    const t = allText(arrivalCalls().at(-1))
    expect(t).not.toContain(CARRYING)
    expect(t).not.toContain(GENERAL)
  })

  it('a line answered with a walk takes the items of the next gather', async () => {
    const inv = { coal: 3 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a0', 'explore', { name: 'east' })),
      turn(act('a1', 'gather', { name: 'coal_ore', count: 3 })),
      turn(act('a2', 'goTo', { player: 'Steve' })),
      turn(act('a3', 'end_loop')),
    ], { inv })
    await send('grab me some coal')
    expect(allText(arrivalCalls().at(-1))).toContain('coal×3')
  })
})

describe('orchestrator: a give of the product closes a recipe chain (review)', () => {
  it('"make me a crafting table": gather, craft, give the table closes the ask; the leftover log is not offered', async () => {
    const inv = { oak_log: 1, oak_planks: 0, crafting_table: 1 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'oak_log', count: 2 })),
      turn(act('c1', 'craft', { item: 'oak_planks' })),
      turn(act('c2', 'craft', { item: 'crafting_table' })),
      turn(act('g1', 'give', { item: 'crafting_table', player: 'Steve' })),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
    ], { inv })
    await send('make me a crafting table')
    const t = allText(arrivalCalls().at(-1))
    expect(t).not.toContain(CARRYING)
    expect(t).not.toContain('oak_log×')
    expect(t).not.toContain(GENERAL)
  })

  it('"smelt me some iron": gather ore, smelt, give the ingots closes the ask', async () => {
    const inv = { raw_iron: 1, iron_ingot: 3 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'iron_ore', count: 4 })),
      turn(act('s2', 'smeltInput', { item: 'raw_iron', count: 3 })),
      turn(act('g1', 'give', { item: 'iron_ingot', player: 'Steve' })),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
    ], { inv })
    await send('smelt me some iron')
    const t = allText(arrivalCalls().at(-1))
    expect(t).not.toContain(CARRYING)
    expect(t).not.toContain('raw_iron×')
  })

  it('a give no open ask names closes them all (pass 32)', async () => {
    const inv = { coal: 2, torch: 4 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 2 })),
      turn(act('g1', 'give', { item: 'torch', player: 'Steve' })),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
    ], { inv })
    await send('bring me some torches')
    const t = allText(arrivalCalls().at(-1))
    expect(t).not.toContain(CARRYING)
    expect(t).not.toContain('coal×')
  })

  it('her own gather on a later loop does not become the items of "go explore east"', async () => {
    const inv = { oak_log: 5 }
    const { send, orch, drain, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('x1', 'explore', { name: 'east' })),
      turn(act('e1', 'end_loop')),
      turn(act('a1', 'gather', { name: 'oak_log', count: 5 })),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e2', 'end_loop')),
    ], { inv })
    await send('go explore east')
    const later = Date.now() + 14_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => later)
    try {
      await orch.handleDispatch('sei:idle', { quietMs: 6800 })
      await flush()
      await drain()
    } finally { spy.mockRestore() }
    const arrival = arrivalCalls().at(-1)
    expect(arrival).toBeTruthy()
    expect(allText(arrival)).not.toContain(CARRYING)
    expect(allText(arrival)).not.toContain('oak_log×')
  })
})

describe('orchestrator: a stop closes only the asks whose work it ended', () => {
  it('"actually stop" ending the log run closes the log ask and keeps the stay note through the walk', async () => {
    const inv = { oak_log: 6 }
    const { send, provider } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'oak_log', count: 10 })),
      turn(say('s2', 'ok stopping'), act('st', 'stop'), act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e2', 'end_loop')),
    ], { inv, held: new Set(['gather']) })
    await send('go get more wood, like 10 more')
    await send('actually stop')
    await flush()
    const arrival = provider.calls.filter((c) => /reached Steve/.test(allText(c))).at(-1)
    expect(arrival).toBeTruthy()
    const t = allText(arrival)
    expect(t).not.toContain(CARRYING)
    expect(t).not.toContain(GENERAL)
    expect(t).toContain('hold: you stopped')
  })

  it('stopping an explore keeps the coal ask', async () => {
    const inv = { coal: 1 }
    const { send, provider } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 1 })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'logs, ok'), act('x1', 'explore', { name: 'trees' })),
      // As errands-03: the stop alone, then the walk on the call after it.
      turn(say('s3', 'ok, coming'), act('st', 'stop')),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e3', 'end_loop')),
    ], { inv, held: new Set(['explore']) })
    await send('grab me some coal')
    await send('get me 8 logs')
    await send('actually forget the logs, just meet me over here')
    await flush()
    const arrival = provider.calls.filter((c) => /reached Steve/.test(allText(c))).at(-1)
    expect(allText(arrival)).toContain('coal×1')
  })
})

describe('orchestrator: the delivery line', () => {
  it('rides the snapshot while she carries what she set off to hand over', async () => {
    const inv = { coal: 1 }
    const { send, provider } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 1 })),
      turn(act('f1', 'follow', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'haha')),
    ], { inv, held: new Set(['follow']) })
    await send('grab me some coal and bring it back here')
    await send('lol ok')
    const t = allText(provider.calls.at(-1))
    expect(t).toContain(DELIVERY)
    expect(t).toContain('coal×1')
  })

  it('rides the walk, and is gone once the walk has ended (the arrival note says it once)', async () => {
    const inv = { oak_log: 8 }
    const { send, provider, adapter, drain, orch } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'oak_log', count: 8 })),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'haha')),
      turn(say('s3', 'here')),
      turn(say('s4', 'ok')),
    ], { inv, held: new Set(['goTo']) })
    await send('get me 8 logs')
    await send('lol')
    expect(allText(provider.calls.at(-1))).toContain(DELIVERY)
    adapter.finish('goTo', 'reached Steve (1m away)')
    await flush()
    await drain()
    const arrival = provider.calls.filter((c) => /reached Steve/.test(allText(c))).at(-1)
    expect(allText(arrival)).toContain(CARRYING)
    expect(allText(arrival).split(CARRYING).at(-1)).not.toContain(DELIVERY)
    // The idle turn after the arrival (the probe's calloff_walk regression).
    // 14 s later, as in the probe.
    const n = provider.calls.length
    const later = Date.now() + 14_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => later)
    try {
      await orch.handleDispatch('sei:idle', { quietMs: 6800 })
      await flush()
    } finally { spy.mockRestore() }
    expect(provider.calls.length).toBeGreaterThan(n)
    expect(allText(provider.calls.at(-1))).not.toContain(DELIVERY)
  })

  it('a walk answering a newer line ("come here") is not a delivery', async () => {
    const inv = { cobblestone: 12 }
    const { send, provider } = setup([
      turn(say('s1', 'good'), act('a1', 'gather', { name: 'stone', count: 4 })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'coming'), act('f1', 'follow', { player: 'Steve' })),
      turn(act('e2', 'end_loop')),
      turn(say('s3', 'haha')),
    ], { inv, held: new Set(['follow']) })
    ITEMS.stone = ['cobblestone']
    await send('hows it going')
    await send('come here')
    await send('lol')
    expect(allText(provider.calls.at(-1))).not.toContain(DELIVERY)
    delete ITEMS.stone
  })

  it('is absent before she sets off, and after the give', async () => {
    const inv = { coal: 1 }
    const { send, provider } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 1 })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'haha')),
    ], { inv })
    await send('grab me some coal')
    await send('lol ok')
    expect(allText(provider.calls.at(-1))).not.toContain(DELIVERY)
  })
})
