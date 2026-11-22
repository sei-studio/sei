// 261019 (quality pass 18): her own repeat call no longer aborts the fight
// that is running.
//
// combat_night eval, 10 runs: 27 attackEntity calls ended "aborted after N/8
// hits" because a mid-action turn (a player line, a hit) called attackEntity
// again, nearly always on the mob it was already fighting, and R2 aborted the
// running attack to start the same one over. Now the adapter's
// continueRunningAction folds such a call into the running action, and a hit
// that lands while a mid-action call is parked on a running fight is
// swallowed instead of tearing the fight down.
//
// Harness mirrors orchestrator.midActionAttack.test.js.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

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

const CONTINUE_LINE = 'your attackEntity is already on that zombie, so it keeps going'

// attackEntity runs until aborted (a fight in progress); goTo settles at once.
// continueRunningAction: attackEntity on the same mob name continues.
function makeAdapter({ withContinue = true } = {}) {
  const executed = []
  const aborted = []
  const continueAsked = []
  const adapter = {
    listActions: () => ['attackEntity', 'goTo'],
    getActionSchema: () => z.object({ entity: z.string().optional(), times: z.number().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: (ev, d) => (ev === 'sei:attacked' ? `Interrupted: ${d?.attackerLabel ?? 'something'} hit you.` : ''),
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, args, opts) => {
      executed.push({ name, args })
      if (name === 'attackEntity') {
        return new Promise((resolve) => {
          const sig = opts?.signal
          if (sig) sig.addEventListener('abort', () => { aborted.push(name); resolve('aborted after 2/8 hits on zombie') }, { once: true })
        })
      }
      return Promise.resolve(`${name} ok`)
    },
  }
  if (withContinue) {
    adapter.continueRunningAction = (running, use) => {
      continueAsked.push(use.name)
      if (running.name === 'attackEntity' && use.name === 'attackEntity' && use.input?.entity === running.input?.entity) {
        return CONTINUE_LINE
      }
      return null
    }
  }
  return { adapter, executed, aborted, continueAsked }
}

function makeConfig() {
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-continuefight-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
    },
  }
}

const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const flush = () => new Promise((r) => setTimeout(r, 0))
const hit = (label = 'zombie') => ({ attackerLabel: label, attackerKind: 'mob' })
const attack = (id, entity = 'zombie') => ({ id, name: 'attackEntity', input: { entity, times: 8 } })
const fightTurn = { text: '', toolUses: [attack('a1')] }

function toolResultsOf(call) {
  const out = []
  for (const m of call?.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === 'tool_result') out.push(b)
  }
  return out
}

