// src/bot/brain/orchestrator.visualize.test.js
//
// 15-06 coverage — wiring the rendered frame back to the LLM (VIS-02) + routing
// the post-explicit-visualize turn through the proxy vision-cap path (VIS-07/D-09).
//
// These tests drive a REAL orchestrator with a scripted LLM provider + a mock
// adapter whose `visualize` action returns the exact 15-04 contract shape. They
// assert the three audit hazards are resolved end-to-end:
//   H1 — visualize settles via handleActionComplete (the short-lived path).
//   H2 — the structured { text, image } result NEVER leaks base64 into the
//        tool_result content, into lastActionResult (snapshot last_action_result),
//        or into conversation history; the image rides a FRESH user turn instead.
//   H3 — exactly the ONE post-visualize turn routes via /vision/v1/messages in
//        cloud mode; BYOK/local turns do NOT; idle never arms the flag.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { VISION_MESSAGES_PATH } from './anthropicClient.js'

const B64 = 'QUJDREVGRw==' // a small recognizable base64 token

// Scripted provider. `capabilities.vision: true` so combinedToolsFor offers
// `visualize`. Records every call(args) for path / message inspection.
function makeProvider(script, { vision = true } = {}) {
  let i = 0
  const calls = []
  return {
    calls,
    capabilities: { vision, cached: false, local: false },
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

// Adapter exposing `visualize` (+ a long-runner `follow`). `visualize` returns
// the EXACT 15-04 success contract: { text, image:{ mediaType, dataBase64 } }.
function makeAdapter(visualizeResult) {
  const ACTIONS = ['visualize', 'follow', 'goTo']
  const captured = { executed: [] }
  const adapter = {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({}),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({
      // Echo last_action_result into the snapshot so a leak would be visible.
      next: ({ lastActionResult } = {}) =>
        `SNAPSHOT last_action_result=${JSON.stringify(lastActionResult ?? null)}`,
    }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, args, opts) => {
      captured.executed.push(name)
      if (name === 'visualize') return Promise.resolve(visualizeResult)
      if (name === 'follow') return new Promise(() => {})
      return Promise.resolve('done')
    },
  }
  return { adapter, captured }
}

function makeConfig({ cloud = false } = {}) {
  const cfg = {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 30, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-vis-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
    },
  }
  // cloudMode is set ONLY in cloud-proxy mode (anthropicClient.buildSdkOptions).
  if (cloud) cfg.anthropic.cloudMode = { baseURL: 'https://api.sei.gg', authToken: 'jwt' }
  return cfg
}

const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })

const SUCCESS = { text: 'rendered view attached', image: { mediaType: 'image/jpeg', dataBase64: B64 } }

// Build an orchestrator whose re-enqueued events (e.g. the long-runner settle's
// sei:action_complete) are drained back into handleDispatch — mirroring the
// real brain's FSM priority queue. `runTurn` dispatches one event and drives
// the loop to quiescence (settle -> action_complete -> next personality turn).
function makeOrch({ adapter, config, provider }) {
  let orch
  const drain = []
  const reenqueue = (ev, d) => { drain.push([ev, d]) }
  orch = createOrchestrator({ adapter, config, reenqueue, _anthropicOverride: provider })
  async function runTurn(event, data) {
    await orch.handleDispatch(event, data)
    // Bounded drain: only re-dispatch the long-runner settle (sei:action_complete);
    // the real FSM routes that back into the orchestrator. Lifecycle events like
    // sei:loop_terminal are NOT re-dispatched here (they tear down, they don't
    // open a new loop), so we drop everything else.
    let guard = 0
    while (drain.length && guard++ < 20) {
      const [ev, d] = drain.shift()
      if (ev === 'sei:action_complete') await orch.handleDispatch(ev, d)
    }
  }
  return { orch, runTurn }
}

