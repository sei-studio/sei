// 261026: quality pass 28. False claims about who made, gave or holds what
// (8 of 17 off lines in the dev scripted convos): "made you a table AND a
// pickaxe", "you still hand me bread", "7 coal and 8 logs" after one give.
//  - The transcript ends on a session-wide hand-over line: what she gave and
//    to whom, what came in without an action of hers, and that everything
//    else she made is still hers.
//  - An action result folds into an earlier one only while nobody spoke in
//    between, so it keeps its place in the transcript.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createHandOverLedger, createSessionEventLog } from './sessionEvents.js'
import { createConvoMemory } from './convoMemory.js'
import { resolveAdapterCaps } from './adapterDefaults.js'
import { createMinecraftAdapter } from '../adapter/minecraft/index.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

afterEach(() => { vi.restoreAllMocks() })

describe('createHandOverLedger', () => {
  it('says nothing was given when nothing was', () => {
    const l = createHandOverLedger()
    const d = l.describe()
    expect(d).toMatch(/^Handed over this session: you have not given anything to anyone\./)
    expect(d).toContain('Everything else you crafted, gathered or picked up went into your own inventory')
    expect(d).toContain('you cannot see what the player carries')
    expect(d).not.toContain('came into your inventory')
  })

  it('totals gives per recipient and item, and lists what came in', () => {
    const l = createHandOverLedger()
    l.gave({ item: 'oak_log', n: 4, to: 'Alex' })
    l.gave({ item: 'oak_log', n: 2, to: 'Alex' })
    l.gave({ item: 'coal', n: 7, to: 'Alex' })
    l.gave({ item: 'bread', n: 1, to: 'Sam' })
    l.received([{ item: 'iron_sword', n: 1 }, { item: 'bread', n: 4 }])
    const d = l.describe()
    expect(d).toContain('you gave Alex 6 oak_log and 7 coal and Sam 1 bread.')
    expect(d).toContain('1 iron_sword and 4 bread came into your inventory without an action of yours')
  })

  it('ignores junk and defaults the recipient', () => {
    const l = createHandOverLedger()
    l.gave(null)
    l.gave({ item: 'coal', n: 0 })
    l.gave({ item: '', n: 2 })
    l.received([{ item: 'bread', n: -1 }, null])
    expect(l.describe()).toMatch(/you have not given anything to anyone\./)
    l.gave({ item: 'coal', n: 3 })
    expect(l.describe()).toContain('you gave the player 3 coal.')
  })
})

describe('session event fold (foldIf)', () => {
  it('folds a repeat only when foldIf allows it', () => {
    let t = 1000
    const log = createSessionEventLog({ now: () => t })
    log.record('gathered 8/8 oak_log', { key: 'g', windowMs: 60_000 })
    t += 20_000
    log.record('gathered 4/4 oak_log', { key: 'g', windowMs: 60_000, foldIf: () => false })
    expect(log.size).toBe(2)
    t += 5_000
    log.record('gathered 2/2 oak_log', { key: 'g', windowMs: 60_000, foldIf: () => true })
    expect(log.size).toBe(2)
    t += 5_000
    log.record('gathered 1/1 oak_log', { key: 'g', windowMs: 60_000, foldIf: () => { throw new Error('x') } })
    expect(log.size).toBe(3)
  })
})

describe('convoMemory hand-over line', () => {
  it('ends the transcript on the hand-over line only when tracking', () => {
    const on = createConvoMemory({ trackHandOvers: true })
    const off = createConvoMemory()
    on.recentChat.pushPlayer('Alex', 'give me some coal')
    off.recentChat.pushPlayer('Alex', 'give me some coal')
    on.recentChat.noteGiven({ item: 'coal', n: 7, to: 'Alex' })
    const block = on.recentChat.formatConversationBlock()
    expect(block.trim().split('\n').pop()).toMatch(/^Handed over this session: you gave player \(Alex\) 7 coal\./)

    off.recentChat.noteGiven({ item: 'coal', n: 7, to: 'Alex' })
    expect(off.recentChat.formatConversationBlock()).not.toContain('Handed over this session')
  })
})

