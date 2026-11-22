// src/bot/brain/sessionEvents.test.js
//
// 261014 (quality pass 7b): asked "what was i scared of earlier?", she said
// "you hid behind me like i was a wall". The player's line was in her prompt;
// what was missing was what HAPPENED (each player line opens a fresh loop, so
// the attackEntity result was gone), and her own "stay behind me" was the
// only trace of the fight. The transcript now carries the game's events as
// "game:" lines, and the header says to answer recall from the record.
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { createConvoMemory } from './convoMemory.js'
import {
  describeActionEvent,
  describeAttackEvent,
  describeDeathEvent,
  createSessionEventLog,
  actionEventKey,
  gameEventFact,
  SESSION_EVENT_CAPACITY,
  HIT_COALESCE_MS,
  ACTION_COALESCE_MS,
} from './sessionEvents.js'
import { SEED_HEADERS } from './prompts.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('describeActionEvent', () => {
  it('keeps a finished action with its result, attributed to her', () => {
    expect(describeActionEvent('attackEntity', 'killed zombie (4 hits)')).toBe('you used attackEntity: killed zombie (4 hits)')
    expect(describeActionEvent('gather', 'gathered 6/6 oak_log')).toBe('you used gather: gathered 6/6 oak_log')
  })
  it('keeps the fact and drops the advice after a semicolon', () => {
    const r = 'crafted 1 crafting_table, made 4 oak_planks for it first; it is in your inventory, not placed yet (placeBlock crafting_table to put it down)'
    expect(describeActionEvent('craft', r)).toBe('you used craft: crafted 1 crafting_table, made 4 oak_planks for it first')
  })
  it('skips looking, walking and equipping', () => {
    for (const n of ['look', 'find', 'explore', 'goTo', 'follow', 'unfollow', 'equip']) {
      expect(describeActionEvent(n, 'done')).toBeNull()
    }
  })
  it('skips a failure that changed nothing', () => {
    expect(describeActionEvent('craft', "can't craft wooden_pickaxe here: it needs a crafting table")).toBeNull()
    expect(describeActionEvent('gather', 'gathered 0/6 oak_log')).toBeNull()
    expect(describeActionEvent('dig', 'no path to the block')).toBeNull()
  })
  it('skips a result that starts with "no" (nothing there, nothing done)', () => {
    expect(describeActionEvent('dig', 'no target')).toBeNull()
    expect(describeActionEvent('pickup', 'no coal within 4m')).toBeNull()
    expect(describeActionEvent('placeBlock', 'No cobblestone in inventory')).toBeNull()
    expect(describeActionEvent('dig', 'dug coal_ore at 10,61,-4')).toBe('you used dig: dug coal_ore at 10,61,-4')
  })
  it('keeps a partial result and an abort that got something done', () => {
    expect(describeActionEvent('gather', 'gathered 3/6 oak_log')).toBe('you used gather: gathered 3/6 oak_log')
    expect(describeActionEvent('gather', 'aborted after 1/10 oak_log')).toBe('you used gather: aborted after 1/10 oak_log')
    expect(describeActionEvent('gather', 'aborted after 0/10 oak_log')).toBeNull()
    expect(describeActionEvent('attackEntity', 'aborted: attackEntity')).toBeNull()
  })
  it('reads the text of a structured result', () => {
    expect(describeActionEvent('build', { text: 'built 24 cells' })).toBe('you used build: built 24 cells')
    expect(describeActionEvent('build', null)).toBeNull()
  })
})

describe('describeAttackEvent / describeDeathEvent', () => {
  it('names who hit whom', () => {
    expect(describeAttackEvent({ attackerKind: 'hostile_mob', attackerLabel: 'zombie' }).text).toBe('a zombie hit you')
    expect(describeAttackEvent({ attackerKind: 'player', attackerLabel: 'Alex' }).text).toBe('Alex hit you')
    expect(describeAttackEvent({ attackerKind: 'defend', attackerLabel: 'cave_spider', ownerLabel: 'Alex' }).text).toBe('a cave spider attacked Alex')
    expect(describeAttackEvent({ attackerKind: 'defend', attackerLabel: 'zombie', ownerLabel: 'Alex', threat: true }).text).toBe('a zombie came at Alex')
  })
  it('a warning and a real hit on the player have different fold keys', () => {
    const warn = describeAttackEvent({ attackerKind: 'defend', attackerLabel: 'zombie', ownerLabel: 'Alex', threat: true })
    const hit = describeAttackEvent({ attackerKind: 'defend', attackerLabel: 'zombie', ownerLabel: 'Alex' })
    expect(warn.key).not.toBe(hit.key)
    let t = 1_000
    const log = createSessionEventLog({ now: () => t })
    log.record(warn.text, { key: warn.key, windowMs: HIT_COALESCE_MS, again: warn.again })
    t += 2_000
    log.record(hit.text, { key: hit.key, windowMs: HIT_COALESCE_MS, again: hit.again })
    expect(log.list().map((e) => e.text)).toEqual(['a zombie came at Alex', 'a zombie attacked Alex'])
  })
  it('skips a warning that was not a hit', () => {
    expect(describeAttackEvent({ attackerKind: 'reflex', attackerLabel: 'creeper' })).toBeNull()
    expect(describeAttackEvent({ attackerKind: 'survival', attackerLabel: 'drowning' })).toBeNull()
    expect(describeAttackEvent(null)).toBeNull()
  })
  it('names the last hit on a death when there was one', () => {
    expect(describeDeathEvent({ lastAttack: { label: 'skeleton', kind: 'hostile_mob' } })).toBe('you died (last hit by a skeleton)')
    // 261019 (pass 19): the game's own death message names the real cause.
    expect(describeDeathEvent({ deathText: 'Sui drowned', lastAttack: { label: 'skeleton', kind: 'hostile_mob' } })).toBe('you died (Sui drowned)')
    expect(describeDeathEvent({})).toBe('you died')
  })
})

