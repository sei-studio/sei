// src/bot/brain/orchestrator.idleVision.test.js
//
// Looking (vision) mode coverage. These tests drive a REAL orchestrator with a
// scripted LLM provider and a mock adapter exposing the renderIdleFrame seam,
// and assert the mode semantics the orchestrator must hold:
//   1. continuous → an automatic view rides the FIRST turn of a session
//      (counter seeded "due" — the first-join orienting frame), then every
//      _PASSIVE_FRAME_INTERVAL_TURNS turns, on the STANDARD LLM path (D-09:
//      automatic views are never routed to /vision/v1/messages, even in cloud).
//   2. off → no pictures, ever, and the look tool is not offered.
//   3. on-demand → the look tool IS offered, but NO automatic view is ever fed
//      (even at the most aggressive cadence); continuous → tool offered AND the
//      automatic view flows.
//   4. {skip:true} (D-02 pose-dedupe) / degrade string → no image attached;
//      the turn still runs. Degrade does NOT reset the cadence (retry next
//      turn); skip does.
//   5. Image retention: a newer frame demotes the older one — at most ONE
//      image block in any payload.
//
// The automatic-view cadence is a fixed production constant (5 turns); these
// tests vary it through the _setPassiveFrameIntervalForTests hook, which exists
// only for the suite (there is no user-facing cadence control).

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import {
  createOrchestrator,
  _setTickIntervalForTests,
  _setPassiveFrameIntervalForTests,
} from './orchestrator.js'

const B64 = 'SURMRUZSQU1F' // recognizable frame base64 token

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

// Mock adapter wiring the automatic-view seam. `idleFrame` is what
// renderIdleFrame resolves to (SUCCESS | {skip:true} | degrade string), or a
// function for per-call results.
function makeAdapter({ idleFrame }) {
  const captured = { rendered: 0 }
  const adapter = {
    listActions: () => ['goTo', 'look'],
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
    renderIdleFrame: () => {
      captured.rendered += 1
      return Promise.resolve(typeof idleFrame === 'function' ? idleFrame(captured.rendered) : idleFrame)
    },
  }
  return { adapter, captured }
}

