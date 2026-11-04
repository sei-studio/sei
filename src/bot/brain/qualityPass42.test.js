// 261104: quality pass 42. The turn a give finishes on still showed the
// transcript from before the give, whose closing line says "You have not
// given anything to anyone", and after her own give she sometimes thanked
// the player for it ("got em, thanks", pass-41 give_done probe). That turn,
// and only that turn, now carries the refreshed hand-over line.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createHandOverLedger } from './sessionEvents.js'
import { createConvoMemory } from './convoMemory.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

afterEach(() => { vi.restoreAllMocks() })

const FRESH = 'Who did what, now that this finished:'

describe('the short hand-over line', () => {
  it('is empty while nothing was given', () => {
    const l = createHandOverLedger()
    l.did({ verb: 'gathered', item: 'oak_log', n: 8 })
    l.received([{ item: 'bread', n: 2 }])
    expect(l.describeGiven()).toBe('')
  })

  it('names what she gave and that nobody handed her anything', () => {
    const l = createHandOverLedger()
    l.did({ verb: 'gathered', item: 'oak_log', n: 8 })
    l.gave({ item: 'oak_log', n: 6, to: 'Alex' })
    expect(l.describeGiven()).toBe(
      'Who did what, now that this finished: this session you gave Alex 6 oak_log. ' +
      'Nobody has handed you anything. This replaces the older who-did-what line above.')
  })

  it('lists what came in when something did, and totals per recipient', () => {
    const l = createHandOverLedger()
    l.gave({ item: 'oak_log', n: 4, to: 'Alex' })
    l.gave({ item: 'oak_log', n: 2, to: 'Alex' })
    l.gave({ item: 'coal', n: 3 })
    l.received([{ item: 'bread', n: 4 }])
    expect(l.describeGiven({ label: (n) => `player (${n})` })).toBe(
      'Who did what, now that this finished: this session you gave player (Alex) 6 oak_log and the player 3 coal. ' +
      '4 bread came into your inventory without an action of yours. This replaces the older who-did-what line above.')
  })

  it('stays short (about 40 tokens) for a single give', () => {
    const l = createHandOverLedger()
    l.gave({ item: 'oak_log', n: 6, to: 'Alex' })
    expect(l.describeGiven({ label: (n) => `player (${n})` }).split(/\s+/).length).toBeLessThanOrEqual(30)
  })

  it('comes from convoMemory only when hand-overs are tracked', () => {
    const on = createConvoMemory({ trackHandOvers: true })
    const off = createConvoMemory()
    for (const m of [on, off]) m.recentChat.noteGiven({ item: 'coal', n: 7, to: 'Alex' })
    expect(on.recentChat.handOverLine()).toBe(
      'Who did what, now that this finished: this session you gave player (Alex) 7 coal. ' +
      'Nobody has handed you anything. This replaces the older who-did-what line above.')
    expect(off.recentChat.handOverLine()).toBe('')
  })
})

// ─── orchestrator ───────────────────────────────────────────────────────

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

const GAVE = 'gave 6 oak_log to Steve, tossed at their feet; you have 2 oak_log left'

function makeAdapter(exec) {
  const ACTIONS = ['give', 'craft', 'gather']
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ item: z.string().optional(), count: z.number().optional() }),
    getActionDescription: (a) => `do ${a}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    handOverResult: (name, r) => (name === 'give' ? /^gave \d/.test(String(r ?? '')) : null),
    handOverDetail: (name, r) => {
      if (name !== 'give') return null
      const m = /^gave (\d+) (\S+) to (.+?), tossed/.exec(String(r ?? ''))
      return m ? { item: m[2], n: Number(m[1]), to: m[3] } : null
    },
    executeAction: exec ?? ((name) => Promise.resolve(name === 'give' ? GAVE
      : name === 'gather' ? 'gathered 8/8 oak_log' : 'crafted 1 wooden_pickaxe')),
  }
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
      memory_md_path: path.join(os.tmpdir(), `sei-p42-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p42-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

