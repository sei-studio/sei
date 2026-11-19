// src/bot/brain/orchestrator.death.test.js
//
// 260703 (death→brain): end-to-end delivery of the new sei:death event through
// the orchestrator. Two guarantees:
//   1. A fresh sei:death dispatch seeds the death framing (with the drop coords)
//      into the model's turn — the model actually learns it died and where its
//      items are, instead of confabulating.
//   2. A sei:death arriving MID-LOOP (the player killed the bot mid-action) is
//      NOT dropped by the single-flight branch: it aborts the loop, tears it
//      down, and re-fires at P1 so a fresh turn reacts.
//
// Uses a scripted provider + minimal adapter with the REAL minecraft
// eventAddendum so the death prose is exercised through the true prompt path.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator } from './orchestrator.js'
import { eventAddendum } from '../adapter/minecraft/prompts.js'

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

function makeAdapter() {
  const ACTIONS = ['follow', 'unfollow', 'goTo', 'gather', 'dig']
  const captured = { signal: null, executed: [] }
  const adapter = {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ player: z.string().optional(), times: z.number().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    // The REAL minecraft addendum — this is what frames sei:death for the prompt.
    eventAddendum: (event, data) => eventAddendum(event, data, 'on-demand'),
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, args, opts) => {
      captured.executed.push(name)
      if (name === 'follow') {
        captured.signal = opts?.signal ?? null
        return new Promise(() => {}) // pending forever → suspends the loop
      }
      return Promise.resolve('done')
    },
  }
  return { adapter, captured }
}

