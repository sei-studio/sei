// 261011: the first-spawn greeting no longer assumes a shared past.
// Quality eval 2026-10-11: with empty memory she opened "yo alex, back in the
// world" (first_meeting) and "you actually made it back" (building), because
// the only FIRST CONTACT wording said to greet them "like you're glad to be
// back". Harness mirrors orchestrator.stopVsEndLoop.test.js.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { ACK_LINE } from './prompts.js'

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

function makeConfig() {
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-firstcontact-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
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


const firstTurnText = (provider) => JSON.stringify(provider.calls[0]?.messages ?? provider.calls[0])

describe('261011 FIRST CONTACT wording follows the memory', () => {
  it('with no memory the greeting is framed as a first meeting', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([{ text: '', toolUses: [] }])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn', quietMs: 0 })
    const t = firstTurnText(provider)
    expect(t).toContain('FIRST CONTACT')
    expect(t).toContain('first time you two have played together')
    expect(t).not.toContain('greet a friend coming back')
  })

  it('with a past memory entry the returning-friend wording is kept', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([{ text: '', toolUses: [] }])
    const { adapter } = makeAdapter()
    const config = makeConfig()
    fs.writeFileSync(config.memory.memory_md_path, '# Memory\n\n- [2026-10-01 12:00] steve likes building castles\n')
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn', quietMs: 0 })
    const t = firstTurnText(provider)
    expect(t).toContain('greet a friend coming back')
    expect(t).not.toContain('first time you two have played together')
  })
})

// 261012: her first-spawn hello and the player's own "hey" cross in flight;
// the reply to that first player line is told she already greeted them.
describe('261012 crossed greeting', () => {
  const NOTE = 'it already answers their hello'
  const sayTurn = (text) => ({ text: '', toolUses: [{ id: `s${text.length}`, name: 'say', input: { text } }, { id: 'el', name: 'end_loop', input: {} }] })
  // Live order (brain/index.js): the line is recorded, then dispatched.
  const say2 = async (orch, text) => {
    orch.recordIncomingChat('Steve', text)
    await orch.handleDispatch('sei:chat_received', chat(text))
  }
  const lastTurnText = (provider) => JSON.stringify(provider.calls.at(-1)?.messages ?? provider.calls.at(-1))

  it('the reply to the first player line after her greeting carries the note, once', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([sayTurn('heyyy steve'), sayTurn('lol yeah im here'), sayTurn('sure')])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn', quietMs: 0 })
    await say2(orch, 'hey sui')
    expect(lastTurnText(provider)).toContain(NOTE)
    // 261101 (pass 34): the crossed-hello turn keeps its own wording. Worded
    // like ACK_LINE ("it needs no answer: skip say()") she greeted again on 6
    // of 15 crossed hellos in the paired compare, against 0 of 14 with this.
    expect(lastTurnText(provider)).toContain('do not call say() this turn; that is the one exception to answering every line')
    expect(lastTurnText(provider)).not.toContain(ACK_LINE)
    // The mandatory-reply framing is swapped out for this one line.
    expect(lastTurnText(provider)).not.toContain('a direct message never gets silence')
    expect(lastTurnText(provider)).not.toContain('but say something')
    await say2(orch, 'wanna get wood')
    expect(lastTurnText(provider)).not.toContain(NOTE)
  })

  it('mid-action: the hello that crossed hers gets the same note', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'heyyy steve' } }, { id: 'g1', name: 'gather', input: { name: 'oak_log' } }] },
      { text: '', toolUses: [] },
    ])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn', quietMs: 0 })
    await flush()
    await say2(orch, 'hey sui')
    await flush()
    expect(provider.calls.length).toBeGreaterThanOrEqual(2)
    expect(lastTurnText(provider)).toContain("You're currently: gather")
    expect(lastTurnText(provider)).toContain(NOTE)
    // 261017 (pass 13): the own_repeats tail quotes her hello without the
    // reply ask ("find something new to say").
    expect(lastTurnText(provider)).toContain('They already heard it.')
    expect(lastTurnText(provider)).not.toContain('find something new to say')
  })

  it('no note when the player stayed silent and says hello long after her greeting', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([sayTurn('heyyy steve'), sayTurn('oh hey')])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn', quietMs: 0 })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000)
      await say2(orch, 'hey sui')
    } finally {
      vi.useRealTimers()
    }
    expect(lastTurnText(provider)).not.toContain(NOTE)
    expect(lastTurnText(provider)).toContain('a direct message never gets silence')
    // 261101 (pass 34): the plain reply lets an acknowledgement go unanswered,
    // and only there: the event hint keeps dev's "but say something".
    expect(lastTurnText(provider)).toContain(ACK_LINE)
    expect(lastTurnText(provider)).toContain('but say something')
  })

  it('no note when she never said a greeting', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([{ text: '', toolUses: [] }, sayTurn('hey')])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn', quietMs: 0 })
    await say2(orch, 'hey sui')
    expect(lastTurnText(provider)).not.toContain(NOTE)
  })
})

// 261017 (pass 13): the first-spawn tick is a P3 idle that waits behind any
// running loop. When the player's hello got there first, the reply greeted
// them (GREETING_HINT), and the tick must not greet them again.
describe('261017 no second greeting turn', () => {
  const sayTurn = (text) => ({ text: '', toolUses: [{ id: `s${text.length}`, name: 'say', input: { text } }, { id: 'el', name: 'end_loop', input: {} }] })

  it('the first-spawn tick after she already greeted is a plain idle tick', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([sayTurn('oh hey steve'), { text: '', toolUses: [] }])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    orch.recordIncomingChat('Steve', 'hey sui')
    await orch.handleDispatch('sei:chat_received', chat('hey sui'))
    expect(JSON.stringify(provider.calls[0])).toContain('You have not greeted the player yet')
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn', quietMs: 0 })
    expect(provider.calls.length).toBe(2)
    expect(JSON.stringify(provider.calls[1])).not.toContain('FIRST CONTACT')
  })

  // Review (pass 13): main marks the home-screen plan used at session
  // start, so when FIRST CONTACT is skipped the plan rides the greeting hint
  // on the reply turn instead, or it never comes up.
  it('the reply that greets carries the open plan from the home screen', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([sayTurn('oh hey steve, cabin roof today?'), { text: '', toolUses: [] }])
    const { adapter } = makeAdapter()
    const config = makeConfig()
    config._seiNextStepPlan = 'finish the cabin roof'
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    orch.recordIncomingChat('Steve', 'hey sui')
    await orch.handleDispatch('sei:chat_received', chat('hey sui'))
    const first = JSON.stringify(provider.calls[0])
    expect(first).toContain('You have not greeted the player yet')
    expect(first).toContain('saved this to pick up next time: \\"finish the cabin roof\\"')
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn', quietMs: 0 })
    expect(JSON.stringify(provider.calls[1])).not.toContain('finish the cabin roof')
  })

  it('no plan cue on the hint when none is open', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([sayTurn('oh hey steve')])
    const { adapter } = makeAdapter()
    const config = makeConfig()
    config._seiNextStepPlan = null
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    orch.recordIncomingChat('Steve', 'hey sui')
    await orch.handleDispatch('sei:chat_received', chat('hey sui'))
    const first = JSON.stringify(provider.calls[0])
    expect(first).toContain('You have not greeted the player yet')
    expect(first).not.toContain('pick up next time')
  })

  it('without an earlier line the first-spawn tick still greets', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([{ text: '', toolUses: [] }])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn', quietMs: 0 })
    expect(JSON.stringify(provider.calls[0])).toContain('FIRST CONTACT')
  })
})