const say = (id, text) => ({ id, name: 'say', input: { text } })
const act = (id, name, input = {}) => ({ id, name, input })
const turn = (...toolUses) => ({ text: '', toolUses })
const allText = (call) => JSON.stringify(call?.messages ?? [])
// The newest user turn of a call: what that turn added.
const lastUserText = (call) => JSON.stringify([...(call?.messages ?? [])].reverse().find((m) => m.role === 'user') ?? null)
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const DRAINED = new Set(['sei:action_complete', 'sei:chat_received', 'sei:action_tick'])
const flush = () => new Promise((r) => setTimeout(r, 5))

function setup(script, { exec } = {}) {
  _setTickIntervalForTests(10_000_000)
  const queue = []
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter: makeAdapter(exec), config: config(),
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
  return { provider, orch, drain, send }
}

describe('orchestrator: the refreshed hand-over line', () => {
  it('rides the turn a give finishes on', async () => {
    const { provider, send } = setup([
      turn(say('s0', 'on it'), act('a0', 'gather', { item: 'oak_log', count: 8 })),
      turn(act('e0', 'end_loop')),
      turn(say('s1', 'here, six logs'), act('g1', 'give', { item: 'oak_log', count: 6 })),
      turn(act('e1', 'end_loop')),
    ])
    await send('get me 6 logs')
    await send('ok bring them over')
    // calls: 0 gather turn, 1 its result, 2 give turn, 3 its result.
    expect(provider.calls).toHaveLength(4)
    // The give turn's own transcript is from before the give.
    expect(allText(provider.calls[2])).toContain('You have not given anything to anyone.')
    expect(allText(provider.calls[2])).not.toContain(FRESH)
    const done = lastUserText(provider.calls[3])
    expect(done).toContain(GAVE)
    expect(done).toContain(`${FRESH} this session you gave player (Steve) 6 oak_log. Nobody has handed you anything.`)
    // Not on the gather's result turn either.
    expect(allText(provider.calls[1])).not.toContain(FRESH)
  })

  it('is not added for a give that handed nothing over, or for other actions', async () => {
    const exec = (name) => Promise.resolve(name === 'give' ? 'no oak_log in inventory' : 'crafted 1 wooden_pickaxe')
    const { provider, send } = setup([
      turn(say('s1', 'here'), act('g1', 'give', { item: 'oak_log', count: 6 })),
      turn(act('e1', 'end_loop')),
      turn(act('c1', 'craft', { item: 'wooden_pickaxe' })),
      turn(act('e2', 'end_loop')),
    ], { exec })
    await send('give me logs')
    await send('make a pickaxe')
    expect(provider.calls).toHaveLength(4)
    for (const c of provider.calls) expect(allText(c)).not.toContain(FRESH)
  })

  it('is said once: the next turns after the give do not repeat it', async () => {
    const { provider, send } = setup([
      turn(say('s1', 'here'), act('g1', 'give', { item: 'oak_log', count: 6 })),
      turn(act('c1', 'craft', { item: 'wooden_pickaxe' })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'np')),
    ])
    await send('give me logs')
    await send('thanks')
    expect(lastUserText(provider.calls[1])).toContain(FRESH)
    expect(lastUserText(provider.calls[2])).not.toContain(FRESH)
    // A new loop's transcript carries the full line, now up to date.
    const later = allText(provider.calls.at(-1))
    expect(later).not.toContain(FRESH)
    expect(later).toContain('Who did what this session. You gave player (Steve) 6 oak_log.')
  })

  it('rides a give that outlasts the action tick (tick-claimed completion)', async () => {
    let finish
    const exec = (name) => (name === 'give'
      ? new Promise((r) => { finish = r })
      : Promise.resolve(`${name} ok`))
    const { provider, send, orch, drain } = setup([
      turn(say('s1', 'here, six logs'), act('g1', 'give', { item: 'oak_log', count: 6 })),
      turn(),
      turn(act('e1', 'end_loop')),
    ], { exec })
    await send('give me 6 logs')
    await orch.handleDispatch('sei:action_tick', { elapsedSec: 10 })
    await flush(); await drain()
    expect(allText(provider.calls.at(-1))).not.toContain(FRESH)
    finish(GAVE)
    await flush(); await drain()
    const last = lastUserText(provider.calls.at(-1))
    expect(last).toContain('previous action completed: give')
    expect(last).toContain(`${FRESH} this session you gave player (Steve) 6 oak_log.`)
  })
})
