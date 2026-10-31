// 261031: quality pass 32. Errands got dropped: she said she would fetch
// coal and bring it back, walked back to the player, and never handed it
// over (9 of the 24 errands sessions where the coal never arrived), mostly
// when no player task was in her heartbeat (92 of 140 sessions).
//  - Player lines she answered with a world action stay open until a
//    hand-over lands, a plain stop, or age.
//  - The completion turn of a goTo that reached the player quotes them, when
//    one of them asked for more than her company.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { NUDGES } from './promptLibrary.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

afterEach(() => { vi.restoreAllMocks() })

describe('NUDGES.arrivedAsks', () => {
  it('quotes one ask', () => {
    const t = NUDGES.arrivedAsks({ who: 'Alex', lines: ['grab me some coal and bring it back'] })
    expect(t).toBe('You are next to Alex now. Since you last handed them anything, they asked you "grab me some coal and bring it back". If one of those asks is for something you are carrying, hand it over with give now, unless they called it off since.')
  })

  it('lists several in order and falls back to the player', () => {
    const t = NUDGES.arrivedAsks({ who: null, lines: ['get coal', 'meet me here'] })
    expect(t).toContain('You are next to the player now.')
    expect(t).toContain('they asked you "get coal" and then "meet me here".')
    expect(t).not.toMatch(/—/)
  })
})

// gather and goTo are instant; goTo to a player reports reaching them.
function makeAdapter({ handOvers = true, goTo = 'reached Steve (1m away)' } = {}) {
  const ACTIONS = ['gather', 'give', 'goTo', 'follow', 'stop']
  const a = {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ item: z.string().optional(), count: z.number().optional(), player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name) => Promise.resolve(
      name === 'give' ? 'gave 6 coal to Steve, tossed at their feet; you have 0 coal left'
        : name === 'goTo' ? goTo
          : name === 'gather' ? 'gathered 6/6 coal'
            : `${name} ok`),
  }
  if (handOvers) {
    a.handOverResult = (name, r) => (name === 'give' ? /^gave \d/.test(String(r ?? '')) : null)
    a.handOverDetail = (name, r) => {
      if (name !== 'give') return null
      const m = /^gave (\d+) (\S+) to (.+?), tossed/.exec(String(r ?? ''))
      return m ? { item: m[2], n: Number(m[1]), to: m[3] } : null
    }
  }
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
      memory_md_path: path.join(os.tmpdir(), `sei-p32-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p32-hb-${tag}.md`),
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
const ARRIVED = 'You are next to Steve now'

function setup(script, adapterOpts) {
  _setTickIntervalForTests(10_000_000)
  const queue = []
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter: makeAdapter(adapterOpts), config: config(),
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
  // The call made right after each walk to the player finished.
  const arrivalCalls = () => provider.calls.filter((c) => /reached Steve/.test(allText(c)))
  return { provider, send, arrivalCalls }
}

describe('orchestrator: open asks on arrival', () => {
  it('quotes the errand when her walk back reaches the player', async () => {
    const { provider, send } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { item: 'coal', count: 6 })),
      turn(act('a2', 'goTo', { player: 'Steve' })),
      turn(act('a3', 'end_loop')),
    ])
    await send('grab me some coal and bring it back')
    const after = allText(provider.calls[2])
    expect(after).toContain('reached Steve')
    expect(after).toContain(ARRIVED)
    expect(after).toContain('\\"grab me some coal and bring it back\\"')
    // Only the arrival turn carries it.
    expect(allText(provider.calls[1])).not.toContain(ARRIVED)
  })

  it('says nothing after a give landed', async () => {
    const { provider, send } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { item: 'coal', count: 6 })),
      turn(act('g1', 'give', { item: 'coal', player: 'Steve' })),
      turn(act('a2', 'goTo', { player: 'Steve' })),
      turn(act('a3', 'end_loop')),
    ])
    await send('grab me some coal')
    expect(allText(provider.calls[3])).toContain('reached Steve')
    expect(allText(provider.calls[3])).not.toContain(ARRIVED)
  })

  it('says nothing for a plain "come here"', async () => {
    const { provider, send } = setup([
      turn(say('s1', 'coming'), act('a1', 'goTo', { player: 'Steve' })),
      turn(act('a2', 'end_loop')),
    ])
    await send('come here')
    expect(allText(provider.calls[1])).toContain('reached Steve')
    expect(allText(provider.calls[1])).not.toContain(ARRIVED)
  })

  it('says nothing when the game does not report hand-overs', async () => {
    const { provider, send } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { item: 'coal', count: 6 })),
      turn(act('a2', 'goTo', { player: 'Steve' })),
      turn(act('a3', 'end_loop')),
    ], { handOvers: false })
    await send('grab me some coal and bring it back')
    expect(allText(provider.calls[2])).toContain('reached Steve')
    expect(allText(provider.calls[2])).not.toContain(ARRIVED)
  })

  it('says nothing when the walk did not reach them', async () => {
    const { provider, send } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { item: 'coal', count: 6 })),
      turn(act('a2', 'goTo', { player: 'Steve' })),
      turn(act('a3', 'end_loop')),
    ], { goTo: 'could not reach Steve: no path' })
    await send('grab me some coal and bring it back')
    expect(allText(provider.calls[2])).toContain('could not reach Steve')
    expect(allText(provider.calls[2])).not.toContain(ARRIVED)
  })

  it('a plain stop closes the asks before it', async () => {
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { item: 'coal', count: 6 })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'ok'), act('st', 'stop')),
      turn(say('s3', 'coming'), act('a2', 'goTo', { player: 'Steve' })),
      turn(act('e3', 'end_loop')),
    ])
    await send('grab me some coal')
    await send('stop')
    await send('come here')
    const arrivals = arrivalCalls()
    expect(arrivals.length).toBeGreaterThan(0)
    expect(allText(arrivals.at(-1))).not.toContain(ARRIVED)
  })

  it('keeps the errand through a later "meet me" and quotes both', async () => {
    const { send, arrivalCalls } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { item: 'coal', count: 6 })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'omw'), act('a2', 'goTo', { player: 'Steve' })),
      turn(act('e2', 'end_loop')),
    ])
    await send('grab me some coal')
    await send('meet me over here')
    const arrivals = arrivalCalls()
    expect(arrivals.length).toBeGreaterThan(0)
    const t = allText(arrivals.at(-1))
    expect(t).toContain(ARRIVED)
    expect(t).toContain('\\"grab me some coal\\" and then \\"meet me over here\\"')
  })
})
