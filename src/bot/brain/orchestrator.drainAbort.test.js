// 261011: the post-teardown drain (drainPendingToolsOnTeardown) must be
// stoppable. It used to run leftover batch tools on a throwaway AbortController,
// so stop, pause and a new preempt could not halt a drained goTo/gather and it
// kept running alongside the next turn. These tests drive the real orchestrator
// with a scripted provider and a mock adapter whose long-runner (`gather`)
// settles only when its signal aborts, like the real behaviors.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { createActionStats, classifyActionOutcome } from './actionStats.js'

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

// goTo: the batch head, never settles (keeps the loop suspended so the rest of
// the batch sits on loop._pendingToolUses). gather: a long-runner that settles
// 'aborted' only when its signal fires (or when the test finishes it). equip:
// instant. Outcomes are classified the way adapter/minecraft/index.js does it
// (the signal the orchestrator passed decides `aborted`), into real stats.
function makeAdapter() {
  const executed = []
  const stats = createActionStats()
  const gatherFinish = []
  const adapter = {
    listActions: () => ['goTo', 'gather', 'equip'],
    getActionSchema: () => z.object({
      x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
      item: z.string().optional(), block: z.string().optional(), count: z.number().optional(),
    }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: async (name, args, ctx = {}) => {
      const rec = { name, args, signal: ctx.signal, settled: false }
      executed.push(rec)
      let result
      try {
        if (name === 'goTo') result = await new Promise(() => {})
        else if (name === 'gather') {
          result = await new Promise((res) => {
            gatherFinish.push(() => res('gathered 16/16 oak_log'))
            if (ctx.signal?.aborted) return res('aborted')
            ctx.signal?.addEventListener('abort', () => res('aborted'), { once: true })
          })
        } else result = `${name}:ok`
        return result
      } finally {
        rec.settled = true
        stats.recordAction(name, 1, classifyActionOutcome({ result, aborted: ctx.signal?.aborted === true }))
      }
    },
  }
  return { adapter, executed, stats, finishGather: () => gatherFinish.forEach((f) => f()) }
}

function makeConfig() {
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-drain-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const chat = (text) => ({ text, message: text, username: 'Steve', playerSpoke: true, ts: Date.now() })

// The turn that strands a batch: goTo suspends, gather + equip queue behind it.
const BATCH = {
  text: '',
  toolUses: [
    { id: 'say1', name: 'say', input: { text: 'on it' } },
    { id: 'go1', name: 'goTo', input: { x: 1, y: 64, z: 1 } },
    { id: 'ga1', name: 'gather', input: { block: 'oak_log', count: 16 } },
    { id: 'eq1', name: 'equip', input: { item: 'stone_axe' } },
  ],
}

// Open the batch, then tear it down with an attack so the drain starts.
async function strandAndDrain(script = [BATCH, { text: 'ok', toolUses: [] }]) {
  _setTickIntervalForTests(10_000_000) // park the 10s auto-tick
  const env = makeAdapter()
  const reenqueued = []
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter: env.adapter,
    config: makeConfig(),
    reenqueue: (ev, d, p) => reenqueued.push({ ev, d, p }),
    _anthropicOverride: provider,
  })
  await orch.handleDispatch('sei:chat_received', chat('get wood then grab the axe'))
  expect(orch.currentLoop?.inFlight?.name).toBe('goTo')
  expect(orch.currentLoop?._pendingToolUses?.map((e) => e.use.name)).toEqual(['gather', 'equip'])
  await orch.handleDispatch('sei:attacked', { attackerLabel: 'zombie', attackerKind: 'mob' })
  await flush()
  expect(orch.currentLoop).toBeNull()
  return { ...env, orch, provider, reenqueued }
}

const names = (executed) => executed.map((e) => e.name)
const gatherRec = (executed) => executed.find((e) => e.name === 'gather')

