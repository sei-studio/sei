// src/bot/brain/orchestrator.idleVision.test.js
//
// 15-07 coverage — the idle auto-render hook on the existing P3 `sei:idle` tick
// (VIS-04). These tests drive a REAL orchestrator with a scripted LLM provider
// and a mock adapter exposing the two 15-07 adapter seams (shouldAutoRenderIdle,
// renderIdleFrame), and assert the success criteria the orchestrator must hold:
//   1. Gate CLEAR  → the rendered frame attaches to the idle turn via the SAME
//                    15-06 image mechanism, AND idle uses the STANDARD LLM path —
//                    the post-render turn is NOT routed to /vision/v1/messages
//                    even in cloud mode (D-09: idle never hits the per-hour cap).
//   2. Gate CLOSED → no render call, no image, normal idle turn proceeds.
//   3. {skip:true} (D-02 dedupe) / degrade string → no image attached; the idle
//                    turn still runs (silent no-op for the duplicate frame).
//
// The cloud-mode assertion is the load-bearing D-09 proof: 15-06 routes the ONE
// post-EXPLICIT-visualize turn to /vision; an idle render must NOT — confirmed
// here by asserting every idle-turn `path` is undefined under cloudMode.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

const B64 = 'SURMRUZSQU1F' // recognizable idle-frame base64 token

const SUCCESS = { text: 'rendered view attached', image: { mediaType: 'image/jpeg', dataBase64: B64 } }

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

// Mock adapter wiring the 15-07 idle seams. `gateClear` decides shouldAutoRenderIdle;
// `idleFrame` is what renderIdleFrame resolves to (SUCCESS | {skip:true} | degrade).
function makeAdapter({ gateClear, idleFrame }) {
  const captured = { rendered: 0, gateChecks: 0 }
  const adapter = {
    listActions: () => ['goTo'],
    getActionSchema: () => z.object({}),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({
      next: ({ lastActionResult } = {}) =>
        `SNAPSHOT last_action_result=${JSON.stringify(lastActionResult ?? null)}`,
    }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: () => Promise.resolve('done'),
    // ── 15-07 idle seams ──
    shouldAutoRenderIdle: (provider) => {
      captured.gateChecks += 1
      // Mirror the real gate's dependency on the provider handle (VLM check).
      return gateClear && !!provider?.capabilities?.vision
    },
    renderIdleFrame: () => {
      captured.rendered += 1
      return Promise.resolve(idleFrame)
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
    vision: { auto_render: true, resolution_px: 256, image_quality: 0.4 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-idle-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
    },
  }
  if (cloud) cfg.anthropic.cloudMode = { baseURL: 'https://api.sei.gg', authToken: 'jwt' }
  return cfg
}

function makeOrch({ adapter, config, provider }) {
  const drain = []
  const reenqueue = (ev, d) => { drain.push([ev, d]) }
  const orch = createOrchestrator({ adapter, config, reenqueue, _anthropicOverride: provider })
  async function runTurn(event, data) {
    await orch.handleDispatch(event, data)
    let guard = 0
    while (drain.length && guard++ < 20) {
      const [ev, d] = drain.shift()
      if (ev === 'sei:action_complete') await orch.handleDispatch(ev, d)
    }
  }
  return { orch, runTurn }
}

describe('15-07 idle auto-render hook (VIS-04 / D-09)', () => {
  it('gate CLEAR: attaches the idle frame AND stays on the standard path (NOT /vision) even in cloud mode', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, captured } = makeAdapter({ gateClear: true, idleFrame: SUCCESS })
    // ONE idle personality turn (text-only) — the model comments on the frame.
    const provider = makeProvider([{ text: 'i see a forest', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ cloud: true }), provider })

    await runTurn('sei:idle', {})

    // The gate was checked and the frame rendered exactly once.
    expect(captured.gateChecks).toBe(1)
    expect(captured.rendered).toBe(1)
    // One personality turn fired (the idle turn that sees the frame).
    expect(provider.calls.length).toBe(1)

    // VIS-02: the idle frame is attached as a provider-neutral image block on a
    // user turn (the 15-06 mechanism).
    const flat = JSON.stringify(provider.calls[0].messages)
    expect(flat).toContain('"type":"image"')
    expect(flat).toContain(B64)

    // D-09 (the load-bearing assertion): the idle turn uses the STANDARD path —
    // it is NEVER routed to /vision/v1/messages, even though cloudMode is set.
    // (Only the EXPLICIT visualize path arms _pendingVisionTurn.)
    expect(provider.calls[0].path).toBeUndefined()
  })

  it('gate CLOSED: no render, no image, normal idle turn proceeds', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, captured } = makeAdapter({ gateClear: false, idleFrame: SUCCESS })
    const provider = makeProvider([{ text: 'nothing to do', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ cloud: true }), provider })

    await runTurn('sei:idle', {})

    expect(captured.gateChecks).toBe(1)
    expect(captured.rendered).toBe(0) // gate closed → renderIdleFrame never called
    expect(provider.calls.length).toBe(1)
    const flat = JSON.stringify(provider.calls[0].messages)
    expect(flat).not.toContain('"type":"image"')
    expect(provider.calls[0].path).toBeUndefined()
  })

  it('{skip:true} dedupe: silent no-op — frame rendered but NO image attached, idle turn still runs', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, captured } = makeAdapter({ gateClear: true, idleFrame: { skip: true } })
    const provider = makeProvider([{ text: 'same as before', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ cloud: true }), provider })

    await runTurn('sei:idle', {})

    expect(captured.rendered).toBe(1) // render WAS attempted (dedupe decided inside)
    expect(provider.calls.length).toBe(1)
    const flat = JSON.stringify(provider.calls[0].messages)
    // Dedupe → no image, no base64.
    expect(flat).not.toContain('"type":"image"')
    expect(flat).not.toContain(B64)
    // Standard path either way.
    expect(provider.calls[0].path).toBeUndefined()
  })

  it('degrade string: no image attached, idle turn proceeds on the standard path', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter } = makeAdapter({ gateClear: true, idleFrame: "I can't see clearly right now" })
    const provider = makeProvider([{ text: 'cant see well', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ cloud: true }), provider })

    await runTurn('sei:idle', {})

    expect(provider.calls.length).toBe(1)
    const flat = JSON.stringify(provider.calls[0].messages)
    expect(flat).not.toContain('"type":"image"')
    expect(provider.calls[0].path).toBeUndefined()
  })

  it('a NON-idle (chat) turn never invokes the idle gate', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, captured } = makeAdapter({ gateClear: true, idleFrame: SUCCESS })
    const provider = makeProvider([{ text: 'hi', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ cloud: true }), provider })

    await runTurn('sei:chat_received', { text: 'hello', username: 'Steve', playerSpoke: true, ts: Date.now() })

    // The gate is idle-only — a player-chat turn must not auto-render.
    expect(captured.gateChecks).toBe(0)
    expect(captured.rendered).toBe(0)
  })
})
