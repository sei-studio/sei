// 261112: quality pass 53, an order she answered in words while busy
// outlives the completion turn that brings it back when that turn hands
// something over first (errands-03, 11-12 scorecard: "get me like 8 logs"
// heard on the walk back with the coal, the coal given first, then her own
// furnace). Only a give keeps the lines; other work, a player line answered
// with work, or a task set for the player ends them.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { NUDGES } from './promptLibrary.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

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
    handOverResult: (name, r) => (name === 'give' ? /^gave \d/.test(String(r ?? '')) : null),
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
      memory_md_path: path.join(os.tmpdir(), `sei-p53-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p53-hb-${tag}.md`),
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

const allText = (call) => JSON.stringify(call?.messages ?? [])
const LOGS = 'get me like 8 logs, i wanna build a dock'
const idle = (orch) => orch.handleDispatch('sei:idle', { quietMs: 7000 })

// The coal run: a gather for the player, the log order heard while it runs
// and answered in words, then the completion turn's calls (`after`).
async function coalRun(after, rest = []) {
  const h = setup([
    turn(say('s1', 'on it'), act('a1', 'gather', { name: 'coal_ore' })),
    turn(say('s2', '8 logs for a dock, on it')),
    ...after,
    ...rest,
  ])
  await h.orch.handleDispatch('sei:chat_received', line('grab me some coal'))
  await h.orch.handleDispatch('sei:chat_received', line(LOGS))
  await flush()
  expect(h.orch.currentLoop?._replyDeferred).toEqual([LOGS])
  h.running.gather('gathered 2/2 coal')
  await flush()
  await h.drain()
  await flush()
  return h
}

describe('an order put off behind a hand-over', () => {
  it('rides the next idle turn after she gives first, with her own next: hidden', async () => {
    const h = await coalRun([turn(act('g1', 'give', { item: 'coal', player: 'Steve' })), turn(act('e1', 'end_loop'))], [turn(act('e2', 'end_loop'))])
    expect(h.executed).toContain('give')
    const n = h.provider.calls.length
    h.snapshotOpts.length = 0
    await idle(h.orch)
    await flush()
    expect(h.provider.calls.length).toBe(n + 1)
    const text = allText(h.provider.calls[n])
    expect(text).toContain('asked earlier')
    expect(text).toContain(LOGS)
    expect(text).not.toContain('next: make a furnace')
    expect(h.snapshotOpts.some((o) => o?.hideNext === true)).toBe(true)
  })

  it('ends once she starts other work', async () => {
    const h = await coalRun(
      [turn(act('g1', 'give', { item: 'coal', player: 'Steve' })), turn(act('e1', 'end_loop'))],
      [turn(say('s3', 'logs now'), act('d1', 'dig', { name: 'oak_log' })), turn(act('e2', 'end_loop'))],
    )
    await idle(h.orch) // starts the dig
    await flush()
    h.running.dig?.('dug oak_log')
    await flush()
    await h.drain()
    await flush()
    const n = h.provider.calls.length
    await idle(h.orch)
    await flush()
    expect(h.provider.calls.length).toBeGreaterThan(n)
    expect(allText(h.provider.calls[n])).not.toContain('asked earlier')
  })

  it('is not kept when the completion turn starts other work instead', async () => {
    const h = await coalRun([turn(act('d1', 'dig', { name: 'stone' }))], [turn(act('e1', 'end_loop'))])
    h.running.dig?.('dug stone')
    await flush()
    await h.drain()
    await flush()
    const n = h.provider.calls.length
    await idle(h.orch)
    await flush()
    expect(allText(h.provider.calls[n])).not.toContain('asked earlier')
  })

  it('is not kept past a walk back to the player', async () => {
    const h = await coalRun([turn(act('w1', 'goTo', { player: 'Steve' })), turn(act('e1', 'end_loop'))], [turn(act('e2', 'end_loop'))])
    expect(h.executed).toContain('goTo')
    const n = h.provider.calls.length
    await idle(h.orch)
    await flush()
    expect(allText(h.provider.calls[n])).not.toContain('asked earlier')
  })

  it('a task set for the player carries it instead', async () => {
    const h = await coalRun([turn(act('g1', 'give', { item: 'coal', player: 'Steve' })), turn(act('t1', 'setGoal', { text: 'Get 8 logs for Steve', for_player: true }), act('e1', 'end_loop'))], [turn(act('e2', 'end_loop'))])
    const n = h.provider.calls.length
    await idle(h.orch)
    await flush()
    expect(allText(h.provider.calls[n])).not.toContain('asked earlier')
  })

  it('a later player line answered with work ends it', async () => {
    const h = await coalRun(
      [turn(act('g1', 'give', { item: 'coal', player: 'Steve' })), turn(act('e1', 'end_loop'))],
      [turn(say('s3', 'coming'), act('f1', 'follow', { player: 'Steve' })), turn(act('e2', 'end_loop'))],
    )
    await h.orch.handleDispatch('sei:chat_received', line('actually forget the logs, just meet me over here'))
    await flush()
    await h.drain()
    const n = h.provider.calls.length
    await idle(h.orch)
    await flush()
    for (const c of h.provider.calls.slice(n)) expect(allText(c)).not.toContain('asked earlier')
  })

  it('the note quotes the lines plainly', () => {
    const one = NUDGES.deferredNote({ who: 'Alex', lines: [LOGS] })
    expect(one).toContain(`Alex said "${LOGS}"`)
    expect(one).toContain('before your own goal')
    const two = NUDGES.deferredNote({ who: null, lines: ['a', 'b'] })
    expect(two).toContain('the player said "a" and then "b"')
    expect(two).not.toMatch(/—/)
  })
})
