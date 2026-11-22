// 261018: quality pass 16. Claims about her OWN state that contradicted her
// sensors (the largest off category in the pass-15 scripted convos):
//  - "i have zero items" kept after a sword and bread arrived: the arrival
//    was shown on one snapshot only. Items that come in without an action of
//    hers are now a "game:" line in the conversation record.
//  - "i'm still making that furnace" / "still getting you those logs" after
//    she stopped on the player's word: the snapshot's next: line and the
//    heartbeat's "work the next step now" were still in front of her. While
//    the stay note is on, next: is left out and the heartbeat heads say the
//    goals are on hold.
//  - Talking about her own goal as a plan the player knows about: the on-hold
//    own-goal head says the player knows about one only if the conversation
//    shows it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { Vec3 } from 'vec3'
import { describeInventoryGain, createInventoryGainRecorder, createSessionEventLog, ACTION_COALESCE_MS } from './sessionEvents.js'
import { createConvoMemory } from './convoMemory.js'
import { renderHeartbeat, PLAYER_TASKS_HEAD, PLAYER_TASKS_ON_HOLD_HEAD, OWN_GOALS_ON_HOLD_HEAD } from './promptLibrary.js'
import { createSnapshotComposer } from '../adapter/minecraft/observers/snapshot.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

afterEach(() => { vi.restoreAllMocks() })

describe('describeInventoryGain', () => {
  it('names what came in, in plain words', () => {
    expect(describeInventoryGain([{ item: 'iron_sword', n: 1 }, { item: 'bread', n: 4 }])).toBe('1 iron_sword and 4 bread came into your inventory')
    expect(describeInventoryGain([{ item: 'bread', n: 4 }])).toBe('4 bread came into your inventory')
    expect(describeInventoryGain([{ item: 'a', n: 1 }, { item: 'b', n: 2 }, { item: 'c', n: 3 }])).toBe('1 a, 2 b and 3 c came into your inventory')
  })

  it('counts kinds past four and ignores losses and junk', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((item) => ({ item, n: 1 }))
    expect(describeInventoryGain(many)).toBe('1 a, 1 b, 1 c, 1 d and 2 other kinds of item came into your inventory')
    expect(describeInventoryGain([{ item: 'bread', n: -1 }])).toBeNull()
    expect(describeInventoryGain([])).toBeNull()
    expect(describeInventoryGain(null)).toBeNull()
  })
})

describe('createInventoryGainRecorder (review: a busy stretch is one line)', () => {
  it('adds up a run of arrivals with nothing said in between', () => {
    let t = 1_000
    const log = createSessionEventLog({ now: () => t })
    const rec = createInventoryGainRecorder({ record: log.record, spokeBetween: () => false, now: () => t })
    log.record('you used attackEntity: killed zombie (4 hits)')
    for (let i = 0; i < 20; i++) {
      t += 3_000
      rec([{ item: 'dirt', n: 1 }, ...(i % 2 ? [{ item: 'cobblestone', n: 2 }] : [])])
    }
    expect(log.list().map((e) => e.text)).toEqual([
      'you used attackEntity: killed zombie (4 hits)',
      '20 dirt and 20 cobblestone came into your inventory',
    ])
  })

  it('starts a new line after anyone speaks, and after the window', () => {
    let t = 1_000
    const log = createSessionEventLog({ now: () => t })
    let spokeAt = null
    const rec = createInventoryGainRecorder({
      record: log.record, now: () => t,
      spokeBetween: (from, to) => spokeAt != null && spokeAt > from && spokeAt <= to,
    })
    rec([{ item: 'dirt', n: 1 }])
    t += 1_000; spokeAt = t
    t += 1_000
    rec([{ item: 'iron_sword', n: 1 }])
    t += ACTION_COALESCE_MS + 1
    rec([{ item: 'bread', n: 2 }])
    rec([])
    expect(log.list().map((e) => e.text)).toEqual([
      '1 dirt came into your inventory',
      '1 iron_sword came into your inventory',
      '2 bread came into your inventory',
    ])
  })

  it('with the real conversation memory, an arrival after her line sits after it', async () => {
    const mem = createConvoMemory()
    const rc = mem.recentChat
    const rec = createInventoryGainRecorder({ record: rc.pushEvent, spokeBetween: rc.spokeBetween })
    rec([{ item: 'dirt', n: 1 }])
    await new Promise((r) => setTimeout(r, 5))
    rc.pushSelf('Sui', 'i have zero items')
    await new Promise((r) => setTimeout(r, 5))
    rec([{ item: 'iron_sword', n: 1 }, { item: 'bread', n: 4 }])
    const block = rc.formatConversationBlock()
    expect(block.indexOf('game: 1 dirt came into your inventory')).toBeLessThan(block.indexOf('you: i have zero items'))
    expect(block.indexOf('game: 1 iron_sword and 4 bread came into your inventory')).toBeGreaterThan(block.indexOf('you: i have zero items'))
    expect(rc.eventSize).toBe(2)
  })
})

