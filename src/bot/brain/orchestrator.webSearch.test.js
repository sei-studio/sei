// src/bot/brain/orchestrator.webSearch.test.js
//
// 260909: search() / visit() in the game brain. Pins the ONE property the
// feature rests on: a web tool is inline (its tool_result fills synchronously)
// but not a PERSONALITY_NAME, so runIterations re-calls the model with the
// result and keeps going until the model stops calling tools.
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
  const ACTIONS = ['follow', 'unfollow', 'goTo', 'gather']
  const adapter = {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: () => Promise.resolve('done'),
  }
  return adapter
}

function makeConfig() {
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 30, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-orch-web-test-${process.pid}-${Date.now()}.md`),
      iteration_cap: 30,
    },
    web: { enabled: true, provider: 'auto', api_key: '', max_results: 5, page_chars: 2400, max_calls_per_loop: 6 },
  }
}

function makeWebSession() {
  const runs = []
  let turns = 0
  return {
    runs,
    get turns() { return turns },
    tools: [
      { name: 'search', description: 'search', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'visit', description: 'visit', input_schema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } },
    ],
    beginTurn() { turns += 1 },
    lastProvider: 'fake',
    async runTool(name, input, { signal } = {}) {
      runs.push({ name, input, hasSignal: !!signal })
      if (name === 'search') return { content: `results for "${input.query}":\na. Netherite Armor (minecraft.wiki) - strongest armor`, is_error: false }
      return { content: `[${input.ref}] minecraft.wiki - Netherite Armor\nNetherite armor is made at a smithing table.`, is_error: false }
    },
  }
}

const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('search() / visit() loop in the game brain (260909)', () => {
  it('feeds each result back as a tool_result and re-calls the model until it stops', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: 'let me check', toolUses: [{ id: 't1', name: 'search', input: { query: 'netherite armor' } }] },
      { text: 'reading', toolUses: [{ id: 't2', name: 'visit', input: { ref: 'a' } }] },
      { text: 'got it', toolUses: [{ id: 't3', name: 'say', input: { text: 'smithing table, diamond gear plus an ingot' } }] },
    ])
    const web = makeWebSession()
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
      _webSessionOverride: web,
    })

    await orch.handleDispatch('sei:chat_received', chat('how do i make netherite armor'))

    // Three model calls: search -> visit -> say (say alone ends the loop).
    expect(provider.calls.length).toBe(3)
    expect(web.runs.map((r) => r.name)).toEqual(['search', 'visit'])
    expect(web.runs.every((r) => r.hasSignal)).toBe(true)
    expect(web.turns).toBe(1) // budget armed once per loop

    // Both tools are offered to the model.
    const toolNames = provider.calls[0].tools.map((t) => t.name)
    expect(toolNames).toContain('search')
    expect(toolNames).toContain('visit')

    // Second call carries the search result as a tool_result for t1;
    // third call carries the visit result for t2.
    const second = JSON.stringify(provider.calls[1].messages)
    expect(second).toContain('"tool_use_id":"t1"')
    expect(second).toContain('results for \\"netherite armor\\"')
    const third = JSON.stringify(provider.calls[2].messages)
    expect(third).toContain('"tool_use_id":"t2"')
    expect(third).toContain('smithing table')

    // The loop ended on the say()-only turn.
    expect(orch.currentLoop === null || orch.currentLoop.isTerminal === true || !orch.currentLoop.inFlight).toBe(true)
  })

  it('a say() beside search() in the same turn is spoken up front and the loop still continues', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: 'checking', toolUses: [
        { id: 's1', name: 'say', input: { text: 'one sec, let me look that up' } },
        { id: 't1', name: 'search', input: { query: 'netherite armor' } },
      ] },
      { text: 'done', toolUses: [{ id: 's2', name: 'say', input: { text: 'smithing table plus an ingot' } }] },
    ])
    const web = makeWebSession()
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
      _webSessionOverride: web,
    })
    await orch.handleDispatch('sei:chat_received', chat('how do i make netherite armor'))
    expect(provider.calls.length).toBe(2)
    expect(web.runs.map((r) => r.name)).toEqual(['search'])
    // The second call carries results for BOTH tool_uses of the first turn.
    const second = JSON.stringify(provider.calls[1].messages)
    expect(second).toContain('"tool_use_id":"s1"')
    expect(second).toContain('"tool_use_id":"t1"')
    expect(second).toContain('results for \\"netherite armor\\"')
  })

  it('an Anthropic provider gets the native server web_search (+ visit), resumes pause_turn, and drops the server blocks from history afterwards', async () => {
    _setTickIntervalForTests(10_000_000)
    const serverBlocks = [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'netherite' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', title: 'Netherite', url: 'https://minecraft.wiki/w/Netherite', encrypted_content: 'x'.repeat(100) }] },
    ]
    const provider = makeProvider([
      { text: 'checking', content: [{ type: 'text', text: 'checking' }, ...serverBlocks], toolUses: [], stopReason: 'pause_turn' },
      // Search done; an inline visit() keeps the loop alive so a THIRD call
      // shows what history looks like after the searched turn ended.
      { text: 'ok', content: [{ type: 'text', text: 'ok' }, ...serverBlocks, { type: 'tool_use', id: 'v1', name: 'visit', input: { ref: 'https://minecraft.wiki/w/Netherite' } }], toolUses: [{ id: 'v1', name: 'visit', input: { ref: 'https://minecraft.wiki/w/Netherite' } }], stopReason: 'end_turn' },
      { text: 'done', toolUses: [{ id: 's1', name: 'say', input: { text: 'smithing table plus an ingot' } }] },
    ])
    provider.capabilities = { vision: true, cached: true, local: false, serverWebSearch: true }
    const web = makeWebSession()
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
      _webSessionOverride: web,
    })
    await orch.handleDispatch('sei:chat_received', chat('how do i make netherite armor'))
    const names = provider.calls[0].tools.map((t) => t.name)
    expect(names).toContain('web_search')
    expect(names).toContain('visit')
    expect(names).not.toContain('search')
    expect(provider.calls[0].tools.find((t) => t.name === 'web_search').type).toBe('web_search_20250305')
    // pause_turn resumed: the second call carries the paused content verbatim.
    expect(provider.calls.length).toBe(3)
    const second = provider.calls[1].messages
    const lastMsg = second[second.length - 1]
    expect(lastMsg.role).toBe('assistant')
    expect(JSON.stringify(lastMsg.content)).toContain('web_search_tool_result')
    // Our client search never ran; visit did.
    expect(web.runs.map((r) => r.name)).toEqual(['visit'])
    // Once the searched turn ENDED (end_turn + visit), its server blocks are
    // dropped from the history the third call sees; the visit tool_use stays.
    const third = provider.calls[2].messages
    const visitTurn = third.find((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('"visit"'))
    expect(visitTurn).toBeTruthy()
    expect(JSON.stringify(visitTurn.content)).not.toContain('web_search_tool_result')
  })

  it('withholds the tools and answers with an error when web access is disabled', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: 'hm', toolUses: [{ id: 't1', name: 'search', input: { query: 'x' } }] },
      { text: 'ok', toolUses: [] },
    ])
    const cfg = makeConfig()
    cfg.web.enabled = false
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: cfg,
      reenqueue: () => {},
      _anthropicOverride: provider,
    })
    await orch.handleDispatch('sei:chat_received', chat('look it up'))
    const toolNames = provider.calls[0].tools.map((t) => t.name)
    expect(toolNames).not.toContain('search')
    // The model called it anyway: it is answered, not crashed on.
    const second = JSON.stringify(provider.calls[1].messages)
    expect(second).toContain('web access is off')
  })
})