describe('261019 a repeat attackEntity on the running fight continues it', () => {
  it('a player line answered with attackEntity on the same mob keeps the running attack', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      fightTurn,
      { text: '', toolUses: [
        { id: 's1', name: 'say', input: { text: 'on it' } },
        attack('a2'),
      ] },
      { text: '', toolUses: [] },
    ])
    const { adapter, executed, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })

    await orch.handleDispatch('sei:chat_received', chat('kill that zombie'))
    expect(orch.currentLoop?.inFlight?.name).toBe('attackEntity')
    await orch.handleDispatch('sei:chat_received', chat('kill it pls!!'))
    await flush()

    expect(aborted).toEqual([])
    expect(executed.filter((e) => e.name === 'attackEntity')).toHaveLength(1)
    expect(orch.currentLoop?.inFlight?.name).toBe('attackEntity')
    expect(adapter.chat).toHaveBeenCalledWith('on it')
    // The loop suspends on the running fight: no extra call to read the result.
    expect(provider.calls).toHaveLength(2)

    // The next call carries the continuation line as the repeat call's result.
    await orch.handleDispatch('sei:chat_received', chat('u ok?'))
    const results = toolResultsOf(provider.calls[2])
    expect(results.find((r) => r.tool_use_id === 'a2')?.content).toBe(CONTINUE_LINE)
  })

  it('attackEntity on a different mob still replaces the running attack', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      fightTurn,
      { text: '', toolUses: [attack('a2', 'skeleton')] },
      { text: '', toolUses: [] },
    ])
    const { adapter, executed, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill that zombie'))
    await orch.handleDispatch('sei:chat_received', chat('no the skeleton!'))
    await flush()
    expect(aborted).toEqual(['attackEntity'])
    expect(executed.map((e) => e.args?.entity)).toEqual(['zombie', 'skeleton'])
  })

  it('a batch with new work besides the repeat call replaces the running attack', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      fightTurn,
      { text: '', toolUses: [{ id: 'g1', name: 'goTo', input: {} }, attack('a2')] },
      { text: '', toolUses: [] },
    ])
    const { adapter, executed, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill that zombie'))
    await orch.handleDispatch('sei:chat_received', chat('come here first'))
    await flush()
    expect(aborted).toEqual(['attackEntity'])
    expect(executed.map((e) => e.name)).toContain('goTo')
  })

  it('stop plus attackEntity is not a continuation: the adapter is not asked', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      fightTurn,
      { text: '', toolUses: [{ id: 'st', name: 'stop', input: {} }, attack('a2')] },
      { text: '', toolUses: [] },
    ])
    const { adapter, aborted, continueAsked } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill that zombie'))
    await orch.handleDispatch('sei:chat_received', chat('start over'))
    await flush()
    expect(continueAsked).toEqual([])
    expect(aborted).toEqual(['attackEntity'])
  })

  it('repeat call + end_loop ends the turn and fills the repeat slot with the continuation line', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      fightTurn,
      { text: '', toolUses: [attack('a2'), { id: 'e1', name: 'end_loop', input: {} }] },
      { text: '', toolUses: [] },
    ])
    const { adapter, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill that zombie'))
    await orch.handleDispatch('sei:chat_received', chat('get it!'))
    await flush()
    expect(aborted).toEqual([])
    expect(orch.currentLoop?.inFlight?.name).toBe('attackEntity')
    await orch.handleDispatch('sei:chat_received', chat('u ok?'))
    const results = toolResultsOf(provider.calls[2])
    expect(results.find((r) => r.tool_use_id === 'a2')?.content).toBe(CONTINUE_LINE)
  })

  it('without the adapter member the old R2 restart is unchanged', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      fightTurn,
      { text: '', toolUses: [attack('a2')] },
      { text: '', toolUses: [] },
    ])
    const { adapter, aborted, executed } = makeAdapter({ withContinue: false })
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill that zombie'))
    await orch.handleDispatch('sei:chat_received', chat('kill it pls!!'))
    await flush()
    expect(aborted).toEqual(['attackEntity'])
    expect(executed.filter((e) => e.name === 'attackEntity')).toHaveLength(2)
  })
})

describe('261019 a hit during a mid-action call does not tear down a running fight', () => {
  it('handlePreempt swallows the hit while attackEntity runs and a player-line call is parked', async () => {
    _setTickIntervalForTests(10_000_000)
    let release
    const parked = new Promise((r) => { release = r })
    let claimed = null
    let orch
    const provider = makeProvider([
      fightTurn,
      async () => {
        claimed = orch.handlePreempt('sei:attacked', { ...hit(), health: 15 })
        await parked
        return { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'almost got it' } }] }
      },
      { text: '', toolUses: [] },
    ])
    const { adapter, aborted } = makeAdapter()
    orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill that zombie'))
    const p = orch.handleDispatch('sei:chat_received', chat('hurry!!'))
    await flush()
    release()
    await p
    await flush()
    expect(claimed).toBe(true)
    expect(aborted).toEqual([])
    expect(adapter.chat).toHaveBeenCalledWith('almost got it')
    expect(orch.currentLoop?.inFlight?.name).toBe('attackEntity')
  })

  it('the same hit during a parked call on a non-fight action is not swallowed', async () => {
    _setTickIntervalForTests(10_000_000)
    let release
    const parked = new Promise((r) => { release = r })
    let claimed = null
    let orch
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 's0', name: 'say', input: { text: 'coming' } }, { id: 'g1', name: 'goTo', input: {} }] },
      async () => {
        claimed = orch.handlePreempt('sei:attacked', { ...hit(), health: 15 })
        await parked
        return { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'ow' } }] }
      },
      { text: '', toolUses: [] },
    ])
    const { adapter } = makeAdapter()
    // A goTo that runs until aborted, so a mid-action call can park on it.
    adapter.executeAction = (name, args, opts) => new Promise((resolve) => {
      opts?.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
    orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('come here'))
    expect(orch.currentLoop?.inFlight?.name).toBe('goTo')
    const p = orch.handleDispatch('sei:chat_received', chat('hurry!!'))
    await flush()
    release()
    await p
    await flush()
    // Not claimed: the queued attack event drives the usual teardown/reseed.
    expect(claimed).toBe(false)
  })
})