function makeConfig({ cloud = false, mode = 'continuous' } = {}) {
  const cfg = {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 30, debounce_ms: 0, max_hops: 5 },
    vision: { mode, resolution_px: 256, image_quality: 0.4 },
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

const countImages = (messages) => JSON.stringify(messages).split('"type":"image"').length - 1

describe('Looking (vision) modes', () => {
  // Reset the cadence to the production default before each test so a test that
  // tightens it (interval 1 / 3) never leaks into the next.
  beforeEach(() => _setPassiveFrameIntervalForTests(5))

  it('continuous: the FIRST turn of a session carries a frame, on the standard path even in cloud mode', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, captured } = makeAdapter({ idleFrame: SUCCESS })
    const provider = makeProvider([{ text: 'i see a forest', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ cloud: true, mode: 'continuous' }), provider })

    await runTurn('sei:idle', {})

    expect(captured.rendered).toBe(1)
    expect(provider.calls.length).toBe(1)
    const flat = JSON.stringify(provider.calls[0].messages)
    expect(flat).toContain('"type":"image"')
    expect(flat).toContain(B64)
    // D-09 (the load-bearing assertion): automatic views use the STANDARD path —
    // never routed to /vision/v1/messages, even though cloudMode is set.
    expect(provider.calls[0].path).toBeUndefined()
  })

  it('continuous: after the first frame, the next frame waits the fixed cadence', async () => {
    _setTickIntervalForTests(10_000_000)
    _setPassiveFrameIntervalForTests(3)
    const { adapter, captured } = makeAdapter({ idleFrame: SUCCESS })
    const provider = makeProvider([{ text: 'quiet', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ mode: 'continuous' }), provider })

    // Turn 1: frame (counter seeded due). Turns 2-3: no frame. Turn 4: frame.
    await runTurn('sei:idle', {})
    await runTurn('sei:idle', {})
    await runTurn('sei:idle', {})
    await runTurn('sei:idle', {})

    expect(captured.rendered).toBe(2)
    expect(countImages(provider.calls[0].messages)).toBe(1)
    expect(countImages(provider.calls[1].messages)).toBe(0)
    expect(countImages(provider.calls[2].messages)).toBe(0)
    expect(countImages(provider.calls[3].messages)).toBe(1)
  })

  it('off: never renders and never offers the look tool', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, captured } = makeAdapter({ idleFrame: SUCCESS })
    const provider = makeProvider([{ text: 'darkness', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ mode: 'off' }), provider })

    await runTurn('sei:idle', {})

    expect(captured.rendered).toBe(0)
    expect(countImages(provider.calls[0].messages)).toBe(0)
    expect(provider.calls[0].tools.map((t) => t.name)).not.toContain('look')
  })

  it('on-demand: offers the look tool but never feeds an automatic view', async () => {
    _setTickIntervalForTests(10_000_000)
    // Even at the most aggressive cadence, on-demand must NOT stream a view —
    // the model only ever sees what it explicitly asks for via look()/explore().
    _setPassiveFrameIntervalForTests(1)
    const { adapter, captured } = makeAdapter({ idleFrame: SUCCESS })
    const provider = makeProvider([{ text: 'hm', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ mode: 'on-demand' }), provider })

    await runTurn('sei:idle', {})
    await runTurn('sei:idle', {})

    expect(captured.rendered).toBe(0)
    expect(countImages(provider.calls[0].messages)).toBe(0)
    expect(countImages(provider.calls[1].messages)).toBe(0)
    expect(provider.calls[0].tools.map((t) => t.name)).toContain('look')
  })

  it('continuous: offers the look tool AND feeds an automatic view', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter } = makeAdapter({ idleFrame: SUCCESS })
    const provider = makeProvider([{ text: 'hm', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ mode: 'continuous' }), provider })

    await runTurn('sei:idle', {})

    const names = provider.calls[0].tools.map((t) => t.name)
    expect(names).toContain('look')
    expect(countImages(provider.calls[0].messages)).toBe(1)
  })

  it('non-VLM provider: no renders and no look tool regardless of mode', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, captured } = makeAdapter({ idleFrame: SUCCESS })
    const provider = makeProvider([{ text: 'blind', toolUses: [] }], { vision: false })
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ mode: 'continuous' }), provider })

    await runTurn('sei:idle', {})

    expect(captured.rendered).toBe(0)
    expect(countImages(provider.calls[0].messages)).toBe(0)
    expect(provider.calls[0].tools.map((t) => t.name)).not.toContain('look')
  })

  it('{skip:true} dedupe: render attempted, no image attached, cadence resets', async () => {
    _setTickIntervalForTests(10_000_000)
    _setPassiveFrameIntervalForTests(3)
    const { adapter, captured } = makeAdapter({ idleFrame: { skip: true } })
    const provider = makeProvider([{ text: 'same as before', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ mode: 'continuous' }), provider })

    await runTurn('sei:idle', {})
    await runTurn('sei:idle', {}) // counter reset by skip → not due yet

    expect(captured.rendered).toBe(1)
    expect(countImages(provider.calls[0].messages)).toBe(0)
    expect(countImages(provider.calls[1].messages)).toBe(0)
  })

  it('degrade string: no image, and the cadence does NOT reset (retries next turn)', async () => {
    _setTickIntervalForTests(10_000_000)
    // First render degrades (world loading), second succeeds.
    const { adapter, captured } = makeAdapter({
      idleFrame: (n) => (n === 1 ? "I can't see clearly right now" : SUCCESS),
    })
    const provider = makeProvider([{ text: 'loading...', toolUses: [] }])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ mode: 'continuous' }), provider })

    await runTurn('sei:idle', {})
    await runTurn('sei:idle', {})

    expect(captured.rendered).toBe(2) // retried immediately on the next turn
    expect(countImages(provider.calls[0].messages)).toBe(0)
    expect(countImages(provider.calls[1].messages)).toBe(1)
  })

  it('image retention: a newer frame demotes the older one — at most ONE image per payload', async () => {
    _setTickIntervalForTests(10_000_000)
    // cadence 1 → a frame on EVERY turn. The tool call keeps the SAME loop alive
    // across two LLM calls, so without the demotion cap the second call's
    // history would carry BOTH frames.
    _setPassiveFrameIntervalForTests(1)
    const { adapter } = makeAdapter({ idleFrame: SUCCESS })
    const provider = makeProvider([
      { text: 'on it', toolUses: [{ id: 't1', name: 'goTo', input: {} }] },
      { text: 'arrived', toolUses: [] },
    ])
    const { runTurn } = makeOrch({ adapter, config: makeConfig({ mode: 'continuous' }), provider })

    await runTurn('sei:idle', {})

    expect(provider.calls.length).toBe(2)
    expect(countImages(provider.calls[0].messages)).toBe(1)
    // Second call (same loop): exactly one LIVE image — the older frame is
    // demoted to its text placeholder, not re-sent as base64.
    expect(countImages(provider.calls[1].messages)).toBe(1)
    expect(JSON.stringify(provider.calls[1].messages)).toContain('a picture was shown here on an earlier turn')
  })
})
