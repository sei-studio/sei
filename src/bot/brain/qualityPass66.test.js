// 261127: MC quality pass 66. A stay she promised, or the player asked for,
// holds on a quiet tick: the idle tick says so right after the unfinished
// player-request check, and the teammate coordination sentence only rides
// when AI teammates are in the world (it paid for the new sentence).

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { EVENT_GUIDANCE, IDLE_TEAM_TEXT } from './promptLibrary.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

afterEach(() => { vi.restoreAllMocks() })

const STAY = 'If they asked you to stay close or you told them you would stay with them, do only what you can do right next to them, and do not start a gather, dig or walk that takes you away. That ends as soon as they tell you to go, or when it is day with no mobs near them.'

describe('idle tick text', () => {
  const idle = (data) => EVENT_GUIDANCE['sei:idle'](data)

  it('holds a stay after the unfinished-request check and before PROACTIVENESS', () => {
    const text = idle({ quietMs: 27_000 })
    expect(text).toContain(STAY)
    expect(text.indexOf('not finished yet')).toBeLessThan(text.indexOf(STAY))
    expect(text.indexOf(STAY)).toBeLessThan(text.indexOf('PROACTIVENESS'))
    expect(STAY).not.toMatch(/[–—]/)
  })

  it('keeps the teammate sentence unless the caller says there are no teammates', () => {
    expect(idle({ quietMs: 6000 })).toContain(IDLE_TEAM_TEXT.trim())
    expect(idle({ quietMs: 6000, teammates: true })).toContain(IDLE_TEAM_TEXT.trim())
    const solo = idle({ quietMs: 6000, teammates: false })
    expect(solo).not.toContain('coordination beat')
    expect(solo).toContain('make the block an invite. Do not narrate')
    expect(solo).not.toContain('{team}')
  })

  it('costs no more text on solo play than before the stay sentence', () => {
    const solo = idle({ quietMs: 6000, teammates: false })
    const team = idle({ quietMs: 6000, teammates: true })
    expect(team.length - solo.length).toBe(IDLE_TEAM_TEXT.length)
    expect(IDLE_TEAM_TEXT.length).toBeGreaterThan(STAY.length)
  })
})

// --- orchestrator wiring ---------------------------------------------------

function makeProvider() {
  const calls = []
  return {
    calls,
    buildCachedSystem: (blocks) => blocks,
    setAuthToken() {},
    setBackend() {},
    async call(args) {
      calls.push(JSON.parse(JSON.stringify({ messages: args.messages ?? [] })))
      return { text: '', toolUses: [{ id: 'e1', name: 'end_loop', input: {} }] }
    },
  }
}

let seq = 0
function setup() {
  _setTickIntervalForTests(10_000_000)
  const seen = []
  const adapter = {
    listActions: () => ['gather'],
    getActionSchema: () => z.object({ name: z.string().optional() }),
    getActionDescription: (a) => `do ${a}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: (event, data) => { seen.push({ event, data }); return event === 'sei:idle' ? EVENT_GUIDANCE['sei:idle'](data) : '' },
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: async (name) => `${name} ok`,
  }
  const tag = `${process.pid}-${Date.now()}-${seq++}`
  const provider = makeProvider()
  const orch = createOrchestrator({
    adapter,
    config: {
      player_username: 'Steve',
      persona: { name: 'Sei', expanded: 'You are a sharp little companion.', proactiveness: 2 },
      anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
      llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
      memory: {
        memory_md_path: path.join(os.tmpdir(), `sei-p66-mem-${tag}.md`),
        heartbeat_md_path: path.join(os.tmpdir(), `sei-p66-hb-${tag}.md`),
        iteration_cap: 30,
      },
      web: { enabled: false },
    },
    sessionState: { playerData: () => ({}), onLoopTerminal: async () => {} },
    playerStore: { formatPlayerSeedBlock: () => 'PLAYER' },
    reenqueue: () => {},
    _anthropicOverride: provider,
  })
  return { orch, provider, seen }
}

describe('orchestrator: idle tick teammate flag', () => {
  it('solo: the idle addendum gets teammates false, the Data line keeps the event data', async () => {
    const { orch, provider, seen } = setup()
    await orch.handleDispatch('sei:idle', { quietMs: 27_000 })
    const idleCall = seen.find((s) => s.event === 'sei:idle')
    expect(idleCall.data).toEqual({ quietMs: 27_000, teammates: false })
    const sent = JSON.stringify(provider.calls[0].messages)
    expect(sent).toContain('Data: {\\"quietMs\\":27000}')
    expect(sent).not.toContain('coordination beat')
    expect(sent).toContain('do only what you can do right next to them')
  })

  it('with a teammate in the world the sentence is back', async () => {
    const { orch, provider } = setup()
    orch.setCompanions(['Lyra'])
    await orch.handleDispatch('sei:idle', { quietMs: 27_000 })
    expect(JSON.stringify(provider.calls[0].messages)).toContain('coordination beat')
  })
})
