// 261103: quality pass 38, the hand-over after a status answer (pass-37
// compare, errands-04-B U5). The coal was gathered with no walk back; "hows
// it going" was answered with "walking it to you" and a goTo to the player.
// That walk-only line became the newest open ask (toPlayer), which kept the
// coal ask from being marked as delivered, so the walk carried no hand-over
// line. During the walk she answered a log order with a line and a player
// goal, and on arrival that order ("start it now") and its not-started task
// line won over the arrival note: she went for logs with the coal in her bag.
//  - A walk that answers a newer walk-only line now delivers the older asks
//    she carries items for (not the ones whose work that walk cut off), with
//    a snapshot line that leaves the choice to her.
//  - The arrival note puts the hand-over first when they asked for something
//    else since.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { NUDGES } from './promptLibrary.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { smeltProductOf } from '../adapter/minecraft/observers/workItems.js'

afterEach(() => { vi.restoreAllMocks() })

const asks = [{ line: 'grab me some coal and bring it back', items: [{ item: 'coal', n: 6 }] }]
describe('NUDGES (pass 38)', () => {
  it('arrivedCarrying puts the hand-over first only when they asked for something since', () => {
    const base = 'You are next to Alex now. You are carrying coal×6, which you got for their line "grab me some coal and bring it back". Anything there they still want reaches them only through give, and anything they called off stays with you.'
    expect(NUDGES.arrivedCarrying({ who: 'Alex', asks })).toBe(base)
    expect(NUDGES.arrivedCarrying({ who: 'Alex', asks, newer: true })).toBe(`${base} If they still want it, give it before you start anything they asked for since.`)
  })
  it('deliveryNote for a walk that answers their newer line names both outcomes', () => {
    expect(NUDGES.deliveryNote({ who: 'Alex', asks, answered: true })).toBe('hand-over: you are walking to Alex carrying coal×6, which you got for their line "grab me some coal and bring it back". Anything there they still want reaches them only through give, which walks to them first. If they called it off, keep it.')
    expect(NUDGES.deliveryNote({ who: 'Alex', asks })).toMatch(/^hand-over: you set off toward Alex carrying coal×6/)
    expect(NUDGES.deliveryNote({ who: null, asks, answered: true })).not.toMatch(/—/)
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
      memory_md_path: path.join(os.tmpdir(), `sei-p38-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p38-hb-${tag}.md`),
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
  return { provider, send, orch, drain, adapter }
}

const arrivalCalls = (provider) => provider.calls.filter((c) => /reached Steve/.test(allText(c)))

const OWN = 'hand-over: you set off toward Steve'
const ANSWERED = 'hand-over: you are walking to Steve'
const FIRST = 'If they still want it, give it before you start anything they asked for since.'
const lastSnapshot = (call) => {
  const m = call?.messages?.at(-1)
  return Array.isArray(m?.content) ? m.content.map((c) => c.text ?? '').join('\n') : String(m?.content ?? '')
}

describe('orchestrator: a status line answered with a walk to the player (errands-04-B)', () => {
  it('the walk carries the hand-over line for the coal, and the arrival names it', async () => {
    const inv = { coal: 6, cobblestone: 4 }
    const { send, provider, adapter, drain } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 6 })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'got six coal now, walking it to you'), act('w1', 'goTo', { player: 'Steve' })),
      turn(say('s3', 'haha')),
      turn(act('g1', 'give', { item: 'coal', player: 'Steve' })),
      turn(act('e2', 'end_loop')),
    ], { inv, held: new Set(['goTo']) })
    await send('grab me some coal and bring it back here')
    await send('hows it going')
    await send('cool')
    const mid = lastSnapshot(provider.calls.at(-1))
    expect(mid).toContain(ANSWERED)
    expect(mid).toContain('coal×6')
    expect(mid).not.toContain('cobblestone×')
    adapter.finish('goTo', 'reached Steve (1m away)')
    await flush()
    await drain()
    const arrival = allText(arrivalCalls(provider).at(-1))
    expect(arrival).toContain(CARRYING)
    expect(arrival).toContain('coal×6')
    // The give closed the coal ask: no hand-over line after it.
    expect(lastSnapshot(provider.calls.at(-1))).not.toContain('hand-over:')
  })

  it('a log order answered during the walk without starting it puts the hand-over first on arrival', async () => {
    const inv = { coal: 6 }
    const { send, provider, adapter, drain } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 6 })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'walking it to you'), act('w1', 'goTo', { player: 'Steve' })),
      turn(say('s3', 'a dock? nice, i will hunt some trees')),
      turn(act('e2', 'end_loop')),
    ], { inv, held: new Set(['goTo']) })
    await send('grab me some coal and bring it back here')
    await send('hows it going')
    await send('get me like 8 logs, i wanna build a dock')
    adapter.finish('goTo', 'reached Steve (1m away)')
    await flush()
    await drain()
    const arrival = allText(arrivalCalls(provider).at(-1))
    expect(arrival).toContain('coal×6')
    expect(arrival).toContain(FIRST)
  })

  it('an arrival with nothing asked since keeps the plain note', async () => {
    const inv = { coal: 6 }
    const { send, provider, adapter, drain } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 6 })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'walking it to you'), act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e2', 'end_loop')),
    ], { inv, held: new Set(['goTo']) })
    await send('grab me some coal and bring it back here')
    await send('hows it going')
    adapter.finish('goTo', 'reached Steve (1m away)')
    await flush()
    await drain()
    const arrival = allText(arrivalCalls(provider).at(-1))
    expect(arrival).toContain('coal×6')
    expect(arrival).not.toContain(FIRST)
  })

  it('her own walk back keeps the pass-37 line', async () => {
    const inv = { coal: 6 }
    const { send, provider } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 6 })),
      turn(act('w1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'haha')),
    ], { inv, held: new Set(['goTo']) })
    await send('grab me some coal and bring it back here')
    await send('lol')
    const mid = lastSnapshot(provider.calls.at(-1))
    expect(mid).toContain(OWN)
    expect(mid).not.toContain(ANSWERED)
  })

  it('a walk that cuts off the log run does not deliver the logs; the finished coal still rides it', async () => {
    const inv = { coal: 6, oak_log: 3 }
    const { send, provider, adapter, drain } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore', count: 6 })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'logs too'), act('a2', 'gather', { name: 'oak_log', count: 8 })),
      turn(say('s3', 'ok, coming'), act('w1', 'goTo', { player: 'Steve' })),
      turn(say('s4', 'haha')),
    ], { inv, held: new Set(['goTo', 'gather']) })
    await send('grab me some coal')
    adapter.finish('gather', 'gathered 6/6 coal')
    await flush()
    await drain()
    await send('get me 8 logs')
    await send('actually forget the logs, just meet me over here')
    await send('lol')
    const mid = lastSnapshot(provider.calls.at(-1))
    expect(mid).toContain('hand-over:')
    expect(mid).not.toContain('oak_log×')
  })
})
