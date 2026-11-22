// 261011: end_loop ends the TURN; stop cancels the running action.
//
// Quality eval 2026-10-11 (Haiku 5.5, 7 scenarios): 21 end_loop-only turns
// landed while a foreground action was running. About 18 of them were the
// model choosing to stay quiet ("staying quiet and letting it run"), on the
// silent 10s check-in or after a player line that agreed with the task ("ok
// good. grab the acacia then come to the table"). end_loop also aborted the
// in_flight action, so builds died at 2/21 and gathers at 2/12. Now end_loop
// with a foreground action running keeps it, and the separate stop tool is
// what cancels.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests, isBareStopLine } from './orchestrator.js'

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
      memory_md_path: path.join(os.tmpdir(), `sei-stopvs-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
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

describe('261011 end_loop keeps a running action; stop cancels it', () => {
  it('end_loop on a player line while gather runs: the gather keeps running and the loop stays suspended on it', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: 'they agree, nothing to add', toolUses: [{ id: 's1', name: 'say', input: { text: 'yep, on it' } }, { id: 'el1', name: 'end_loop', input: {} }] },
      { text: '', toolUses: [{ id: 'el2', name: 'end_loop', input: {} }] },
    ])
    const { adapter, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })

    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')

    await orch.handleDispatch('sei:chat_received', chat('ok good. grab the logs then come back'))
    await flush()
    expect(aborted).toEqual([])
    expect(orch.currentLoop).not.toBeNull()
    expect(orch.currentLoop.inFlight?.name).toBe('gather')
    expect(adapter.chat).toHaveBeenCalledWith('yep, on it')

    // The next call carries a result for every tool_use of that turn, and the
    // end_loop result says the action is still going.
    await orch.handleDispatch('sei:chat_received', chat('how many so far'))
    const results = toolResultsOf(provider.calls[2])
    const endRes = results.find((r) => r.tool_use_id === 'el1')
    expect(endRes?.content).toMatch(/gather keeps running/)
    expect(results.some((r) => r.tool_use_id === 's1')).toBe(true)
  })

  it('stop on a player line while gather runs: the gather is aborted and the loop ends', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'ok stopping' } }, { id: 'st1', name: 'stop', input: {} }] },
    ])
    const { adapter, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })

    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('wait stop, stay here'))
    await flush()
    expect(aborted).toEqual(['gather'])
    expect(orch.currentLoop).toBeNull()
  })

  it('stop + a new action replaces the running one in the same loop', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 'st1', name: 'stop', input: {} }, { id: 'go1', name: 'goTo', input: {} }] },
      { text: '', toolUses: [] },
    ])
    const { adapter, aborted, executed } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })

    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('actually go to the house instead'))
    await flush()
    expect(aborted).toEqual(['gather'])
    expect(executed).toContain('goTo')
  })

  it('stop while following also runs unfollow (aborting the follow entry alone keeps trailing)', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'f1', name: 'follow', input: { player: 'Steve' } }] },
      { text: '', toolUses: [{ id: 'st1', name: 'stop', input: {} }] },
    ])
    const { adapter, executed } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })

    await orch.handleDispatch('sei:chat_received', chat('follow me'))
    await orch.handleDispatch('sei:chat_received', chat('ok stop following'))
    await flush()
    expect(executed).toContain('unfollow')
    expect(orch.currentLoop).toBeNull()
  })

  it('end_loop with nothing running still ends the loop', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'hey' } }, { id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('hi'))
    expect(orch.currentLoop).toBeNull()
  })

  it('offers the stop tool to the model', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([{ text: '', toolUses: [] }])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('hi'))
    const names = (provider.calls[0]?.tools ?? []).map((t) => t.name)
    expect(names).toContain('stop')
    expect(names).toContain('end_loop')
  })
  it('backstop: a bare "stop" answered with end_loop (no stop tool) still cancels the action', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'ok ok' } }, { id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const { adapter, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('sui stop!'))
    await flush()
    expect(aborted).toEqual(['gather'])
    expect(orch.currentLoop).toBeNull()
  })

  it('isBareStopLine: stop orders only, not negations or longer requests', () => {
    for (const t of ['stop', 'STOP!', 'sui stop', 'wait stop', 'ok stop it', 'nevermind', 'never mind', 'cancel', 'stop now pls']) {
      expect(isBareStopLine(t)).toBe(true)
    }
    for (const t of ['dont stop', "don't stop!", 'never stop', 'do not stop', 'stop following me', 'grab logs then stop', '', 'stopwatch']) {
      expect(isBareStopLine(t)).toBe(false)
    }
  })
})




