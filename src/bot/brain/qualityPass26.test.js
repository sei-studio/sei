// 261024: quality pass 26, one order and one status line.
//  - a stop on a player line that did not ask her to stop or wait gets one
//    more call in the same loop (NUDGES.stopThenNext), so "forget the logs,
//    just meet me over here" answered with stop + say() can still start the
//    walk with her own line in view, instead of the idle tick re-announcing it
//  - a stop the line asked for ends the loop as before
//  - the stay note waits for that call and is set only if it starts nothing
//  - a game goodbye says a plan of her own as hers (NEXT_TIME_OWN_PLAN), and
//    the goodbye example ties I or we to whose plan it is, not to progress

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { NUDGES, NEXT_TIME_GOODBYE, NEXT_TIME_OWN_PLAN } from './promptLibrary.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

afterEach(() => { vi.restoreAllMocks() })

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

// gather runs until settled or aborted; follow never settles (background);
// everything else is instant.
function makeAdapter(executed, running, aborted, snapshotOpts) {
  const ACTIONS = ['gather', 'dig', 'give', 'goTo', 'follow', 'unfollow', 'explore', 'look', 'attackEntity']
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ name: z.string().optional(), item: z.string().optional(), player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: (opts) => { snapshotOpts?.push(opts); return opts?.hideNext ? 'SNAPSHOT' : 'SNAPSHOT\nnext: make a furnace' } }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, _args, opts = {}) => {
      executed.push(name)
      if (name === 'follow') return new Promise(() => {})
      if (name !== 'gather' && name !== 'dig') return Promise.resolve(`${name} ok`)
      return new Promise((resolve) => {
        running[name] = resolve
        opts.signal?.addEventListener?.('abort', () => { aborted.push(name); resolve(`aborted ${name}`) }, { once: true })
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
      memory_md_path: path.join(os.tmpdir(), `sei-p26-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p26-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

const say = (id, text) => ({ id, name: 'say', input: { text } })
const act = (id, name, input = {}) => ({ id, name, input })
const turn = (...toolUses) => ({ text: '', toolUses })
const lastUserText = (call) => JSON.stringify((call.messages ?? []).slice(-1))
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const DRAINED = new Set(['sei:action_complete', 'sei:chat_received', 'sei:action_tick'])
const flush = () => new Promise((r) => setTimeout(r, 5))

function setup(script, cfg = config()) {
  _setTickIntervalForTests(10_000_000)
  const executed = []
  const running = {}
  const aborted = []
  const snapshotOpts = []
  const queue = []
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter: makeAdapter(executed, running, aborted, snapshotOpts), config: cfg,
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  const drain = async () => {
    for (let guard = 0; queue.length && guard < 20; guard++) {
      const next = queue.shift()
      if (DRAINED.has(next.event)) await orch.handleDispatch(next.event, next.data)
    }
  }
  return { orch, provider, executed, running, aborted, snapshotOpts, queue, drain }
}

const hasNote = (call) => lastUserText(call).includes('hold: you stopped')
const STOP_NEXT = 'and nothing is running now. If their line also asked you to do something'

describe('NUDGES.stopThenNext', () => {
  it('names what stopped, and drops the say() ask when she already spoke', () => {
    const a = NUDGES.stopThenNext({ stopped: 'gather', spoke: true })
    expect(a).toContain('You stopped the gather action, and nothing is running now.')
    expect(a).toContain('do not call say() again')
    expect(a).toContain('call end_loop')
    const b = NUDGES.stopThenNext({ stopped: null, spoke: false })
    expect(b).toContain('You stopped what you were doing')
    expect(b).not.toContain('say()')
    expect(a + b).not.toMatch(/\u2014/)
  })
})

describe('a stop on a line that asked for more', () => {
  it('"forget the logs, just meet me over here": stop + say, then the walk in the same loop, one line', async () => {
    const { orch, provider, executed, aborted, drain } = setup([
      turn(say('s1', 'logs, on it'), act('a1', 'gather', { name: 'oak_log' })),
      turn(say('s2', 'ok coming to you'), act('t1', 'stop')),
      turn(act('g1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
    ])
    await orch.handleDispatch('sei:chat_received', line('get me 8 logs'))
    await orch.handleDispatch('sei:chat_received', line('actually forget the logs, just meet me over here'))
    await flush()
    await drain()
    expect(aborted).toEqual(['gather'])
    const third = lastUserText(provider.calls[2])
    expect(third).toContain('You stopped the gather action')
    expect(third).toContain('do not call say() again')
    expect(executed).toEqual(['gather', 'goTo'])
    // The walk is new work, so no stay note on the turns after it.
    for (const c of provider.calls.slice(3)) expect(hasNote(c)).toBe(false)
  })

  it('"actually stop" still ends the loop on the stop', async () => {
    const { orch, provider, aborted, drain } = setup([
      turn(say('s1', 'logs, on it'), act('a1', 'gather', { name: 'oak_log' })),
      turn(say('s2', 'ok stopping'), act('t1', 'stop')),
      turn(act('g1', 'goTo', { player: 'Steve' })),
    ])
    await orch.handleDispatch('sei:chat_received', line('get me 8 logs'))
    await orch.handleDispatch('sei:chat_received', line('actually stop'))
    await flush()
    await drain()
    expect(aborted).toEqual(['gather'])
    expect(provider.calls.length).toBe(2)
    expect(orch.currentLoop).toBeNull()
  })

  it('a line asking her to wait ends the loop too', async () => {
    const { orch, provider, drain } = setup([
      turn(say('s1', 'logs, on it'), act('a1', 'gather', { name: 'oak_log' })),
      turn(say('s2', 'ok waiting'), act('t1', 'stop')),
    ])
    await orch.handleDispatch('sei:chat_received', line('get me 8 logs'))
    await orch.handleDispatch('sei:chat_received', line('wait for me there'))
    await flush()
    await drain()
    expect(provider.calls.length).toBe(2)
    expect(provider.calls.some((c) => lastUserText(c).includes(STOP_NEXT))).toBe(false)
  })

  it('when the call after the stop starts nothing, the loop ends and the stay note is set', async () => {
    const { orch, provider, executed, drain } = setup([
      turn(say('s1', 'logs, on it'), act('a1', 'gather', { name: 'oak_log' })),
      turn(say('s2', 'ok no logs then'), act('t1', 'stop')),
      turn(act('e1', 'end_loop')),
      turn(say('s3', 'so what now')),
    ])
    await orch.handleDispatch('sei:chat_received', line('get me 8 logs'))
    await orch.handleDispatch('sei:chat_received', line('actually forget the logs, i found some'))
    await flush()
    await drain()
    expect(provider.calls.length).toBe(3)
    expect(lastUserText(provider.calls[2])).toContain(STOP_NEXT)
    expect(orch.currentLoop).toBeNull()
    await orch.handleDispatch('sei:idle', { quietMs: 6000 })
    await flush()
    const last = provider.calls[provider.calls.length - 1]
    expect(hasNote(last)).toBe(true)
    expect(lastUserText(last)).toContain('i found some')
    expect(executed).toEqual(['gather'])
  })

  it('gets one more call only once per loop', async () => {
    const { orch, provider, drain } = setup([
      turn(say('s1', 'logs, on it'), act('a1', 'gather', { name: 'oak_log' })),
      turn(say('s2', 'ok'), act('t1', 'stop')),
      turn(act('t2', 'stop')),
      turn(act('g1', 'goTo', { player: 'Steve' })),
    ])
    await orch.handleDispatch('sei:chat_received', line('get me 8 logs'))
    await orch.handleDispatch('sei:chat_received', line('nvm the logs, come here'))
    await flush()
    await drain()
    expect(provider.calls.length).toBe(3)
    expect(orch.currentLoop).toBeNull()
  })
})

describe('goodbye text: whose plan it is', () => {
  it('ties I or we to whose plan it is, and start or finish to progress', () => {
    expect(NEXT_TIME_GOODBYE).toContain('start or finish by how far it got, and I or we by whose plan it is')
    expect(NEXT_TIME_GOODBYE).not.toContain('whichever matches how far it got')
  })

  it('says a plan the player took up as we, and a goal of her own as hers', () => {
    expect(NEXT_TIME_OWN_PLAN).toContain('A plan is shared when the player proposed it, asked for it or said yes to it in the conversation, even if you wrote it down as your own goal: say we')
    expect(NEXT_TIME_OWN_PLAN).toContain('A goal you came up with yourself that they never took up is yours alone')
    expect(NEXT_TIME_OWN_PLAN).toContain('"next time I\'ll go find iron"')
    for (const t of [NEXT_TIME_GOODBYE, NEXT_TIME_OWN_PLAN]) expect(t).not.toMatch(/[\u2013\u2014]/)
  })

  it('rides the game quit_game and end_call descriptions', async () => {
    const provider = makeProvider([turn(act('e1', 'end_loop'))])
    const orch = createOrchestrator({ adapter: makeAdapter([], {}, []), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('hi'))
    const tools = provider.calls[0].tools ?? []
    for (const name of ['quit_game', 'end_call']) {
      const t = tools.find((x) => x.name === name)
      expect(t?.description).toContain(NEXT_TIME_OWN_PLAN)
    }
  })
})
