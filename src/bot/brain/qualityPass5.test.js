// 261012: quality pass 5.
//  - a player stop holds her own idle initiative: the next idle tick does
//    not start the goal again (every stop_gather failure in the eval was an
//    idle tick 5-7s after the stop re-issuing the gather from her goal)
//  - the hold ends after its window, or when the player gives her new work
//  - a player line landing on an action she started on her own says their
//    request comes first

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests, asksToStop } from './orchestrator.js'

function makeProvider(script) {
  let i = 0
  const calls = []
  return {
    calls,
    capabilities: { vision: false, cached: false, local: false },
    buildCachedSystem: (blocks) => blocks,
    setAuthToken() {},
    setBackend() {},
    async call(args) {
      calls.push(args)
      const r = script[Math.min(i, script.length - 1)]
      i += 1
      if (typeof r === 'function') return r(args)
      return r
    },
  }
}

// gather runs until aborted (a long foreground job); follow never settles
// (background trail); unfollow and goTo settle at once.
function makeAdapter() {
  const executed = []
  const aborted = []
  const adapter = {
    listActions: () => ['gather', 'goTo', 'follow', 'unfollow'],
    getActionSchema: () => z.object({ name: z.string().optional(), player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, args, opts) => {
      executed.push(name)
      if (name === 'gather') {
        return new Promise((resolve) => {
          const sig = opts?.signal
          if (sig) sig.addEventListener('abort', () => { aborted.push(name); resolve('aborted after 2/12 oak_log') }, { once: true })
        })
      }
      if (name === 'follow') return new Promise(() => {})
      return Promise.resolve(`${name} ok`)
    },
  }
  return { adapter, executed, aborted }
}

function makeConfig(memory = {}) {
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-pass5-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
      ...memory,
    },
  }
}

const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const flush = () => new Promise((r) => setTimeout(r, 0))
const gatherTurn = { text: '', toolUses: [{ id: 'g1', name: 'gather', input: { name: 'oak_log' } }] }

function toolResultsOf(call) {
  const out = []
  for (const m of call?.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === 'tool_result') out.push(b)
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('261012 player stop holds idle initiative', () => {
  it('after stop, an idle tick makes no model call', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'ok stopping' } }, { id: 'st1', name: 'stop', input: {} }] },
      gatherTurn,
    ])
    const { adapter, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('stop'))
    await flush()
    expect(aborted).toEqual(['gather'])
    expect(orch.currentLoop).toBeNull()
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    await flush()
    expect(provider.calls.length).toBe(before)
    expect(orch.currentLoop).toBeNull()
  })

  it('a bare stop line answered with end_loop also holds', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
      gatherTurn,
    ])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('sui stop'))
    await flush()
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(before)
  })

  it('the hold runs out after its window', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 'st1', name: 'stop', input: {} }] },
      { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig({ player_stop_hold_ms: 40 }), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('stop'))
    await flush()
    await sleep(60)
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(before + 1)
  })

  it('her own stop while taking a new order is no hold', async () => {
    // eval smelt_iron #5: "can you smelt this raw iron" answered with
    // stop() + say("on it") and no action; the hold kept her idle 120s.
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'yep on it' } }, { id: 'st1', name: 'stop', input: {} }] },
      { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('can you smelt this raw iron into ingots'))
    await flush()
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(before + 1)
  })

  it('asksToStop reads the player line, not negations', () => {
    for (const t of ['stop', 'actually stop', 'stop moving', 'wait stop', 'ok hold on']) expect(asksToStop(t)).toBe(true)
    for (const t of ['dont stop', 'never stop chopping', 'can you smelt this raw iron', 'unstoppable']) expect(asksToStop(t)).toBe(false)
  })

  it('new work from the player ends the hold', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 'st1', name: 'stop', input: {} }] },
      { text: '', toolUses: [{ id: 'go1', name: 'goTo', input: {} }] },
      { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
      { text: '', toolUses: [{ id: 'el2', name: 'end_loop', input: {} }] },
    ])
    const { adapter } = makeAdapter()
    const reenqueued = []
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: (e, d) => reenqueued.push([e, d]), _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('stop'))
    await flush()
    await orch.handleDispatch('sei:chat_received', chat('ok come over here'))
    await flush()
    // goTo settles at once; deliver its action_complete so the loop finishes.
    for (const [e, d] of reenqueued.splice(0)) if (e === 'sei:action_complete') await orch.handleDispatch(e, d)
    await flush()
    expect(orch.currentLoop).toBeNull()
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(before + 1)
  })
})

