// 261020: quality pass 20.
//  - Recycled lines on turns that carried none of hers: the turn after one of
//    her actions finished, and an idle tick seconds after she spoke. Those
//    turns now quote a fresh line of hers in the short form ('result'), once
//    per line per loop.
//  - "actually forget the logs" answered without a clearGoal: the heartbeat
//    block is read at the loop's seed, so a task written down later in the
//    same loop was not in view. A player line mid-loop now carries the goal
//    lines as they are now.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { ownRepeatsNote } from './ownRepeats.js'
import { goalEntries } from './memory/heartbeat.js'
import { NUDGES } from './promptLibrary.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

afterEach(() => { vi.restoreAllMocks() })

describe('ownRepeatsNote result mode', () => {
  it('quotes her last line in the short form, without the reply ask', () => {
    const now = Date.now()
    const note = ownRepeatsNote([{ at: now - 3_000, text: "nehehe you're welcome. dock better be sick" }], [], { mode: 'result', now })
    expect(note).toBe(`Your last line to them was "nehehe you're welcome. dock better be sick". They already heard it, so if you say something now, make it new.`)
  })
})

describe('goalEntries', () => {
  it('lists goal texts oldest first, tag kept, stamps dropped', () => {
    const full = '# HEARTBEAT\n\n- [2026-10-20T10:00:00.000Z] make a furnace\nnot a goal\n- [2026-10-20T10:01:00.000Z] (player task) get Alex 8 logs for a dock\n'
    expect(goalEntries(full)).toEqual(['make a furnace', '(player task) get Alex 8 logs for a dock'])
    expect(goalEntries('')).toEqual([])
  })
})

describe('NUDGES.heartbeatNow', () => {
  it('lists the newest four, clipped, and is empty with no goals', () => {
    expect(NUDGES.heartbeatNow([])).toBe('')
    const long = `(player task) ${'x'.repeat(300)}`
    const t = NUDGES.heartbeatNow(['a', 'b', 'c', 'd', long])
    expect(t).not.toContain('- a\n')
    expect(t).toContain('- b\n')
    expect(t).toContain(`- (player task) ${'x'.repeat(143)}...`)
    expect(t).toContain('call clearGoal on it in this same turn')
    expect(t).not.toMatch(/â€”|NEVER|ALWAYS|ONLY/)
  })
})

function makeProvider(script) {
  let i = 0
  const calls = []
  return {
    calls,
    buildCachedSystem: (blocks) => blocks,
    setAuthToken() {},
    setBackend() {},
    async call(args) {
      calls.push(JSON.parse(JSON.stringify({ messages: args.messages ?? [] })))
      const r = script[Math.min(i, script.length - 1)]
      i += 1
      return typeof r === 'function' ? r(args) : r
    },
  }
}