describe('snapshot composer reports items that arrived without an action of hers', () => {
  function fakeBot(inv) {
    const bot = new EventEmitter()
    Object.assign(bot, {
      version: '1.21.1', username: 'Sui', health: 20, food: 20, experience: { level: 0 },
      entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      entities: {}, players: {}, time: { timeOfDay: 6000, day: 1 },
      inventory: { items: () => inv, slots: [] },
      blockAt: () => ({ name: 'air' }), findBlocks: () => [],
      game: { dimension: 'overworld' },
    })
    return bot
  }

  it('calls back with a gift, not with the starting inventory or her own haul', () => {
    const inv = [{ name: 'oak_log', count: 2 }]
    const c = createSnapshotComposer({ bot: fakeBot(inv) })
    const seen = []
    const onUnexplainedGains = (g) => seen.push(g)
    c.next({ onUnexplainedGains })
    expect(seen).toEqual([])
    // Her own gather's logs plus a sword and bread from somewhere else.
    inv[0].count = 4
    inv.push({ name: 'iron_sword', count: 1 }, { name: 'bread', count: 4 })
    const now = Date.now()
    const progress = { dug: 2, total: 6, items: ['oak_log'], before: 2 }
    c.next({ onUnexplainedGains, recentActions: [{ name: 'gather', startedAt: now - 5000, endedAt: null, progress }] })
    expect(seen).toEqual([[{ item: 'iron_sword', n: 1 }, { item: 'bread', n: 4 }]])
    // Nothing changed: no call.
    c.next({ onUnexplainedGains })
    expect(seen.length).toBe(1)
    // A loss is not a gain.
    inv.pop()
    c.next({ onUnexplainedGains })
    expect(seen.length).toBe(1)
  })

  it('leaves blocks picked up on the way out of the record, keeps gear and food', () => {
    const inv = []
    const c = createSnapshotComposer({ bot: fakeBot(inv) })
    const seen = []
    const onUnexplainedGains = (g) => seen.push(g)
    c.next({ onUnexplainedGains })
    const now = Date.now()
    inv.push({ name: 'dirt', count: 1 }, { name: 'cobblestone', count: 6 })
    c.next({ onUnexplainedGains, recentActions: [{ name: 'goTo', startedAt: now - 5000, endedAt: null }] })
    expect(seen).toEqual([])
    inv.push({ name: 'stone_pickaxe', count: 1 }, { name: 'bread', count: 2 })
    c.next({ onUnexplainedGains, recentActions: [{ name: 'goTo', startedAt: now - 5000, endedAt: null }] })
    expect(seen).toEqual([[{ item: 'stone_pickaxe', n: 1 }, { item: 'bread', n: 2 }]])
  })

  it('a throwing callback never breaks the snapshot', () => {
    const inv = []
    const c = createSnapshotComposer({ bot: fakeBot(inv) })
    c.next({})
    inv.push({ name: 'bread', count: 1 })
    const snap = c.next({ onUnexplainedGains: () => { throw new Error('boom') } })
    expect(snap).toContain('INVENTORY JUST CHANGED')
  })
})