describe('261011 post-teardown drain is abortable', () => {
  it('runs to completion when nothing interrupts it, and the re-fired attack does not cancel it', async () => {
    const { orch, executed, reenqueued, finishGather, stats } = await strandAndDrain()
    // The drained gather is visible to the snapshot's in_flight line.
    expect(orch.inflight.current()?.name).toBe('gather')
    // The attack teardown re-fires the SAME attack as a fresh dispatch; that is
    // the event that started the drain, not a new preempt.
    const refire = reenqueued.find((e) => e.ev === 'sei:attacked')
    expect(refire).toBeTruthy()
    await orch.handleDispatch('sei:attacked', refire.d)
    await flush()
    expect(gatherRec(executed).signal.aborted).toBe(false)
    finishGather()
    await flush(); await flush()
    expect(names(executed)).toEqual(['goTo', 'gather', 'equip'])
    expect(stats.snapshot().actions.gather).toMatchObject({ n: 1, ok: 1, fail: 0 })
    expect(stats.snapshot().actions.equip).toMatchObject({ n: 1, ok: 1 })
    expect(orch.inflight.current()).toBeNull()
  })

  it('stop (abortActive) during a drained action aborts it promptly and drops the rest', async () => {
    const { orch, executed, stats } = await strandAndDrain()
    const g = gatherRec(executed)
    expect(g.settled).toBe(false)
    orch.abortActive()
    expect(g.signal.aborted).toBe(true)
    await flush(); await flush()
    expect(g.settled).toBe(true)
    // The queued equip after it never ran.
    expect(names(executed)).toEqual(['goTo', 'gather'])
    // Telemetry still sees it as a preempt abort.
    expect(stats.snapshot().actions.gather.reasons).toEqual({ aborted_by_preempt: 1 })
  })

  it('pause during a drained action aborts it; nothing else runs while paused', async () => {
    const { orch, executed, stats } = await strandAndDrain()
    orch.setGamePaused(true)
    await flush(); await flush()
    expect(gatherRec(executed).signal.aborted).toBe(true)
    expect(names(executed)).toEqual(['goTo', 'gather'])
    expect(stats.snapshot().actions.gather.reasons).toEqual({ aborted_by_preempt: 1 })
  })

  it('a teardown while paused does not drain at all (pause gate)', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, executed } = makeAdapter()
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {},
      _anthropicOverride: makeProvider([BATCH]),
    })
    await orch.handleDispatch('sei:chat_received', chat('get wood then grab the axe'))
    expect(orch.currentLoop?._pendingToolUses?.length).toBe(2)
    orch.setGamePaused(true)
    await orch.handleDispatch('sei:attacked', { attackerLabel: 'zombie', attackerKind: 'mob' })
    await flush(); await flush()
    expect(names(executed)).toEqual(['goTo'])
  })

  it('a new player line aborts the drained action', async () => {
    const script = [BATCH, { text: '', toolUses: [{ id: 's2', name: 'say', input: { text: 'ok stopping' } }] }]
    const { orch, executed, stats } = await strandAndDrain(script)
    await orch.handleDispatch('sei:chat_received', chat('stop'))
    await flush(); await flush()
    expect(gatherRec(executed).signal.aborted).toBe(true)
    expect(names(executed)).toEqual(['goTo', 'gather'])
    expect(stats.snapshot().actions.gather.reasons).toEqual({ aborted_by_preempt: 1 })
  })

  it('a new attack aborts the drained action', async () => {
    const { orch, executed } = await strandAndDrain()
    await orch.handleDispatch('sei:attacked', { attackerLabel: 'skeleton', attackerKind: 'mob' })
    await flush(); await flush()
    expect(gatherRec(executed).signal.aborted).toBe(true)
    expect(names(executed)).toEqual(['goTo', 'gather'])
  })

  it('a new turn dispatching its own world action supersedes the drain', async () => {
    const script = [
      BATCH,
      { text: '', toolUses: [{ id: 'eq9', name: 'equip', input: { item: 'shield' } }] },
      { text: 'done', toolUses: [] },
    ]
    const { orch, executed, reenqueued } = await strandAndDrain(script)
    // The re-fired attack opens the reaction turn, which acts in the world.
    const refire = reenqueued.find((e) => e.ev === 'sei:attacked')
    await orch.handleDispatch('sei:attacked', refire.d)
    await flush(); await flush()
    expect(gatherRec(executed).signal.aborted).toBe(true)
    // The new turn's equip ran; the drained one queued after gather did not.
    expect(executed.filter((e) => e.name === 'equip').map((e) => e.args.item)).toEqual(['shield'])
  })

  it('a death drops the dying turn\'s queued actions instead of draining them', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, executed } = makeAdapter()
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {},
      _anthropicOverride: makeProvider([BATCH]),
    })
    await orch.handleDispatch('sei:chat_received', chat('get wood then grab the axe'))
    await orch.handleDispatch('sei:death', { deathPos: { x: 0, y: 64, z: 0 } })
    await flush(); await flush()
    expect(orch.currentLoop).toBeNull()
    expect(names(executed)).toEqual(['goTo'])
  })
})