describe('createSessionEventLog', () => {
  it('folds repeat hits from one attacker into one line', () => {
    let t = 1_000
    const log = createSessionEventLog({ now: () => t })
    log.record('a zombie hit you', { key: 'hit:a zombie', windowMs: HIT_COALESCE_MS })
    t += 2_000
    log.record('a zombie hit you', { key: 'hit:a zombie', windowMs: HIT_COALESCE_MS })
    t += 2_000
    log.record('a zombie hit you', { key: 'hit:a zombie', windowMs: HIT_COALESCE_MS })
    expect(log.list().map((e) => e.text)).toEqual(['a zombie hit you, more than once'])
    t += HIT_COALESCE_MS + 1
    log.record('a zombie hit you', { key: 'hit:a zombie', windowMs: HIT_COALESCE_MS })
    expect(log.size).toBe(2)
  })
  it('words a folded hit as kept hitting, never with a count', () => {
    let t = 1_000
    const log = createSessionEventLog({ now: () => t })
    const ev = describeAttackEvent({ attackerKind: 'hostile_mob', attackerLabel: 'zombie' })
    for (let i = 0; i < 4; i++) {
      log.record(ev.text, { key: ev.key, windowMs: HIT_COALESCE_MS, again: ev.again })
      t += 3_500
    }
    expect(log.list().map((e) => e.text)).toEqual(['a zombie kept hitting you'])
    expect(log.list()[0].text).not.toMatch(/\d/)
  })
  it('busy work folds, so an earlier kill is still in the record', () => {
    let t = 1_000
    const log = createSessionEventLog({ now: () => t })
    const put = (name, result) => {
      const line = describeActionEvent(name, result)
      if (line) log.record(line, { key: actionEventKey(line), windowMs: ACTION_COALESCE_MS })
    }
    put('attackEntity', 'killed zombie (4 hits)')
    for (let i = 0; i < 20; i++) {
      t += 2_000
      put('dig', `dug coal_ore at ${10 + i},61,-4`)
      put('pickup', 'no coal within 4m')
    }
    const texts = log.list().map((e) => e.text)
    expect(texts[0]).toBe('you used attackEntity: killed zombie (4 hits)')
    expect(texts).toEqual([
      'you used attackEntity: killed zombie (4 hits)',
      'you used dig: dug coal_ore at 29,61,-4, more than once',
    ])
    // Past the window the same result is a new line again.
    t += ACTION_COALESCE_MS + 1
    put('dig', 'dug coal_ore at 40,61,-4')
    expect(log.size).toBe(3)
  })
  it('is bounded, oldest out first', () => {
    const log = createSessionEventLog()
    for (let i = 0; i < SESSION_EVENT_CAPACITY + 3; i++) log.record(`event ${i}`)
    const texts = log.list().map((e) => e.text)
    expect(texts).toHaveLength(SESSION_EVENT_CAPACITY)
    expect(texts[0]).toBe('event 3')
  })
})

describe('gameEventFact', () => {
  it('keeps the fact of a game notice and drops the instructions', () => {
    const text = '[A new day: spring 4, rain. Your energy and health are full. On the farm this morning: 15 crops need water. This is a game event, not the player talking; act on it, and only speak if it fits.]'
    expect(gameEventFact({ text })).toBe('A new day: spring 4, rain')
    expect(gameEventFact({ text: '[It is 10 PM. The day ends at 2 AM and you pass out if you are still up.]' })).toBe('It is 10 PM')
    expect(gameEventFact({ text, fact: 'a new day began (spring 4, rain)' })).toBe('a new day began (spring 4, rain)')
    expect(gameEventFact({})).toBe('')
  })
})