describe('renderHeartbeat while she is stopped on the player\'s word', () => {
  const stamp = new Date(Date.now() + 60_000).toISOString()
  const goals = `- [${stamp}] (player task) Alex asked for 10 more logs.\n- [${stamp}] Build a base with Alex.`

  it('uses the on-hold heads for this session\'s tasks and her own goals', () => {
    const out = renderHeartbeat(2, goals, '', { sessionStartMs: Date.now(), onHold: true })
    expect(out).toContain(PLAYER_TASKS_ON_HOLD_HEAD)
    expect(out).toContain(OWN_GOALS_ON_HOLD_HEAD)
    expect(out).not.toContain(PLAYER_TASKS_HEAD)
    expect(out).not.toContain('work the next step')
    expect(out).toContain('(player task) Alex asked for 10 more logs.')
    expect(out).toContain('Build a base with Alex.')
  })

  it('own goals alone also get the on-hold head, and the usual heads come back without the hold', () => {
    const own = `- [${stamp}] Build a base with Alex.`
    expect(renderHeartbeat(2, own, '', { onHold: true })).toContain(OWN_GOALS_ON_HOLD_HEAD)
    const normal = renderHeartbeat(2, goals, '', { sessionStartMs: Date.now() })
    expect(normal).toContain(PLAYER_TASKS_HEAD)
    expect(normal).not.toContain('on hold')
  })

  it('says her own plans are known to the player only if she told them, on the on-hold head only', () => {
    const own = `- [${stamp}] Build a base with Alex.`
    const known = 'the player knows about one only if the conversation shows you told them about it'
    expect(renderHeartbeat(2, own, '', { onHold: true })).toContain(known)
    expect(renderHeartbeat(2, own, '', {})).not.toContain(known)
    expect(renderHeartbeat(2, goals, '', { sessionStartMs: Date.now() })).not.toContain(known)
  })
})

// â”€â”€â”€ orchestrator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// gather runs until aborted; everything else is instant. The composer hands
// out a gift on the call named by `giftOnCall`.
function makeAdapter({ snapshotOpts, running, giftOnCall = -1 }) {
  const ACTIONS = ['gather', 'look']
  let n = 0
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ name: z.string().optional() }),
    getActionDescription: (a) => `do ${a}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({
      next: (opts) => {
        snapshotOpts.push(opts)
        if (n++ === giftOnCall) opts?.onUnexplainedGains?.([{ item: 'iron_sword', n: 1 }, { item: 'bread', n: 4 }])
        return opts?.hideNext ? 'SNAPSHOT' : 'SNAPSHOT\nnext: make a furnace'
      },
    }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, _args, opts = {}) => {
      if (name !== 'gather') return Promise.resolve(`${name} ok`)
      return new Promise((resolve) => {
        running[name] = resolve
        opts.signal?.addEventListener?.('abort', () => resolve(`aborted ${name}`), { once: true })
      })
    },
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
      memory_md_path: path.join(os.tmpdir(), `sei-p16-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p16-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

const say = (id, text) => ({ id, name: 'say', input: { text } })
const act = (id, name, input = {}) => ({ id, name, input })
const turn = (...toolUses) => ({ text: '', toolUses })
const userText = (call) => JSON.stringify((call.messages ?? []).slice(-1))
const allText = (call) => JSON.stringify(call.messages ?? [])
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const DRAINED = new Set(['sei:action_complete', 'sei:chat_received', 'sei:action_tick'])
const flush = () => new Promise((r) => setTimeout(r, 5))