const lastUserText = (call) => {
  const msgs = call?.messages ?? []
  const m = msgs[msgs.length - 1]
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  return m.content.filter((b) => b.type === 'text' || b.type === 'tool_result')
    .map((b) => typeof b.content === 'string' ? b.content : b.text ?? JSON.stringify(b.content)).join('\n')
}
const OWN = 'Your current action is your own idea'

describe('261012 own action yields to a player order', () => {
  it('an idle-started gather: the player line is told their request comes first', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([gatherTurn, { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] }])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', {})
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
    await orch.handleDispatch('sei:chat_received', chat('can you make me a crafting table'))
    expect(lastUserText(provider.calls[1])).toContain(OWN)
  })

  it('a deferred order rides the next check-in on her own action', async () => {
    _setTickIntervalForTests(10_000_000)
    const sayOnly = { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'on it, after these logs' } }] }
    const quiet = { text: '', toolUses: [] }
    const provider = makeProvider([gatherTurn, sayOnly, quiet, quiet])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', {})
    await orch.handleDispatch('sei:chat_received', chat('make a crafting table'))
    await flush()
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
    const before = provider.calls.length
    await orch.handleDispatch('sei:action_tick', { elapsedSec: 30 })
    expect(provider.calls.length).toBe(before + 1)
    const text = lastUserText(provider.calls[before])
    expect(text).toContain('asked you: "make a crafting table", and it is still waiting')
    expect(text).not.toContain('CHECK-IN on your OWN routine action')
  })

  it('a check-in on a gather the player asked for keeps the plain framing', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([gatherTurn, { text: '', toolUses: [] }])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:action_tick', { elapsedSec: 30 })
    const text = lastUserText(provider.calls[1])
    expect(text).toContain('CHECK-IN on your OWN routine action')
    expect(text).not.toContain('still waiting')
  })

  it('a gather the player asked for gets the usual keep-going framing', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([gatherTurn, { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] }])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('how many so far'))
    const text = lastUserText(provider.calls[1])
    expect(text).toContain('Your current action is still running')
    expect(text).not.toContain(OWN)
  })
})

describe('261013 the waiting-order check-in can switch actions', () => {
  it('an action called on a check-in that carries the order replaces her own', async () => {
    _setTickIntervalForTests(10_000_000)
    const sayOnly = { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'on it, after these logs' } }] }
    const goTurn = { text: '', toolUses: [{ id: 'go1', name: 'goTo', input: { player: 'Steve' } }] }
    const quiet = { text: '', toolUses: [] }
    const provider = makeProvider([gatherTurn, sayOnly, goTurn, quiet])
    const { adapter, executed, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', {})
    await orch.handleDispatch('sei:chat_received', chat('go to the house pls'))
    await flush()
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
    await orch.handleDispatch('sei:action_tick', { elapsedSec: 30 })
    await flush()
    expect(executed).toContain('goTo')
    expect(aborted).toContain('gather')
  })
})

describe('261013 unpausing ends the stop hold', () => {
  it('the resume tick after play runs even inside the hold window', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'ok stopping' } }, { id: 'st1', name: 'stop', input: {} }] },
      { text: '', toolUses: [] },
    ])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('stop'))
    await flush()
    orch.setGamePaused(true)
    orch.setGamePaused(false)
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', { reason: 'game_unpaused' })
    await flush()
    expect(provider.calls.length).toBe(before + 1)
  })
})

describe('261013 a goal the player gives ends the stop hold', () => {
  it('setGoal from a player line after a stop lets the next idle tick run', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 'st1', name: 'stop', input: {} }] },
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'ok, house next' } }, { id: 'g1', name: 'setGoal', input: { goal: 'build a house' } }] },
      { text: '', toolUses: [] },
    ])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('stop'))
    await flush()
    await orch.handleDispatch('sei:chat_received', chat('ok lets build a house instead'))
    await flush()
    expect(orch.currentLoop).toBeNull()
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(before + 1)
  })
})




