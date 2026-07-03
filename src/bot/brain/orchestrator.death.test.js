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