describe('handOverDetail', () => {
  it('defaults to null for an adapter without it', () => {
    expect(resolveAdapterCaps({}).handOverDetail).toBeNull()
  })

  it('parses the Minecraft give success line and nothing else', () => {
    const a = createMinecraftAdapter({ bot: {}, config: {} })
    expect(a.handOverDetail('give', 'gave 6 oak_log to Alex, tossed at their feet; you have 1 oak_log left'))
      .toEqual({ item: 'oak_log', n: 6, to: 'Alex' })
    expect(a.handOverDetail('give', 'no oak_log to give')).toBeNull()
    expect(a.handOverDetail('craft', 'gave 1 x to y, tossed')).toBeNull()
  })
})

// ─── orchestrator ───────────────────────────────────────────────────────

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
  const ACTIONS = ['give', 'craft']
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ item: z.string().optional() }),
    getActionDescription: (a) => `do ${a}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    handOverResult: (name, r) => (name === 'give' ? /^gave \d/.test(String(r ?? '')) : null),
    handOverDetail: (name, r) => {
      if (name !== 'give') return null
      const m = /^gave (\d+) (\S+) to (.+?), tossed/.exec(String(r ?? ''))
      return m ? { item: m[2], n: Number(m[1]), to: m[3] } : null
    },
    executeAction: (name) => Promise.resolve(name === 'give'
      ? 'gave 7 coal to Steve, tossed at their feet; you have 0 coal left'
      : 'crafted 1 wooden_pickaxe'),
  }
}

let seq = 0
function config() {
  const tag = `${process.pid}-${Date.now()}-${seq++}`
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.', proactiveness: 2 },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-p28-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p28-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

const say = (id, text) => ({ id, name: 'say', input: { text } })
const act = (id, name, input = {}) => ({ id, name, input })
const turn = (...toolUses) => ({ text: '', toolUses })
const allText = (call) => JSON.stringify(call.messages ?? [])
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const DRAINED = new Set(['sei:action_complete', 'sei:chat_received', 'sei:action_tick'])
const flush = () => new Promise((r) => setTimeout(r, 5))

describe('orchestrator: the hand-over line', () => {
  it('records a give that went through and leaves crafted items with her', async () => {
    _setTickIntervalForTests(10_000_000)
    const queue = []
    const provider = makeProvider([
      turn(say('s1', 'here'), act('g1', 'give', { item: 'coal' }), act('c1', 'craft', { item: 'wooden_pickaxe' })),
      turn(act('e1', 'end_loop')),
      turn(say('s2', 'np')),
    ])
    const orch = createOrchestrator({
      adapter: makeAdapter(), config: config(),
      sessionState: { playerData: () => ({}), onLoopTerminal: async () => {} },
      playerStore: { formatPlayerSeedBlock: () => 'PLAYER' },
      reenqueue: (event, data) => queue.push({ event, data }),
      _anthropicOverride: provider,
    })
    const drain = async () => {
      for (let guard = 0; queue.length && guard < 20; guard++) {
        const next = queue.shift()
        if (DRAINED.has(next.event)) await orch.handleDispatch(next.event, next.data)
      }
    }
    await orch.handleDispatch('sei:chat_received', line('give me coal'))
    await flush()
    await drain()
    // Nobody had spoken before the first turn, so it has no transcript.
    expect(allText(provider.calls[0])).not.toContain('Handed over this session')
    await orch.handleDispatch('sei:chat_received', line('thanks'))
    await flush()
    await drain()
    const last = allText(provider.calls[provider.calls.length - 1])
    expect(last).toContain('Handed over this session: you gave player (Steve) 7 coal.')
  })
})