describe('game lines in the conversation transcript', () => {
  it('sit between the spoken lines in the order things happened, marked game:', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const m = createConvoMemory().recentChat
    m.pushPlayer('Alex', 'theres a zombie!! kill it')
    vi.setSystemTime(1_001_000)
    m.pushSelf('Sui', 'coming at it now, stay behind me')
    vi.setSystemTime(1_004_000)
    m.pushEvent('you used attackEntity: killed zombie (4 hits)')
    vi.setSystemTime(1_005_000)
    m.pushPlayer('Alex', 'are you ok??')
    vi.setSystemTime(1_010_000)
    const lines = m.formatConversationBlock().split('\n').slice(1)
    expect(lines).toEqual([
      '[10s ago] player (Alex): theres a zombie!! kill it',
      '[9s ago] you: coming at it now, stay behind me',
      '[6s ago] game: you used attackEntity: killed zombie (4 hits)',
      '[5s ago] player (Alex): are you ok??',
    ])
  })
  it('are never a speaker: who spoke last is unchanged', () => {
    const m = createConvoMemory().recentChat
    m.pushSelf('Sui', 'on it')
    m.pushEvent('a zombie hit you')
    expect(m.lastSelf().text).toBe('on it')
    expect(m.lastPlayer()).toBeNull()
    expect(m.playerSize + m.selfSize).toBe(1)
  })
  it('do not use up the turn window, and an older event still shows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const m = createConvoMemory().recentChat
    m.pushEvent('you used attackEntity: killed zombie (4 hits)')
    for (let i = 0; i < 30; i++) {
      vi.setSystemTime(2_000 + i * 1000)
      m.pushPlayer('Alex', `line ${i}`)
    }
    const block = m.formatConversationBlock()
    expect(block).toContain('game: you used attackEntity: killed zombie (4 hits)')
    expect(block).not.toContain('line 5\n') // older spoken lines still roll off
    expect(block.split('\n')[1]).toContain('game:') // the event sits at the top
  })
  it('the header says to answer recall from the record', () => {
    expect(SEED_HEADERS.conversation).toContain('Lines marked "game:"')
    expect(SEED_HEADERS.conversation).toContain('if you told them to do something, that does not mean they did it')
    expect(SEED_HEADERS.conversation).toContain('say you are not sure')
    // Past-session recall comes from memory, not this transcript.
    expect(SEED_HEADERS.conversation).toContain('not in here or in your memory')
  })
})

// â”€â”€ Through the orchestrator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeProvider(script) {
  let i = 0
  const calls = []
  return {
    calls,
    buildCachedSystem: (blocks) => blocks,
    setAuthToken() {},
    setBackend() {},
    async call(args) {
      calls.push({ ...args, blocks: JSON.parse(JSON.stringify(args.namedUserBlocks ?? [])) })
      const r = script[Math.min(i, script.length - 1)]
      i += 1
      return typeof r === 'function' ? r(args) : r
    },
  }
}