describe('15-06 explicit visualize — frame delivery + vision-path routing', () => {
  it('attaches the frame as a FRESH user image turn and routes the post-visualize turn to /vision (cloud)', async () => {
    _setTickIntervalForTests(10_000_000) // park the 10s auto-tick
    const { adapter, captured } = makeAdapter(SUCCESS)
    const provider = makeProvider([
      // Call 1 (fresh loop): the model invokes `visualize`.
      { text: '', toolUses: [{ id: 'vu1', name: 'visualize', input: {} }] },
      // Call 2 (post-visualize turn): text-only reply → loop terminates.
      { text: 'i see a forest', toolUses: [] },
    ])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ cloud: true }), provider })

    await runTurn('sei:chat_received', chat('look around'))

    // H1: visualize executed, and the second (post-visualize) personality turn fired.
    expect(captured.executed).toContain('visualize')
    expect(provider.calls.length).toBe(2)

    // H3: ONLY the post-visualize turn (call 2) carries the vision path.
    expect(provider.calls[0].path).toBeUndefined()
    expect(provider.calls[1].path).toBe(VISION_MESSAGES_PATH)
    expect(VISION_MESSAGES_PATH).toBe('/vision/v1/messages')

    // H2 + VIS-02: the post-visualize payload carries a provider-neutral image
    // block on a FRESH user turn (NOT inside a tool_result).
    const msgs = provider.calls[1].messages
    const flat = JSON.stringify(msgs)
    expect(flat).toContain('"type":"image"')
    expect(flat).toContain(B64) // the base64 IS present — but only in the image block

    // Locate the image block and assert it lives on a user turn, not a tool_result.
    let imageOnUserTurn = false
    let base64InToolResult = false
    for (const m of msgs) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue
      for (const blk of m.content) {
        if (blk?.type === 'image') {
          imageOnUserTurn = true
          expect(blk.source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: B64 })
        }
        if (blk?.type === 'tool_result') {
          const c = typeof blk.content === 'string' ? blk.content : JSON.stringify(blk.content)
          // The visualize tool_result content is the SHORT text, not base64.
          expect(c).toBe('rendered view attached')
          if (c.includes(B64)) base64InToolResult = true
        }
      }
    }
    expect(imageOnUserTurn).toBe(true)
    expect(base64InToolResult).toBe(false)

    // H2: the snapshot's last_action_result line carries the SHORT text, never
    // the raw { text, image } object (no base64 in the snapshot). The snapshot
    // composer in this harness echoes lastActionResult; assert it is the short
    // string (JSON-escaped quotes inside the flattened payload).
    expect(flat).toContain('last_action_result=\\"rendered view attached\\"')
    expect(flat).not.toContain(`last_action_result=\\"${B64}`)
    // The ONLY place base64 appears is the image block's `data` — never a
    // snapshot line or a tool_result. (Count: exactly one occurrence.)
    const occurrences = flat.split(B64).length - 1
    expect(occurrences).toBe(1)
  })

  it('does NOT route to /vision in BYOK/local mode (no cloudMode) — D-11 uncapped', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter } = makeAdapter(SUCCESS)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'vu1', name: 'visualize', input: {} }] },
      { text: 'nice view', toolUses: [] },
    ])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ cloud: false }), provider }) // BYOK/local — no cloudMode

    await runTurn('sei:chat_received', chat('look around'))

    expect(provider.calls.length).toBe(2)
    // The image is STILL attached (VIS-02 works for BYOK too)...
    expect(JSON.stringify(provider.calls[1].messages)).toContain('"type":"image"')
    // ...but NO turn routes to /vision (BYOK/local is uncapped).
    expect(provider.calls[0].path).toBeUndefined()
    expect(provider.calls[1].path).toBeUndefined()
  })

  it('degrade STRING attaches no image and arms no vision flag (VIS-08)', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter } = makeAdapter("I can't see clearly right now")
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'vu1', name: 'visualize', input: {} }] },
      { text: 'hmm, hard to see', toolUses: [] },
    ])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ cloud: true }), provider })

    await runTurn('sei:chat_received', chat('look around'))

    expect(provider.calls.length).toBe(2)
    const flat = JSON.stringify(provider.calls[1].messages)
    // No image block, no base64.
    expect(flat).not.toContain('"type":"image"')
    // The degrade string rides the tool_result as plain text.
    expect(flat).toContain("I can't see clearly right now")
    // No vision routing on a degrade (no successful render to meter).
    expect(provider.calls[1].path).toBeUndefined()
  })

  it('vision flag is one-shot: a SECOND non-visualize turn reverts to default path', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter } = makeAdapter(SUCCESS)
    // Call 1: visualize. Call 2 (post-visualize, /vision): emit a goTo so the
    // loop drives a THIRD turn. Call 3 must be back on the default path.
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'vu1', name: 'visualize', input: {} }] },
      { text: '', toolUses: [{ id: 'gu1', name: 'goTo', input: {} }] },
      { text: 'arrived', toolUses: [] },
    ])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ cloud: true }), provider })

    await runTurn('sei:chat_received', chat('look then move'))

    expect(provider.calls.length).toBe(3)
    expect(provider.calls[0].path).toBeUndefined()        // initial turn
    expect(provider.calls[1].path).toBe(VISION_MESSAGES_PATH) // the ONE post-visualize turn
    expect(provider.calls[2].path).toBeUndefined()        // reverted — flag consumed
  })
})
