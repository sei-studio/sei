// 261111: quality pass 52, item bookkeeping (11-11 scorecard, dev 9c1bca50).
//  - work_session: an open ask kept every item of the work she answered a
//    line with, so "yeah sounds good" answered with craft(wooden_pickaxe)
//    became "you are walking to Alex carrying wooden_pickaxe×1, which you got
//    for their line "yeah sounds good"" on her next walk to the player, and
//    the arrival note offered it to them. All three 11-11 work_sessions
//    carried one, on the turns where she gave her pickaxe away unasked and
//    credited the player with the logs she had given them. An ask now keeps
//    only the items its line names (minecraft itemsNamedIn).

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { itemsNamedIn, smeltProductOf } from '../adapter/minecraft/observers/workItems.js'

afterEach(() => { vi.restoreAllMocks() })

const FOODS = { beef: {}, cooked_beef: {}, bread: {}, apple: {} }

describe('minecraft itemsNamedIn', () => {
  it('keeps the items a line names by their own words', () => {
    expect(itemsNamedIn('can you get some wood? like 6 logs', ['oak_log'])).toEqual(['oak_log'])
    expect(itemsNamedIn('grab me some coal', ['coal'])).toEqual(['coal'])
    expect(itemsNamedIn('make a crafting table', ['crafting_table', 'cobblestone'])).toEqual(['crafting_table'])
    expect(itemsNamedIn('can you get torches', ['torch', 'coal', 'stick'])).toEqual(['torch'])
    expect(itemsNamedIn('get me some planks', ['oak_planks', 'oak_log'])).toEqual(['oak_planks'])
  })
  it('knows a base, a metal, a loose term and a short name', () => {
    expect(itemsNamedIn('smelt me some iron', ['iron_ingot', 'raw_iron'])).toEqual(['iron_ingot', 'raw_iron'])
    expect(itemsNamedIn('i need stone', ['cobblestone', 'stone', 'dirt'])).toEqual(['cobblestone', 'stone'])
    expect(itemsNamedIn('get me cobble', ['cobblestone'])).toEqual(['cobblestone'])
    expect(itemsNamedIn('make me a pick', ['wooden_pickaxe', 'stick'])).toEqual(['wooden_pickaxe'])
    expect(itemsNamedIn('cook me some beef', ['cooked_beef'])).toEqual(['cooked_beef'])
  })
  it('"food" covers what she can eat when the registry is given', () => {
    expect(itemsNamedIn('get me some food', ['cooked_beef', 'wheat'], { foods: FOODS })).toEqual(['cooked_beef'])
    expect(itemsNamedIn('get me some food', ['cooked_beef'])).toEqual([])
  })
  it('a line that names no item keeps none', () => {
    expect(itemsNamedIn('yeah sounds good', ['wooden_pickaxe'])).toEqual([])
    expect(itemsNamedIn('what should we build first?', ['wooden_pickaxe', 'crafting_table'])).toEqual([])
    expect(itemsNamedIn('hows it going', ['oak_log'])).toEqual([])
    expect(itemsNamedIn('', ['oak_log'])).toEqual([])
    expect(itemsNamedIn('logs', null)).toEqual([])
  })
})

// ---- orchestrator harness (as qualityPass37.test.js, plus namedItems) -----

const ITEMS = { coal_ore: ['coal'], coal: ['coal'], oak_log: ['oak_log'], iron_ore: ['raw_iron'], cow: ['beef'] }
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
    namedItems: (l, items) => itemsNamedIn(l, items, { foods: FOODS }),
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
      memory_md_path: path.join(os.tmpdir(), `sei-p52-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p52-hb-${tag}.md`),
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

describe('orchestrator: an ask keeps only the items its line names', () => {
  it('"yeah sounds good" answered with her own pickaxe craft is not a hand-over', async () => {
    const inv = { wooden_pickaxe: 1 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'nice'), act('c1', 'craft', { item: 'wooden_pickaxe' })),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
    ], { inv })
    await send('yeah sounds good')
    const t = allText(arrivalCalls().at(-1))
    expect(t).not.toContain(CARRYING)
    expect(t).not.toContain(GENERAL)
    expect(t).not.toContain('wooden_pickaxe×')
  })

  it('"grab me some coal" still names the coal on arrival', async () => {
    const inv = { coal: 6 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 6 })),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
    ], { inv })
    await send('grab me some coal')
    expect(allText(arrivalCalls().at(-1))).toContain('coal×6, which you got for their line')
  })

  it('"make me a crafting table": the logs stay hers, the table is theirs', async () => {
    const inv = { oak_log: 1, crafting_table: 1 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'oak_log', count: 2 })),
      turn(act('c1', 'craft', { item: 'crafting_table' })),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
    ], { inv })
    await send('make me a crafting table')
    const t = allText(arrivalCalls().at(-1))
    expect(t).toContain(CARRYING)
    expect(t).toContain('crafting_table×1')
    expect(t).not.toContain('oak_log×')
  })

  it('"get me some food" answered with a hunt names the beef', async () => {
    const inv = { beef: 3 }
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'cow', count: 3 })),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
    ], { inv })
    await send('get me some food')
    expect(allText(arrivalCalls().at(-1))).toContain('beef×3')
  })
})