function makeOrch({ script, executeAction }) {
  const adapter = {
    gameName: 'Minecraft',
    listActions: () => ['attackEntity', 'follow', 'goTo', 'gather'],
    getActionSchema: () => z.object({
      entity: z.string().optional(), player: z.string().optional(),
      x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
      block: z.string().optional(), count: z.number().optional(),
    }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction,
  }
  const config = {
    player_username: 'Alex',
    preferred_name: 'Alex',
    persona: { name: 'Sui', expanded: 'You are a loud gremlin.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-orch-events-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`),
      iteration_cap: 30,
    },
    web: { enabled: false },
  }
  const provider = makeProvider(script)
  const reenqueued = []
  const orch = createOrchestrator({
    adapter, config,
    reenqueue: (event, data) => reenqueued.push({ event, data }),
    sessionState: { playerData: () => ({}), onLoopTerminal: async () => {} },
    playerStore: { formatPlayerSeedBlock: () => 'PLAYER' },
    _anthropicOverride: provider,
  })
  return { orch, provider, reenqueued }
}

const chat = (text) => ({ text, message: text, username: 'Alex', playerSpoke: true, ts: Date.now() })
const convoOf = (call) => call.blocks
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .filter((b) => b?.name === 'recent_conversation').map((b) => b.text).join('\n')

describe('a finished action reaches the next loop as a game line', () => {
  it('the kill is in the transcript when the player later asks about it', async () => {
    _setTickIntervalForTests(10_000_000)
    const { orch, provider, reenqueued } = makeOrch({
      executeAction: () => Promise.resolve('killed zombie (4 hits)'),
      script: [
        { text: '', toolUses: [
          { id: 's1', name: 'say', input: { text: 'coming at it now, stay behind me' } },
          { id: 'a1', name: 'attackEntity', input: { entity: 'zombie' } },
        ] },
        { text: '', toolUses: [{ id: 'e1', name: 'end_loop', input: {} }] },
        { text: '', toolUses: [{ id: 's2', name: 'say', input: { text: 'mobs, you said so' } }] },
      ],
    })
    orch.recordIncomingChat('Alex', 'theres a zombie!! kill it')
    await orch.handleDispatch('sei:chat_received', chat('theres a zombie!! kill it'))
    await new Promise((r) => setTimeout(r, 0))
    const done = reenqueued.find((r) => r.event === 'sei:action_complete')
    expect(done).toBeTruthy()
    await orch.handleDispatch('sei:action_complete', done.data)
    orch.recordGameEvent('attacked', { attackerKind: 'defend', attackerLabel: 'zombie', ownerLabel: 'Alex' })
    orch.recordGameEvent('attacked', { attackerKind: 'reflex', attackerLabel: 'creeper' })
    orch.recordIncomingChat('Alex', 'what was i scared of earlier?')
    await orch.handleDispatch('sei:chat_received', chat('what was i scared of earlier?'))
    const convo = convoOf(provider.calls.at(-1))
    expect(convo).toContain('you: coming at it now, stay behind me')
    expect(convo).toContain('game: you used attackEntity: killed zombie (4 hits)')
    expect(convo).toContain('game: a zombie attacked Alex')
    expect(convo).not.toContain('creeper')
    // her line comes before the result of the action it announced
    expect(convo.indexOf('stay behind me')).toBeLessThan(convo.indexOf('killed zombie'))
  })
})

describe('an action finished by the post-teardown drain is recorded too', () => {
  it('the drained gather shows up as a game line in the next turn', async () => {
    _setTickIntervalForTests(10_000_000)
    const finish = []
    const executeAction = async (name, args, ctx = {}) => {
      if (name === 'goTo') return new Promise(() => {})
      if (name === 'gather') {
        return new Promise((res) => {
          finish.push(() => res('gathered 16/16 oak_log'))
          ctx.signal?.addEventListener('abort', () => res('aborted'), { once: true })
        })
      }
      return `${name}:ok`
    }
    const { orch, provider } = makeOrch({
      executeAction,
      script: [
        { text: '', toolUses: [
          { id: 's1', name: 'say', input: { text: 'on it' } },
          { id: 'g1', name: 'goTo', input: { x: 1, y: 64, z: 1 } },
          { id: 'a1', name: 'gather', input: { block: 'oak_log', count: 16 } },
        ] },
        { text: 'ok', toolUses: [] },
        { text: '', toolUses: [{ id: 's2', name: 'say', input: { text: 'sixteen logs' } }] },
      ],
    })
    orch.recordIncomingChat('Alex', 'get wood')
    await orch.handleDispatch('sei:chat_received', chat('get wood'))
    expect(orch.currentLoop?._pendingToolUses?.map((e) => e.use.name)).toEqual(['gather'])
    // An attack tears the loop down; the stranded gather runs in the drain.
    await orch.handleDispatch('sei:attacked', { attackerLabel: 'zombie', attackerKind: 'mob' })
    await new Promise((r) => setTimeout(r, 0))
    expect(orch.currentLoop).toBeNull()
    expect(finish).toHaveLength(1)
    finish[0]()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    orch.recordIncomingChat('Alex', 'how much wood did you get?')
    await orch.handleDispatch('sei:chat_received', chat('how much wood did you get?'))
    expect(convoOf(provider.calls.at(-1))).toContain('game: you used gather: gathered 16/16 oak_log')
  })
})

describe('deaths and game notices reach the transcript through recordGameEvent', () => {
  it('records the death cause and only the fact of a game notice', async () => {
    _setTickIntervalForTests(10_000_000)
    const { orch, provider } = makeOrch({
      executeAction: async () => 'ok',
      script: [{ text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'yeah' } }] }],
    })
    orch.recordGameEvent('death', { lastAttack: { label: 'skeleton', kind: 'hostile_mob' } })
    orch.recordGameEvent('game', {
      text: '[A new day: spring 4, rain. Your energy and health are full. This is a game event, not the player talking; act on it, and only speak if it fits.]',
      fact: 'a new day began (spring 4, rain)',
    })
    orch.recordGameEvent('game', { text: '[It is 10 PM. The day ends at 2 AM and you pass out if you are still up.]' })
    orch.recordIncomingChat('Alex', 'what happened?')
    await orch.handleDispatch('sei:chat_received', chat('what happened?'))
    const convo = convoOf(provider.calls.at(-1))
    expect(convo).toContain('game: you died (last hit by a skeleton)')
    expect(convo).toContain('game: a new day began (spring 4, rain)')
    expect(convo).toContain('game: It is 10 PM')
    expect(convo).not.toContain('act on it')
    expect(convo).not.toContain('pass out')
  })
})




