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
import { NUDGES, BASELINE_INSTRUCTIONS } from './prompts.js'
import {
  createOrchestrator,
  composeSeedBlocks,
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
    // 260616 (#2): mid-action chat defaults to CONTINUE — answer/stay silent
    // and let the running action carry on; only switch/stop if the message
    // actually requires it. This must be the default for every character.
    expect(t).toMatch(/answer with one short say\(\)|stay silent/i)
    expect(t).toContain('KEEP GOING')
    expect(t).toContain('reply and resume')
    expect(t).toContain('To stop, call unfollow')
    expect(t).toContain('call that action')
    // 260619 say()-leak fix: a player-addressed mid-action turn must STILL call
    // say() even when it also acts / switches / end_loops. The model was leaking
    // the spoken line into its private scratchpad and only calling the action,
    // so the player heard nothing. The action is not the reply.
    expect(t).toContain('the action is not the reply')
    expect(t).toContain('also call say() this turn')
    // The interrupt variant must NOT carry the silent-monitor phrasing.
    expect(t).not.toContain('Nothing needs you')
  })

  it('not-mid-action player variant requires a spoken reply even when also acting', () => {
    // 260619 say()-leak fix: action null + playerLine = a fresh/idle loop that a
    // chat woke (the "where are you come to me" → silent follow case). The reply
    // say() is mandatory and an action never substitutes for it.
    const t = NUDGES.actionTurn({ action: null, stopTool: 'end_loop', playerLine: 'where are you come to me', who: 'Ouen' })
    expect(t).toContain('REPLY with one short say()')
    expect(t).toContain('taking an action never replaces it')
  })

  it('player-message variant carries the movement-intent disambiguation hint', () => {
    // 260615: "wait for me" was being mis-read as "come to me" (Sui pathed to
    // the player + called follow). The interrupt prompt now spells out that
    // "wait" = THEY come to YOU = hold position, not follow.
    const t = NUDGES.actionTurn({
      action: 'dig',
      stopTool: 'end_loop',
      playerLine: 'wait for me',
      who: 'Steve',
    })
    expect(t).toContain('wait for me')
    expect(t).toContain('hold position')
    expect(t).toMatch(/do NOT path toward them|do not follow|not.*follow/i)
    // The "come to them" half is still spelled out so the contrast is explicit.
    expect(t).toContain('follow me')
    // Silent-monitor ticks never carry the interrupt-only intent hint.
    const silent = NUDGES.actionTurn({ action: 'dig', stopTool: 'end_loop', elapsedSec: 5 })
    expect(silent).not.toContain('hold position')
  })

  it('silent-monitor variant (no playerLine) shows elapsed + empty-text default', () => {
    const t = NUDGES.actionTurn({
      action: 'gather oak_log',
      stopTool: 'end_loop',
      elapsedSec: 12,
    })
    expect(t).toContain('gather oak_log (12s in)')
    // 260616: silence = no say(). The silent-monitor branch frames this as the
    // bot's OWN routine action with the default being NO say() and concrete
    // banned narration, so the model stops reporting each step.
    expect(t).toContain('OWN routine action')
    expect(t).toContain('call NO say()')
    expect(t).toContain('milestone or discovery')
    // 260616 (#4): a silent tick is a CHECK-IN, not an action channel. It must
    // tell the model not to re-issue/swap the running action; the only action
    // allowed is the cancel (stopTool).
    expect(t).toContain('CHECK-IN')
    expect(t).toMatch(/do NOT call another action|do not call another action/i)
    expect(t).toContain('To cancel this action, call end_loop')
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

// ──────────────── anti-assistant-tone hardening (260615) ────────────────

describe('BASELINE_INSTRUCTIONS anti-filler rule', () => {
  it('bans command-acknowledgement filler tokens and offers in-character replacements', () => {
    // Haiku reflexively opens commands with receipt tokens ("got it, let's dig").
    // BASELINE must name the ban and point at the two correct moves.
    expect(BASELINE_INSTRUCTIONS).toContain('NEVER ACKNOWLEDGE A COMMAND WITH FILLER')
    for (const banned of ['got it', 'sure', 'on it', 'understood', 'will do']) {
      expect(BASELINE_INSTRUCTIONS).toContain(`"${banned}"`)
    }
    // The two correct moves: just DO it (don't call say()) or react IN CHARACTER.
    expect(BASELINE_INSTRUCTIONS).toContain("don't call say()")
    expect(BASELINE_INSTRUCTIONS).toMatch(/IN CHARACTER/i)
    // Obeying must not reset the voice to assistant register.
    expect(BASELINE_INSTRUCTIONS).toMatch(/compliant-assistant register/i)
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

// ──────────── daily play limit (daily_dollar 429) — 260617 ────────────

describe('daily play limit (daily_dollar 429)', () => {
  function throwing(status, body) {
    return () => {
      const e = new Error('rate limited')
      e.status = status
      e.error = body
      throw e
    }
  }

  it('halts and signals DAILY_LIMIT_REACHED with the reset window, leaving quietly', async () => {
    const { adapter } = makeAdapter()
    const onTerminalError = vi.fn()
    const provider = makeProvider([
      throwing(429, { error: 'rate_limited', kind: 'daily_dollar', retry_after_seconds: 3600 }),
    ])
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {}, onTerminalError, _anthropicOverride: provider,
    })
    await orch.handleDispatch('sei:chat_received', chat('hi'))
    expect(onTerminalError).toHaveBeenCalledTimes(1)
    expect(onTerminalError.mock.calls[0][0]).toMatchObject({
      error: 'DAILY_LIMIT_REACHED',
      retryAfterSeconds: 3600,
    })
    // Leaves the world QUIETLY — no in-game chat line on the way out.
    expect(adapter.chat).not.toHaveBeenCalled()
  })

  it('does NOT halt on a transient itpm 429 (that path redrives, not terminal)', async () => {
    const { adapter } = makeAdapter()
    const onTerminalError = vi.fn()
    const provider = makeProvider([
      throwing(429, { error: 'rate_limited', kind: 'itpm', retry_after_seconds: 20 }),
    ])
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {}, onTerminalError, _anthropicOverride: provider,
    })
    await orch.handleDispatch('sei:chat_received', chat('hi'))
    expect(onTerminalError).not.toHaveBeenCalled()
  })
})

// ──────────── #2: player message surfaced LAST (highest salience) ────────────

describe('composeSeedBlocks — player_message block (260616 #2)', () => {
  const baseArgs = {
    sessionState: { playerData: () => ({}) },
    playerStore: { formatPlayerSeedBlock: () => 'PLAYER' },
    config: { memory: {} },
    eventText: 'Event: sei:chat_received',
    snapshotText: 'pos: 0,64,0',
  }

  it('appends player_message as the LAST block so it reads after the snapshot', async () => {
    const blocks = await composeSeedBlocks({
      ...baseArgs,
      playerMessageText: 'the player just spoke to you. respond to THIS:\n"shut up :("',
    })
    const last = blocks[blocks.length - 1]
    expect(last.name).toBe('player_message')
    expect(last.text).toContain('shut up :(')
    // It must come AFTER the snapshot — recency is the whole point of #2.
    const names = blocks.map((b) => b.name)
    expect(names.indexOf('player_message')).toBeGreaterThan(names.indexOf('snapshot'))
  })

  it('adds no player_message block on non-chat turns (playerMessageText null)', async () => {
    const blocks = await composeSeedBlocks(baseArgs)
    expect(blocks.some((b) => b.name === 'player_message')).toBe(false)
  })
})

// ──────────────── say() as a real tool (260617) ────────────────
//
// say() was promoted from a parsed text convention (extractSay) to a registered
// inline tool: across two live runs Haiku honored the text-only say() contract
// 0× while calling real tools reliably. These pin the contract the orchestrator
// now enforces — say is offered every turn, emits to chat up front, and a
// say()-only turn is "silence" for loop purposes (it speaks, then the loop ends
// unless a world-acting tool was also called).

describe('say() tool (260617)', () => {
  it('is offered to the model every turn as an inline tool requiring `text`', async () => {
    const { adapter } = makeAdapter()
    const provider = makeProvider([{ text: '', toolUses: [] }])
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider,
    })
    await orch.handleDispatch('sei:chat_received', chat('hi'))
    const say = provider.calls[0].tools.find((t) => t.name === 'say')
    expect(say).toBeTruthy()
    expect(say.input_schema.required).toContain('text')
  })

  it('a say()-only turn speaks, runs NO action, and ENDS the loop (say = silence for loop purposes)', async () => {
    const { adapter, captured } = makeAdapter()
    const provider = makeProvider([
      { text: 'they greeted me — reply', toolUses: [{ id: 'tu_say', name: 'say', input: { text: 'yo whats up' } }] },
    ])
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider,
    })
    await orch.handleDispatch('sei:chat_received', chat('hey'))
    // The say() line reached chat...
    expect(adapter.chat).toHaveBeenCalledWith('yo whats up')
    // ...no world-acting tool ran...
    expect(captured.executed).toEqual([])
    // ...and the loop ENDED rather than suspending. This is the explicit
    // requirement: "if no other action is called, loop ends."
    expect(orch.currentLoop).toBeNull()
  })

  it('emits nothing when the model calls no say() (silence is the default)', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter } = makeAdapter()
    const provider = makeProvider([
      { text: 'just go, nothing to say', toolUses: [{ id: 'tu_go', name: 'goTo', input: { x: 1, y: 64, z: 1 } }] },
    ])
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider,
    })
    await orch.handleDispatch('sei:chat_received', chat('go there'))
    expect(adapter.chat).not.toHaveBeenCalled()
  })

  it('say() alongside an action speaks up front AND runs the action (the action drives the loop)', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, captured } = makeAdapter()
    const provider = makeProvider([
      { text: 'hype + follow', toolUses: [
        { id: 'tu_say', name: 'say', input: { text: 'watch this' } },
        { id: 'tu_follow', name: 'follow', input: { player: 'Steve' } },
      ] },
    ])
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider,
    })
    await orch.handleDispatch('sei:chat_received', chat('follow me'))
    expect(adapter.chat).toHaveBeenCalledWith('watch this')
    expect(captured.executed).toContain('follow')
    // follow suspends the loop — it stays alive, with say already spoken.
    expect(orch.currentLoop).not.toBeNull()
    expect(orch.currentLoop.inFlight?.name).toBe('follow')
  })

  it('say() while an action runs replies WITHOUT aborting the action (R1 keep-alive)', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, captured } = makeAdapter()
    const provider = makeProvider([
      // Call 1: start follow → suspends on the long-runner.
      { text: '', toolUses: [{ id: 'tu1', name: 'follow', input: { player: 'Steve' } }] },
      // Call 2 (a chat lands mid-follow): reply with say() only.
      { text: 'reply, keep following', toolUses: [{ id: 'tu_say', name: 'say', input: { text: 'yeah yeah coming' } }] },
    ])
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider,
    })
    await orch.handleDispatch('sei:chat_received', chat('follow me'))
    expect(orch.currentLoop?.inFlight?.name).toBe('follow')
    expect(captured.signal.aborted).toBe(false)
    // Chat lands while follow is in flight → say() reply, action survives.
    await orch.handleDispatch('sei:chat_received', chat('you coming?'))
    expect(adapter.chat).toHaveBeenCalledWith('yeah yeah coming')
    expect(captured.signal.aborted).toBe(false)                 // follow NOT aborted
    expect(orch.currentLoop?.inFlight?.name).toBe('follow')
  })

  it('caps speech at ONE say() per turn — extra say() calls are ignored, not spammed', async () => {
    const { adapter } = makeAdapter()
    const provider = makeProvider([
      { text: 'two lines', toolUses: [
        { id: 's1', name: 'say', input: { text: 'first line' } },
        { id: 's2', name: 'say', input: { text: 'second line' } },
      ] },
    ])
    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider,
    })
    await orch.handleDispatch('sei:chat_received', chat('hi'))
    expect(adapter.chat).toHaveBeenCalledWith('first line')
    expect(adapter.chat).not.toHaveBeenCalledWith('second line')
    expect(adapter.chat).toHaveBeenCalledTimes(1)
  })
})