function makeConfig() {
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 30, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-death-test-${process.pid}-${Date.now()}.md`),
      iteration_cap: 30,
    },
  }
}

const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })

describe('sei:death delivery through the orchestrator (260703)', () => {
  it('a fresh sei:death dispatch seeds "You DIED" + drop coords to the model', async () => {
    const { adapter } = makeAdapter()
    const provider = makeProvider([{ text: '', toolUses: [] }]) // react silently, loop ends
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:death', { pos: { x: -46, y: 71, z: -35 } })

    expect(provider.calls.length).toBeGreaterThanOrEqual(1)
    const seed = JSON.stringify(provider.calls[0].messages ?? provider.calls[0])
    expect(seed).toContain('You DIED')
    expect(seed).toContain('-46,71,-35')
    // The event reached the model on a clean, torn-down loop.
    expect(orch.currentLoop).toBeNull()
  })

  // 260708: brain/index.js attaches the last real hit to sei:death (within a
  // 30s window) so the model knows what killed it — Sui died mid-PvP-spar with
  // Marv and said "i have literally no idea what just happened".
  it('a sei:death carrying lastAttack seeds the killer into the model turn', async () => {
    const { adapter } = makeAdapter()
    const provider = makeProvider([{ text: '', toolUses: [] }])
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:death', {
      pos: { x: -22, y: 66, z: -45 },
      lastAttack: { label: 'Marv', kind: 'player', pvp: true, secondsBefore: 2 },
    })

    const seed = JSON.stringify(provider.calls[0].messages ?? provider.calls[0])
    expect(seed).toContain('You DIED')
    expect(seed).toContain('Marv killed you in your PvP spar')
  })

  it('a sei:death arriving mid-loop aborts the action and re-fires at P1 (never dropped)', async () => {
    const { adapter, captured } = makeAdapter()
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'tu1', name: 'follow', input: { player: 'Steve' } }] },
    ])
    const reenqueue = vi.fn()
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue, _anthropicOverride: provider,
    })

    // Open a loop that suspends on a live long-runner.
    await orch.handleDispatch('sei:chat_received', chat('follow me'))
    expect(orch.currentLoop?.inFlight?.name).toBe('follow')
    expect(captured.signal.aborted).toBe(false)

    // The player kills the bot mid-follow.
    await orch.handleDispatch('sei:death', { pos: { x: 10, y: 64, z: 20 } })

    // The action was aborted and the loop torn down (currentLoop cleared).
    expect(captured.signal.aborted).toBe(true)
    expect(orch.currentLoop).toBeNull()

    // Death was re-fired (not dropped) at P1 with the pos payload intact.
    const deathReenq = reenqueue.mock.calls.find((c) => c[0] === 'sei:death')
    expect(deathReenq).toBeTruthy()
    expect(deathReenq[1]).toEqual({ pos: { x: 10, y: 64, z: 20 } })
    expect(deathReenq[2]).toBe(1) // Priority.P1_CHAT
  })
})

// 261019 (quality pass 19): combat_night eval. A turn the dying body was still
// writing finished after the death ("i'm at 7 hp, two skeletons on me", an eat
// call for bread lying on the ground), and hits queued before the death were
// answered after the respawn. noteDeath() (health 0) now blocks every turn
// until the death turn itself starts.
describe('the window between dying and the death turn (pass 19)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('a turn that finishes after the death is discarded: no line, no actions', async () => {
    const { adapter, captured } = makeAdapter()
    let release
    const stale = new Promise((r) => { release = r })
    const provider = makeProvider([
      // Ignores its abort signal, like a response already on the wire.
      () => stale,
      { text: '', toolUses: [] },
    ])
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    const p = orch.handleDispatch('sei:chat_received', chat('you ok?'))
    await flush()
    orch.noteDeath()
    release({ text: '', toolUses: [
      { id: 's1', name: 'say', input: { text: "i'm at 7 hp, two skeletons on me" } },
      { id: 'g1', name: 'goTo', input: { x: 1, y: 2, z: 3 } },
    ] })
    await p
    expect(adapter.chat).not.toHaveBeenCalled()
    expect(captured.executed).not.toContain('goTo')

    // The death turn runs normally.
    await orch.handleDispatch('sei:death', { pos: { x: 5, y: 64, z: 5 }, lost: [{ item: 'bread', n: 3 }] })
    const seed = JSON.stringify(provider.calls.at(-1).messages ?? provider.calls.at(-1))
    expect(seed).toContain('You DIED')
    expect(seed).toContain('bread x3')
  })

  it('a parked LLM call is aborted at the death', async () => {
    const { adapter } = makeAdapter()
    let seenSignal = null
    const provider = makeProvider([
      (args) => new Promise((_, rej) => {
        seenSignal = args.signal
        args.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) }, { once: true })
      }),
      { text: '', toolUses: [] },
    ])
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    const p = orch.handleDispatch('sei:chat_received', chat('watch out'))
    await flush()
    expect(seenSignal?.aborted).toBe(false)
    orch.noteDeath()
    expect(seenSignal.aborted).toBe(true)
    await p
    expect(adapter.chat).not.toHaveBeenCalled()
  })

  it('a hit queued in her previous life is dropped; one from this life is answered', async () => {
    const { adapter } = makeAdapter()
    const provider = makeProvider([{ text: '', toolUses: [] }])
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    const oldLife = orch.life
    orch.noteDeath()
    await orch.handleDispatch('sei:death', { pos: null, lost: [] })
    const after = provider.calls.length
    await orch.handleDispatch('sei:attacked', { attackerKind: 'mob', attackerLabel: 'zombie', _life: oldLife })
    expect(provider.calls.length).toBe(after)
    await orch.handleDispatch('sei:attacked', { attackerKind: 'mob', attackerLabel: 'zombie', _life: orch.life })
    expect(provider.calls.length).toBeGreaterThan(after)
  })

  it('a player line in the window is held and re-sent after the death turn', async () => {
    const { adapter } = makeAdapter()
    const provider = makeProvider([{ text: '', toolUses: [] }])
    const reenqueue = vi.fn()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue, _anthropicOverride: provider })
    orch.noteDeath()
    const line = chat('noooo sui')
    await orch.handleDispatch('sei:chat_received', line)
    expect(provider.calls.length).toBe(0)
    expect(reenqueue).not.toHaveBeenCalled()
    await orch.handleDispatch('sei:death', { pos: null, lost: [] })
    expect(reenqueue).toHaveBeenCalledWith('sei:chat_received', line, 1)
  })

  // 261020 (review of pass 19): the turn discarded at the death must not take
  // the player's line with it.
  it('the line a discarded turn was answering is re-sent after the death turn', async () => {
    const { adapter } = makeAdapter()
    const provider = makeProvider([
      (args) => new Promise((_, rej) => {
        args.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) }, { once: true })
      }),
      { text: '', toolUses: [] },
    ])
    const reenqueue = vi.fn()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue, _anthropicOverride: provider })
    const line = chat('watch out')
    const p = orch.handleDispatch('sei:chat_received', line)
    await flush()
    orch.noteDeath()
    await p
    expect(orch.currentLoop).toBeNull()
    expect(reenqueue.mock.calls.filter((c) => c[0] === 'sei:chat_received')).toHaveLength(0)
    await orch.handleDispatch('sei:death', { pos: null, lost: [] })
    const resent = reenqueue.mock.calls.filter((c) => c[0] === 'sei:chat_received')
    expect(resent).toHaveLength(1)
    expect(resent[0][1]).toBe(line)
    expect(resent[0][2]).toBe(1)
  })

  it('a line delivered mid-action whose reply was being written is re-sent after the death turn', async () => {
    const { adapter } = makeAdapter()
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'tu1', name: 'follow', input: { player: 'Steve' } }] },
      (args) => new Promise((_, rej) => {
        args.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) }, { once: true })
      }),
      { text: '', toolUses: [] },
    ])
    const reenqueue = vi.fn()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('follow me'))
    expect(orch.currentLoop?.inFlight?.name).toBe('follow')
    const line = chat('grab the bread')
    const p = orch.handleDispatch('sei:chat_received', line)
    await flush()
    expect(provider.calls.length).toBe(2)
    orch.noteDeath()
    await p
    // The death lands with the follow loop still open: it is torn down and
    // the death re-fired; the held line must wait for that re-fired turn.
    await orch.handleDispatch('sei:death', { pos: null, lost: [] })
    expect(orch.currentLoop).toBeNull()
    expect(reenqueue.mock.calls.filter((c) => c[0] === 'sei:chat_received')).toHaveLength(0)
    await orch.handleDispatch('sei:death', { pos: null, lost: [] })
    const resent = reenqueue.mock.calls.filter((c) => c[0] === 'sei:chat_received')
    expect(resent).toHaveLength(1)
    expect(resent[0][1]).toBe(line)
  })

  it('a line that lands mid-action in the window is held, not folded into the dying loop', async () => {
    const { adapter } = makeAdapter()
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'tu1', name: 'follow', input: { player: 'Steve' } }] },
      { text: '', toolUses: [] },
    ])
    const reenqueue = vi.fn()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('follow me'))
    expect(orch.currentLoop?.inFlight?.name).toBe('follow')
    orch.noteDeath()
    const line = chat('noooo sui')
    await orch.handleDispatch('sei:chat_received', line)
    expect(provider.calls.length).toBe(1)
    await orch.handleDispatch('sei:death', { pos: null, lost: [] })
    expect(reenqueue.mock.calls.filter((c) => c[0] === 'sei:chat_received')).toHaveLength(0)
    expect(reenqueue.mock.calls.filter((c) => c[0] === 'sei:death')).toHaveLength(1)
    await orch.handleDispatch('sei:death', { pos: null, lost: [] })
    const resent = reenqueue.mock.calls.filter((c) => c[0] === 'sei:chat_received')
    expect(resent).toHaveLength(1)
    expect(resent[0][1]).toBe(line)
  })

  it('an idle tick in the window opens no turn', async () => {
    const { adapter } = makeAdapter()
    const provider = makeProvider([{ text: '', toolUses: [] }])
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    orch.noteDeath()
    await orch.handleDispatch('sei:idle', { quietMs: 60_000 })
    expect(provider.calls.length).toBe(0)
  })

  it('the death hold outlasts its 10 s backstop while the adapter is still respawning (261120)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const { adapter } = makeAdapter()
      const provider = makeProvider([{ text: '', toolUses: [] }])
      const reenqueue = vi.fn()
      const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue, _anthropicOverride: provider })
      let respawning = true
      orch.noteDeath({ stillDying: () => respawning })
      const line = chat('sui??')
      await orch.handleDispatch('sei:chat_received', line)
      expect(provider.calls.length).toBe(0)
      // Past the plain 10 s backstop: still held while the respawn runs.
      vi.advanceTimersByTime(15_000)
      expect(reenqueue.mock.calls.filter((c) => c[0] === 'sei:chat_received')).toHaveLength(0)
      // The respawn stalls (no death turn ever comes): released once it stops.
      respawning = false
      vi.advanceTimersByTime(1_000)
      const resent = reenqueue.mock.calls.filter((c) => c[0] === 'sei:chat_received')
      expect(resent).toHaveLength(1)
      expect(resent[0][1]).toBe(line)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the extended death hold never passes its 30 s ceiling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const { adapter } = makeAdapter()
      const provider = makeProvider([{ text: '', toolUses: [] }])
      const reenqueue = vi.fn()
      const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue, _anthropicOverride: provider })
      orch.noteDeath({ stillDying: () => true })
      await orch.handleDispatch('sei:chat_received', chat('hello?'))
      vi.advanceTimersByTime(29_000)
      expect(reenqueue.mock.calls.filter((c) => c[0] === 'sei:chat_received')).toHaveLength(0)
      vi.advanceTimersByTime(1_500)
      expect(reenqueue.mock.calls.filter((c) => c[0] === 'sei:chat_received')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
