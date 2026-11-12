// 261112: a voice line that cut her off mid-line (the app's barge-in).
//  - deliverSeiChat's event carries interrupted + cutLine (voiceLineEvent)
//  - the turn tells the model it was cut off and what was not heard
//  - the forced stop rules (bare-stop backstops, the 120 s player stop hold)
//    skip such a line; her own stop() still stops the action, with the short
//    interrupt hold
//  - a plain voice or typed "stop" keeps the old behaviour
//  - analytics: voice_interrupt_msgs / voice_interrupt_stops counters

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests, cutInOf } from './orchestrator.js'
import { NUDGES } from './promptLibrary.js'
import { voiceLineEvent } from './index.js'
import { createActionStats, sessionActionStats } from './actionStats.js'

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

// gather runs until aborted; follow never settles (background trail).
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
      memory_md_path: path.join(os.tmpdir(), `sei-bargein-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
      ...memory,
    },
  }
}

const CUT = 'ok so the cave is right past that big oak'
const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const voice = (text) => ({ ...voiceLineEvent({ who: 'Steve', raw: text }), ts: Date.now() })
const cutIn = (text, line = CUT) => ({ ...voiceLineEvent({ who: 'Steve', raw: text, interrupted: true, cutLine: line }), ts: Date.now() })
const flush = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const gatherTurn = { text: '', toolUses: [{ id: 'g1', name: 'gather', input: { name: 'oak_log' } }] }
const sayOnly = (text) => ({ text: '', toolUses: [{ id: `s-${text}`, name: 'say', input: { text } }] })
const allText = (call) => JSON.stringify(call?.messages ?? [])
const CUT_MARK = 'while you were still talking'

beforeEach(() => {
  _setTickIntervalForTests(10_000_000)
  sessionActionStats._reset()
})

describe('plumbing (261112)', () => {
  it('voiceLineEvent marks a cut-in and leaves a plain voice line as before', () => {
    expect(voiceLineEvent({ who: 'Steve', raw: 'stop' })).toEqual({
      username: 'Steve', message: 'stop', text: 'stop', addressed: true, playerSpoke: true, seiChat: true, voice: true,
    })
    const e = voiceLineEvent({ who: 'Steve', raw: 'wait', interrupted: true, cutLine: `  ${'x'.repeat(400)} ` })
    expect(e.interrupted).toBe(true)
    expect(e.cutLine).toBe('x'.repeat(300))
  })

  it('cutInOf reads the mark, never on a teammate line', () => {
    expect(cutInOf(cutIn('wait'))).toEqual({ line: CUT })
    expect(cutInOf(voice('wait'))).toBeNull()
    expect(cutInOf({ ...cutIn('wait'), playerSpoke: false })).toBeNull()
    expect(cutInOf(null)).toBeNull()
  })

  it('the cut-off note is plain prompt text', () => {
    const withLine = NUDGES.cutOff(CUT)
    expect(withLine).toContain(`"${CUT}"`)
    expect(withLine).toContain(CUT_MARK)
    expect(NUDGES.cutOff('')).toContain(CUT_MARK)
    expect(`${withLine}${NUDGES.cutOff('')}`).not.toMatch(/—/)
  })

  it('actionStats counts cut-in voice lines and the stops after them', () => {
    const s = createActionStats()
    s.notePlayerChat({ voice: true, interrupted: true })
    s.notePlayerChat({ voice: true })
    s.noteInterruptStop()
    expect(s.snapshot().counters).toMatchObject({ voice_msgs: 2, voice_interrupt_msgs: 1, voice_interrupt_stops: 1 })
  })
})

describe('a voice line that cut her off (261112)', () => {
  it('mid-action: the turn says she was cut off and what was not heard', async () => {
    const provider = makeProvider([gatherTurn, sayOnly('oh sorry, go ahead')])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    expect(allText(provider.calls[0])).not.toContain(CUT_MARK)
    await orch.handleDispatch('sei:chat_received', cutIn('wait'))
    await flush()
    const text = allText(provider.calls[1])
    expect(text).toContain(CUT_MARK)
    expect(text).toContain(CUT)
  })

  it('a bare stop answered with words only does not cancel the action', async () => {
    const provider = makeProvider([gatherTurn, sayOnly('oh sorry, go ahead')])
    const { adapter, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', cutIn('stop'))
    await flush()
    expect(aborted).toEqual([])
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })

  it('a bare stop answered with end_loop leaves the action running', async () => {
    const provider = makeProvider([gatherTurn, { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] }])
    const { adapter, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', cutIn('sui stop'))
    await flush()
    expect(aborted).toEqual([])
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })

  it('a follow keeps trailing when she takes the cut-in as about her talking', async () => {
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'f1', name: 'follow', input: { player: 'Steve' } }] },
      sayOnly('oops, sorry'),
    ])
    const { adapter, executed } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('follow me'))
    await orch.handleDispatch('sei:chat_received', cutIn('stop'))
    await flush()
    expect(executed).not.toContain('unfollow')
  })

  it('her own stop() still stops the action, with the short hold instead of the long one', async () => {
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'ok' } }, { id: 'st1', name: 'stop', input: {} }] },
      { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const { adapter, aborted } = makeAdapter()
    const config = makeConfig({ interrupt_stop_hold_ms: 40, player_stop_hold_ms: 10_000_000 })
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', cutIn('wait'))
    await flush()
    expect(aborted).toEqual(['gather'])
    expect(orch.currentLoop).toBeNull()
    expect(sessionActionStats.snapshot().counters.voice_interrupt_stops).toBe(1)
    // Inside the short hold her own initiative still waits...
    let before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(before)
    // ...and it is over long before the 120 s player stop hold would be.
    await sleep(60)
    before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(before + 1)
  })

  it('a cut-in with nothing running: note in the seed turn, and no hold', async () => {
    const provider = makeProvider([sayOnly('oh, sorry'), { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] }])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', cutIn('stop', ''))
    await flush()
    expect(allText(provider.calls[0])).toContain(CUT_MARK)
    expect(orch.currentLoop).toBeNull()
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(before + 1)
    expect(sessionActionStats.snapshot().counters.voice_interrupt_stops).toBe(0)
  })
})

describe('without a cut-in, stop works as before (261112 regression guard)', () => {
  it('a plain voice "stop" answered with words only cancels the action and holds', async () => {
    const provider = makeProvider([gatherTurn, sayOnly('ok ok stopping'), gatherTurn])
    const { adapter, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', voice('stop'))
    await flush()
    expect(allText(provider.calls[1])).not.toContain(CUT_MARK)
    expect(aborted).toEqual(['gather'])
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(before)
  })

  it('a typed "wait" answered with stop() takes the long hold', async () => {
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'ok' } }, { id: 'st1', name: 'stop', input: {} }] },
      gatherTurn,
    ])
    const { adapter, aborted } = makeAdapter()
    const config = makeConfig({ interrupt_stop_hold_ms: 40, player_stop_hold_ms: 10_000_000 })
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:chat_received', chat('wait'))
    await flush()
    expect(aborted).toEqual(['gather'])
    await sleep(60)
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(before)
    expect(sessionActionStats.snapshot().counters.voice_interrupt_stops).toBe(0)
  })
})
