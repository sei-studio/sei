// 260611 regression — zombie loop after end_loop with a live long-runner,
// and the 429 rate-limit redrive.
//
// Playlog 25770cd6-…-2026-06-11T20-29-34: the model answered a player chat
// with end_loop while `follow` was in flight. R3 set only `loop.isTerminal`;
// the still-unsettled in_flight made every continuation tail return
// "suspended", and the eventual settle was dropped by the isTerminal guard —
// so the loop was never torn down. currentLoop stayed set and THREE
// subsequent player messages were swallowed (40s of silence) until the
// player punched the bot (P0 attack teardown).
//
// Same harness pattern as orchestrator.visualize.test.js: real orchestrator,
// scripted provider, mock adapter whose `follow` never settles (matching the
// real follow behavior — a background trail with no natural completion).

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
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
      if (r instanceof Error) throw r
      return r
    },
  }
}

function makeAdapter() {
  const adapter = {
    listActions: () => ['follow', 'goTo'],
    getActionSchema: () => z.object({}),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    // follow mirrors the real behavior: a background trail that never
    // settles on its own (and this mock ignores aborts entirely, the
    // worst case for the teardown race).
    executeAction: (name) => (name === 'follow' ? new Promise(() => {}) : Promise.resolve('done')),
  }
  return adapter
}

function makeConfig() {
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-zombie-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
    },
  }
}

const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })

afterEach(() => {
  vi.useRealTimers()
})

describe('260611 zombie-loop regression', () => {
  it('end_loop while follow is in flight tears the loop down; the next chat gets answered', async () => {
    _setTickIntervalForTests(10_000_000) // park the 10s auto-tick
    const provider = makeProvider([
      // Turn 1 (chat "lets go explore"): start following → loop suspends.
      { text: 'fine.', toolUses: [{ id: 'fu1', name: 'follow', input: { player: 'Steve' } }] },
      // Turn 2 (chat while following, delivered via the action-tick path):
      // the model replies AND ends the loop — the playlog shape.
      { text: 'jungle turned to plains. boring.', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
      // Turn 3 (the chat that used to be swallowed by the zombie).
      { text: 'you called it boring first.', toolUses: [{ id: 'el2', name: 'end_loop', input: {} }] },
    ])
    const reenqueued = []
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: (ev, d) => reenqueued.push([ev, d]),
      _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:chat_received', chat('lets go explore'))
    expect(orch.currentLoop).not.toBeNull() // suspended on follow

    await orch.handleDispatch('sei:chat_received', chat('what do you think so far'))
    // THE fix: end_loop + live in_flight must fully tear down, even though
    // the aborted follow never settles. Pre-fix, currentLoop stayed set here
    // and every later chat was swallowed.
    expect(orch.currentLoop).toBeNull()

    await orch.handleDispatch('sei:chat_received', chat('well u called this place boring'))
    expect(provider.calls.length).toBe(3) // the third chat reached the model
  })

  it('schedules a delayed redrive of a chat the rate limit killed', async () => {
    vi.useFakeTimers()
    _setTickIntervalForTests(10_000_000)
    const rateErr = Object.assign(new Error('429 rate_limited'), {
      status: 429,
      error: { error: 'rate_limited', kind: 'itpm', retry_after_seconds: 15 },
    })
    const provider = makeProvider([rateErr])
    const reenqueued = []
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: (ev, d) => reenqueued.push([ev, d]),
      _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:chat_received', chat('thank you. it is my lifelong work'))
    expect(orch.currentLoop).toBeNull() // loop died on the 429

    // No redrive yet (window not elapsed)…
    const before = reenqueued.filter(([ev]) => ev === 'sei:chat_received').length
    expect(before).toBe(0)
    // …after retry_after (15s) + pad, the original chat is re-enqueued.
    await vi.advanceTimersByTimeAsync(16_000)
    const redriven = reenqueued.filter(([ev]) => ev === 'sei:chat_received')
    expect(redriven.length).toBe(1)
    expect(redriven[0][1].text).toBe('thank you. it is my lifelong work')
  })
})