// gather runs until resolved or aborted; everything else is instant.
function makeAdapter(running) {
  return {
    listActions: () => ['gather', 'goTo'],
    getActionSchema: () => z.object({ name: z.string().optional(), count: z.number().optional(), player: z.string().optional() }),
    getActionDescription: (a) => `do ${a}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, _args, opts = {}) => {
      if (name !== 'gather') return Promise.resolve(`${name} ok`)
      return new Promise((resolve) => {
        running[name] = resolve
        opts.signal?.addEventListener?.('abort', () => resolve(`aborted ${name}`), { once: true })
      })
    },
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
      memory_md_path: path.join(os.tmpdir(), `sei-p20-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p20-hb-${tag}.md`),
      iteration_cap: 30,
    },
    web: { enabled: false },
  }
}

const say = (id, text) => ({ id, name: 'say', input: { text } })
const act = (id, name, input = {}) => ({ id, name, input })
const turn = (...toolUses) => ({ text: '', toolUses })
const lastUser = (call) => JSON.stringify(call.messages.slice(-1))
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const DRAINED = new Set(['sei:action_complete', 'sei:chat_received', 'sei:action_tick'])
const flush = () => new Promise((r) => setTimeout(r, 5))

function setup(script) {
  _setTickIntervalForTests(10_000_000)
  const running = {}
  const queue = []
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter: makeAdapter(running), config: config(),
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
  return { orch, provider, running, drain }
}

const RESULT_FORM = 'Your last line to them was \\"on it, chopping now\\". They already heard it, so if you say something now, make it new.'

describe('orchestrator: the turn after her action finished', () => {
  it('quotes her fresh line once per line, not on every result', async () => {
    const { orch, provider, running, drain } = setup([
      turn(say('s1', 'on it, chopping now'), act('a1', 'gather', { name: 'oak_log' })),
      turn(act('a2', 'gather', { name: 'oak_log' })),
      turn(act('e1', 'end_loop')),
    ])
    orch.recordIncomingChat('Steve', 'get wood')
    await orch.handleDispatch('sei:chat_received', line('get wood'))
    running.gather('gathered 4/4 oak_log')
    await flush(); await drain(); await flush()
    expect(provider.calls.length).toBeGreaterThanOrEqual(2)
    expect(lastUser(provider.calls[1])).toContain(RESULT_FORM)
    running.gather('gathered 4/4 oak_log')
    await flush(); await drain(); await flush()
    expect(provider.calls.length).toBeGreaterThanOrEqual(3)
    expect(lastUser(provider.calls[2])).not.toContain('Your last line to them was')
  })

  it('leaves the quote out once her line is old', async () => {
    const t0 = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
    const { orch, provider, running, drain } = setup([
      turn(say('s1', 'on it, chopping now'), act('a1', 'gather', { name: 'oak_log' })),
      turn(act('e1', 'end_loop')),
    ])
    orch.recordIncomingChat('Steve', 'get wood')
    await orch.handleDispatch('sei:chat_received', line('get wood'))
    now.mockReturnValue(t0 + 60_000)
    running.gather('gathered 4/4 oak_log')
    await flush(); await drain(); await flush()
    expect(provider.calls.length).toBeGreaterThanOrEqual(2)
    expect(lastUser(provider.calls[1])).not.toContain('Your last line to them was')
  })
})

describe('orchestrator: a player line mid-loop sees the goals written in this loop', () => {
  it('lists the task set earlier in the same loop', async () => {
    const { orch, provider, drain } = setup([
      turn(say('s1', 'ok, 8 logs'), act('g1', 'setGoal', { text: 'get Steve 8 oak logs for his dock and hand them over', for_player: true }), act('a1', 'gather', { name: 'oak_log', count: 8 })),
      turn(say('s2', 'ok coming'), act('c1', 'clearGoal', { text: '8 oak logs' }), act('m1', 'goTo', { player: 'Steve' })),
      turn(act('e1', 'end_loop')),
    ])
    orch.recordIncomingChat('Steve', 'get me 8 logs, i wanna build a dock')
    await orch.handleDispatch('sei:chat_received', line('get me 8 logs, i wanna build a dock'))
    // The loop's seed had no goals.
    expect(JSON.stringify(provider.calls[0].messages)).not.toContain('(player task) get Steve 8 oak logs')
    orch.recordIncomingChat('Steve', 'actually forget the logs, just meet me over here')
    await orch.handleDispatch('sei:chat_received', line('actually forget the logs, just meet me over here'))
    await flush(); await drain(); await flush()
    const reply = provider.calls.find((c) => lastUser(c).includes('actually forget the logs'))
    expect(reply).toBeTruthy()
    const text = lastUser(reply)
    expect(text).toContain('Your heartbeat right now, including anything you wrote down since this loop began:')
    expect(text).toContain('- (player task) get Steve 8 oak logs for his dock and hand them over')
    // After the clearGoal the list is empty again: a later line carries none.
    orch.recordIncomingChat('Steve', 'lol ok')
    await orch.handleDispatch('sei:chat_received', line('lol ok'))
    await flush(); await drain(); await flush()
    const later = provider.calls.find((c) => lastUser(c).includes('lol ok'))
    expect(later).toBeTruthy()
    expect(lastUser(later)).not.toContain('Your heartbeat right now')
  })
})

// Pass 6a guard: an idle or attack seed gets no quote of her line, even a
// fresh one (the quote there made her go silent).
describe('the seed of a turn of her own', () => {
  it('carries no quote of her fresh line, idle or attack', async () => {
    const t0 = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
    const { orch, provider } = setup([
      turn(say('s1', 'dock better be sick')),
      turn(),
      turn(),
    ])
    orch.recordIncomingChat('Steve', 'thanks')
    await orch.handleDispatch('sei:chat_received', line('thanks'))
    now.mockReturnValue(t0 + 3_000)
    await orch.handleDispatch('sei:idle', { quietMs: 3_000 })
    now.mockReturnValue(t0 + 6_000)
    await orch.handleDispatch('sei:attacked', { attackerLabel: 'zombie', attackerKind: 'mob', pvp: false, health: 14 })
    expect(provider.calls.length).toBe(3)
    expect(JSON.stringify(provider.calls[1].messages)).not.toContain('They already heard it, so if you say something now')
    expect(JSON.stringify(provider.calls[2].messages)).not.toContain('They already heard it, so if you say something now')
  })
})

describe('review: clearGoal with a clipped heartbeatNow line', () => {
  it('matches the goal the "..." line was cut from', async () => {
    const fs = await import('node:fs/promises')
    const { appendGoal, removeGoal } = await import('./memory/heartbeat.js')
    const file = path.join(os.tmpdir(), `sei-p20-clip-${process.pid}-${Date.now()}.md`)
    const goal = `Fence in the chicken coop. ${'Put a fence post on every edge block, '.repeat(6)}done when no gap is left.`
    try {
      await appendGoal(file, goal, new Date())
      const shown = NUDGES.heartbeatNow([goal]).split('\n')[1].slice(2)
      expect(shown.endsWith('...')).toBe(true)
      expect(await removeGoal(file, shown)).toBe(1)
    } finally { await fs.rm(file, { force: true }) }
  })
})