function setup(script, { giftOnCall = -1, goals = null } = {}) {
  _setTickIntervalForTests(10_000_000)
  const cfg = config()
  if (goals) fs.writeFileSync(cfg.memory.heartbeat_md_path, `# HEARTBEAT\n${goals}\n`)
  const snapshotOpts = []
  const running = {}
  const queue = []
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter: makeAdapter({ snapshotOpts, running, giftOnCall }), config: cfg,
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
  return { orch, provider, snapshotOpts, running, drain }
}

describe('orchestrator: after she stops on the player\'s word', () => {
  it('leaves next: out and puts her goals on hold until new work', async () => {
    const stamp = new Date(Date.now() + 60_000).toISOString()
    const { orch, provider, running, drain } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'oak_log' })),
      turn(say('s2', 'ok stopping'), act('st', 'stop')),
      turn(say('s3', 'lol')),
      turn(say('s4', 'back on it'), act('a2', 'gather', { name: 'oak_log' })),
      turn(say('s5', 'ok')),
      turn(say('s6', 'ty')),
    ], { goals: `- [${stamp}] (player task) Steve asked for 10 more logs.\n- [${stamp}] Build a base with Steve.` })
    await orch.handleDispatch('sei:chat_received', line('go get more wood, like 10 more'))
    // Before the stop: the usual heads.
    expect(allText(provider.calls[0])).toContain('work the next step of the oldest one now')
    await orch.handleDispatch('sei:chat_received', line('actually stop'))
    await flush()
    await drain()
    await orch.handleDispatch('sei:chat_received', line('jk jk'))
    await flush()
    await drain()
    const jk = provider.calls[provider.calls.length - 1]
    expect(userText(jk)).toContain('jk jk')
    expect(userText(jk)).toContain('hold: you stopped')
    expect(userText(jk)).not.toContain('next: make a furnace')
    expect(allText(jk)).toContain(PLAYER_TASKS_ON_HOLD_HEAD)
    expect(allText(jk)).not.toContain('work the next step of the oldest one now')
    // New work from the player's line ends it.
    await orch.handleDispatch('sei:chat_received', line('ok go get the wood'))
    await flush()
    await drain()
    expect(running.gather).toBeTypeOf('function')
    running.gather('gathered 10/10 oak_log')
    await flush()
    await drain()
    await flush()
    // The seed is per loop, so this loop's heartbeat still carries the
    // on-hold heads; they are worded to apply only while the hold line shows,
    // and the snapshot no longer has it.
    const after = provider.calls[provider.calls.length - 1]
    expect(userText(after)).not.toContain('hold: you stopped')
    // The next loop is back on the usual heads.
    await orch.handleDispatch('sei:chat_received', line('nice'))
    await flush()
    await drain()
    const next = provider.calls[provider.calls.length - 1]
    expect(userText(next)).toContain('nice')
    expect(allText(next)).not.toContain(PLAYER_TASKS_ON_HOLD_HEAD)
    expect(allText(next)).toContain('work the next step of the oldest one now')
  })
})

describe('orchestrator: items that came in are on the record', () => {
  it('a gift seen by the snapshot becomes a game: line after her own earlier line', async () => {
    // Composer call 0 is the greeting turn; call 1 (the "yo" turn) sees the gift.
    const { orch, provider, drain } = setup([
      turn(say('s1', 'hi steve, i have zero items')),
      turn(act('e1', 'end_loop')),
      turn(say('s3', 'good')),
    ], { giftOnCall: 1 })
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn' })
    await flush()
    await drain()
    await orch.handleDispatch('sei:chat_received', line('yo'))
    await flush()
    await drain()
    await orch.handleDispatch('sei:chat_received', line('how are you doing'))
    await flush()
    await drain()
    const last = allText(provider.calls[provider.calls.length - 1])
    const her = last.indexOf('i have zero items')
    const gift = last.indexOf('game: 1 iron_sword and 4 bread came into your inventory')
    expect(her).toBeGreaterThan(-1)
    expect(gift).toBeGreaterThan(her)
  })
})




