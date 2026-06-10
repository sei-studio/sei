// src/bot/brain/orchestrator.test.js
//
// 260608-tik coverage:
//   1. NUDGES.actionTurn — the unified "you are mid-action" template (Change 2),
//      exercised in both the silent-monitor and player-message variants.
//   2. Change 1 — a player chat that lands while an action is in flight (loop
//      suspended on a long-runner, no Haiku call parked) must NOT abort the
//      action. It drives a tick-style turn instead; the model is free to reply,
//      switch, or stop. This is the behavioral heart of the change, so it runs
//      against a real orchestrator with a scripted LLM provider + mock adapter.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { NUDGES } from './prompts.js'
import {
  createOrchestrator,
  _setTickIntervalForTests,
} from './orchestrator.js'

// ───────────────────────── Change 2: template ─────────────────────────

describe('NUDGES.actionTurn (260608-tik)', () => {
  it('player-message variant quotes the speaker + words and names the stop tool', () => {
    const t = NUDGES.actionTurn({
      action: 'follow Steve',
      stopTool: 'unfollow',
      playerLine: 'wait here',
      who: 'Steve',
    })
    expect(t).toContain('follow Steve')
    expect(t).toContain('Steve said: "wait here"')
    expect(t).toContain('Reply in one short line, or stay silent')
    expect(t).toContain('To stop, call unfollow')
    expect(t).toContain('just call that action')
    // The interrupt variant must NOT carry the silent-monitor phrasing.
    expect(t).not.toContain('Nothing needs you')
  })

  it('silent-monitor variant (no playerLine) shows elapsed + "stay silent"', () => {
    const t = NUDGES.actionTurn({
      action: 'gather oak_log',
      stopTool: 'end_loop',
      elapsedSec: 12,
    })
    expect(t).toContain('gather oak_log (12s in)')
    expect(t).toContain('Nothing needs you — stay silent unless something changed')
    expect(t).toContain('To stop, call end_loop')
    // No fabricated player quote on a silent tick.
    expect(t).not.toContain('said:')
  })

  it('omits the speaker name when who is absent, falls back when action is null', () => {
    const noWho = NUDGES.actionTurn({ action: 'dig', stopTool: 'end_loop', playerLine: 'hi' })
    expect(noWho).toContain('said: "hi"')
    expect(noWho).not.toContain('undefined')

    const noAction = NUDGES.actionTurn({ action: null, stopTool: 'end_loop', elapsedSec: null })
    expect(noAction).toContain('your action')
    expect(noAction).not.toContain('(null')
  })
})

// ──────────────────── Change 1: no-abort routing ────────────────────

// A scripted LLM provider standing in for the Anthropic client. `call` returns
// the next scripted response and records its arguments so the test can inspect
// the prompt the model actually saw.
function makeProvider(script) {
  let i = 0
  const calls = []
  return {
    calls,
    buildCachedSystem: (blocks /*, tools */) => blocks,
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

// Minimal game adapter. `follow` returns a never-resolving promise so the loop
// suspends on it as a live long-runner; the test captures that action's
// AbortSignal to prove it is never aborted.
function makeAdapter() {
  const ACTIONS = ['follow', 'unfollow', 'goTo', 'gather', 'dig', 'attackEntity']
  const captured = { signal: null, executed: [] }
  const adapter = {
    listActions: () => ACTIONS,
    getActionSchema: () =>
      z.object({ player: z.string().optional(), times: z.number().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
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
      memory_md_path: path.join(os.tmpdir(), `sei-orch-test-${process.pid}-${Date.now()}.md`),
      iteration_cap: 30,
    },
  }
}

const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })

describe('Change 1 — P1 chat during action-in-flight does not abort the action (260608-tik)', () => {
  it('keeps the running action alive and delivers the message as a tick-style turn', async () => {
    _setTickIntervalForTests(10_000_000) // park the 10s auto-tick so it never fires
    const { adapter, captured } = makeAdapter()
    const provider = makeProvider([
      // Call 1 (fresh loop): start following → suspends on the long-runner.
      { text: '', toolUses: [{ id: 'tu1', name: 'follow', input: { player: 'Steve' } }] },
      // Call 2 (the interrupting chat): reply text-only → R1 keep-alive.
      { text: 'staying right here', toolUses: [] },
    ])
    const orch = createOrchestrator({
      adapter,
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
    })

    // Fresh loop opens and suspends on follow.
    await orch.handleDispatch('sei:chat_received', chat('follow me'))
    expect(provider.calls.length).toBe(1)
    expect(orch.currentLoop).not.toBeNull()
    expect(orch.currentLoop.inFlight?.name).toBe('follow')
    expect(captured.signal).toBeTruthy()
    expect(captured.signal.aborted).toBe(false)

    // A second chat lands while follow is in flight.
    await orch.handleDispatch('sei:chat_received', chat('actually wait a sec'))

    // Core assertion: the follow action's signal was NOT aborted.
    expect(captured.signal.aborted).toBe(false)
    // follow was started exactly once (never restarted), still in flight.
    expect(captured.executed.filter((n) => n === 'follow').length).toBe(1)
    expect(orch.currentLoop).not.toBeNull()
    expect(orch.currentLoop.inFlight?.name).toBe('follow')

    // A second Haiku turn fired, carrying the player's words + the right stop
    // tool (unfollow, because the live action is follow) + the in-progress
    // tool_result proving the action was monitored, not aborted.
    expect(provider.calls.length).toBe(2)
    const turn2 = JSON.stringify(provider.calls[1].messages ?? provider.calls[1])
    expect(turn2).toContain('actually wait a sec')
    expect(turn2).toContain('unfollow')
    expect(turn2).toContain('still in progress')
  })
})
