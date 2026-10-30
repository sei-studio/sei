// 261015: quality pass 9, "still doing it" after it stopped, and errands
// dropped for her own project.
//  - the snapshot's idle line names the last action and how it ended
//  - an action that finishes during a mid-action turn keeps the loop up until
//    its completion has run (it used to be dropped with the loop)
//  - the idle tick puts an unfinished player request before her own goal

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { EVENT_GUIDANCE } from './promptLibrary.js'
import { createInflightTracker, idleLineForSnapshot } from './inflight.js'
import { createOrchestrator, _setTickIntervalForTests, isBareStopLine } from './orchestrator.js'

describe('inflight: how the last action ended', () => {
  it('keeps the result and the aborted flag in recent()', () => {
    const t = createInflightTracker()
    const h = t.start({ name: 'gather', args: { name: 'oak_log', count: 10 } })
    t.end(h, { result: 'aborted after 2/10 oak_log', aborted: true })
    const [entry] = t.recent()
    expect(entry.result).toBe('aborted after 2/10 oak_log')
    expect(entry.aborted).toBe(true)
    const h2 = t.start({ name: 'dig', args: {} })
    t.end(h2)
    expect(t.recent()[1].result).toBeNull()
    expect(t.recent()[1].aborted).toBe(false)
  })
})

describe('idleLineForSnapshot', () => {
  const now = 1_000_000
  const gather = (over = {}) => ({ name: 'gather', args: { name: 'oak_log', count: 10 }, startedAt: now - 60_000, endedAt: now - 40_000, result: 'aborted after 2/10 oak_log', aborted: true, ...over })

  it('is the plain line with nothing in the history', () => {
    expect(idleLineForSnapshot({ recentActions: [], now })).toBe('idle: no action is running')
    expect(idleLineForSnapshot()).toBe('idle: no action is running')
  })

  it('names a stopped action, when, and its result', () => {
    const line = idleLineForSnapshot({ recentActions: [gather()], now })
    expect(line).toBe('idle: no action is running. Your last action (gather oak_log) was stopped 40s ago: aborted after 2/10 oak_log. It is not running now.')
  })

  it('says a finished action ended', () => {
    const line = idleLineForSnapshot({ recentActions: [gather({ aborted: false, result: 'gathered 8/8 coal' })], now })
    expect(line).toContain('ended 40s ago: gathered 8/8 coal')
  })

  it('skips glances after the real action, and the running entry', () => {
    const recent = [
      gather(),
      { name: 'look', args: {}, startedAt: now - 30_000, endedAt: now - 29_000, result: 'saw trees', aborted: false },
      { name: 'equip', args: { item: 'stone_axe' }, startedAt: now - 20_000, endedAt: now - 19_000, result: 'equipped', aborted: false },
      { name: 'dig', args: {}, startedAt: now - 1_000, endedAt: null, result: null, aborted: false },
    ]
    expect(idleLineForSnapshot({ recentActions: recent, now })).toContain('(gather oak_log) was stopped')
  })

  it('keeps the following clause', () => {
    const line = idleLineForSnapshot({ recentActions: [gather()], following: 'Alex', now })
    expect(line.startsWith('idle: no action is running, but you are still following Alex. Your last action (gather oak_log)')).toBe(true)
  })

  it('drops an action older than ten minutes, and clips a long result', () => {
    expect(idleLineForSnapshot({ recentActions: [gather({ endedAt: now - 11 * 60_000 })], now })).toBe('idle: no action is running')
    const line = idleLineForSnapshot({ recentActions: [gather({ result: 'x'.repeat(400) })], now })
    expect(line.length).toBeLessThan(260)
    expect(line).toContain('...')
  })
})

describe('prompt text', () => {
  it('the idle tick puts an unfinished player request first', () => {
    const text = EVENT_GUIDANCE['sei:idle']({ quietMs: 6000 })
    expect(text).toContain('if the player asked you for something that is not finished yet')
    expect(text).toContain('setGoal (for_player true)')
    expect(text.indexOf('not finished yet')).toBeLessThan(text.indexOf('PROACTIVENESS'))
    expect(text).not.toContain('—`')
  })
})

// ─── the mid-action race ────────────────────────────────────────────────

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

// gather and dig run until the test settles them; everything else is instant.
function makeAdapter(executed, running) {
  const ACTIONS = ['gather', 'dig', 'give', 'goTo', 'follow', 'unfollow']
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ name: z.string().optional(), item: z.string().optional(), player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, _args, opts = {}) => {
      executed.push(name)
      if (name !== 'gather' && name !== 'dig') return Promise.resolve('done')
      return new Promise((resolve) => {
        running[name] = resolve
        opts.signal?.addEventListener?.('abort', () => resolve(`aborted ${name}`), { once: true })
      })
    },
  }
}

let seq = 0
const config = () => {
  const tag = `${process.pid}-${Date.now()}-${seq++}`
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 30, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-p9-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p9-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

const say = (id, text) => ({ id, name: 'say', input: { text } })
const turn = (...toolUses) => ({ text: '', toolUses })
const lastUserText = (call) => JSON.stringify((call.messages ?? []).slice(-1))
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
// What the FSM would run next; loop_terminal / idle start fresh loops and are
// not part of these cases.
const DRAINED = new Set(['sei:action_complete', 'sei:chat_received', 'sei:action_tick'])
const flush = () => new Promise((r) => setTimeout(r, 5))

// Starts a gather for the coal order, then delivers "hows it going" while it
// runs. `raceTurn` is the model's answer to that line; the gather finishes
// while the call is out.
async function raceSetup(raceTurn, after = []) {
  _setTickIntervalForTests(10_000_000)
  const executed = []
  const running = {}
  const queue = []
  const provider = makeProvider([
    turn(say('s1', 'coal, on it'), { id: 'a1', name: 'gather', input: { name: 'coal_ore' } }),
    async () => {
      running.gather('gathered 8/8 coal')
      await flush()
      return raceTurn
    },
    ...after,
  ])
  const orch = createOrchestrator({
    adapter: makeAdapter(executed, running), config: config(),
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  await orch.handleDispatch('sei:chat_received', line('grab me some coal and bring it back'))
  expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  await orch.handleDispatch('sei:chat_received', line('hows it going'))
  const drain = async () => {
    for (let guard = 0; queue.length && guard < 20; guard++) {
      const next = queue.shift()
      if (DRAINED.has(next.event)) await orch.handleDispatch(next.event, next.data)
    }
  }
  return { orch, provider, executed, queue, drain }
}

describe('orchestrator: an action that finishes during a mid-action turn', () => {
  it('keeps the loop after a say-only reply, and the completion drives the next turn', async () => {
    const { orch, provider, executed, queue, drain } = await raceSetup(
      turn(say('s2', 'almost done down here')),
      [turn(say('s3', 'here you go'), { id: 'a2', name: 'give', input: { item: 'coal' } }), turn({ id: 'e9', name: 'end_loop', input: {} })],
    )
    expect(orch.currentLoop).not.toBeNull()
    expect(orch.currentLoop.inFlight).toBeNull()
    expect(queue.some((q) => q.event === 'sei:action_complete' && q.data.tickClaimed)).toBe(true)
    await drain()
    expect(provider.calls.length).toBe(4)
    expect(lastUserText(provider.calls[2])).toContain('previous action completed: gather -> gathered 8/8 coal')
    expect(executed).toEqual(['gather', 'give'])
  })

  it('treats end_loop in that turn like ending the turn with the action still running', async () => {
    const { orch, provider, drain } = await raceSetup(
      turn(say('s2', 'still going'), { id: 'e1', name: 'end_loop', input: {} }),
      [turn(say('s3', 'got it all'))],
    )
    expect(orch.currentLoop).not.toBeNull()
    await drain()
    expect(provider.calls.length).toBe(3)
    expect(lastUserText(provider.calls[2])).toContain('previous action completed: gather')
    expect(orch.currentLoop).toBeNull()
  })

  it('still ends the loop on stop', async () => {
    // 261024 (pass 26): "hows it going" did not ask for a stop, so the stop
    // gets one more call (stopThenNext) before the loop ends.
    const { orch, provider, drain } = await raceSetup(
      turn(say('s2', 'ok stopping'), { id: 't1', name: 'stop', input: {} }),
      [turn({ id: 'e9', name: 'end_loop', input: {} })],
    )
    await drain()
    expect(orch.currentLoop).toBeNull()
    expect(provider.calls.length).toBe(3)
    expect(lastUserText(provider.calls[2])).toContain('You stopped what you were doing')
  })

  it('does not wait when the turn started a new action', async () => {
    const { orch, provider, executed, drain } = await raceSetup(turn(say('s2', 'switching'), { id: 'a2', name: 'dig', input: {} }))
    expect(orch.currentLoop?.inFlight?.name).toBe('dig')
    await drain()
    expect(provider.calls.length).toBe(2)
    expect(executed).toEqual(['gather', 'dig'])
    expect(orch.currentLoop._settleOwed ?? null).toBeNull()
  })

  it('answers a line that arrives before the completion in the completion turn', async () => {
    const { orch, provider, drain } = await raceSetup(
      turn(say('s2', 'almost done')),
      [turn(say('s3', 'yep, coming back with it'))],
    )
    await orch.handleDispatch('sei:chat_received', line('are u done yet'))
    await drain()
    expect(provider.calls.length).toBe(3)
    const text = lastUserText(provider.calls[2])
    expect(text).toContain('previous action completed: gather')
    expect(text).toContain('are u done yet')
    expect(orch.currentLoop).toBeNull()
  })

  it('owes nothing when the action was stopped', async () => {
    _setTickIntervalForTests(10_000_000)
    const executed = []
    const running = {}
    const queue = []
    const provider = makeProvider([
      turn(say('s1', 'on it'), { id: 'a1', name: 'gather', input: { name: 'oak_log' } }),
      turn(say('s2', 'ok'), { id: 't1', name: 'stop', input: {} }),
      turn(say('s3', 'unreachable')),
    ])
    const orch = createOrchestrator({ adapter: makeAdapter(executed, running), config: config(), reenqueue: (event, data) => queue.push({ event, data }), _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('get wood'))
    await orch.handleDispatch('sei:chat_received', line('actually stop'))
    await flush()
    for (let guard = 0; queue.length && guard < 20; guard++) { const n = queue.shift(); if (DRAINED.has(n.event)) await orch.handleDispatch(n.event, n.data) }
    expect(orch.currentLoop).toBeNull()
    expect(provider.calls.length).toBe(2)
  })
})

// ─── pass 9c: the player's stop wins, a new order outranks the owed turn ──

// Starts a gather for "get wood", then the player's `midLine` arrives while it
// runs. `reply` answers that line; `settleDuringCall` finishes the gather
// while the call is out (the race window).
async function midSetup(midLine, reply, { settleDuringCall = false, after = [], group = false } = {}) {
  _setTickIntervalForTests(10_000_000)
  const executed = []
  const running = {}
  const queue = []
  const aborted = []
  const provider = makeProvider([
    turn(say('s1', 'on it'), { id: 'a1', name: 'gather', input: { name: 'oak_log' } }),
    async () => {
      if (settleDuringCall) { running.gather('gathered 8/8 oak_log'); await flush() }
      return reply
    },
    ...after,
  ])
  const adapter = makeAdapter(executed, running)
  const exec = adapter.executeAction
  adapter.executeAction = (name, args, opts = {}) => {
    opts.signal?.addEventListener?.('abort', () => aborted.push(name), { once: true })
    return exec(name, args, opts)
  }
  const orch = createOrchestrator({ adapter, config: config(), reenqueue: (event, data) => queue.push({ event, data }), _anthropicOverride: provider })
  if (group) { orch.setVoiceCall(true); orch.setCompanions(['Lyra']) }
  await orch.handleDispatch('sei:chat_received', line('get wood'))
  expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  await orch.handleDispatch('sei:chat_received', group ? { ...line(midLine), voice: true } : line(midLine))
  await flush()
  const drain = async () => {
    for (let guard = 0; queue.length && guard < 20; guard++) {
      const next = queue.shift()
      if (DRAINED.has(next.event)) await orch.handleDispatch(next.event, next.data)
    }
  }
  return { orch, provider, executed, aborted, running, queue, drain }
}

describe('orchestrator: a player stop always wins', () => {
  it('cancels the running action when "actually stop" is answered with words only', async () => {
    const { orch, provider, aborted, drain } = await midSetup('actually stop', turn(say('s2', 'ok ok stopping')), { after: [turn(say('s9', 'unreachable'))] })
    await drain()
    expect(aborted).toEqual(['gather'])
    expect(orch.currentLoop).toBeNull()
    expect(provider.calls.length).toBe(2)
  })

  it('owes no completion turn when the action finished during that reply', async () => {
    const { orch, provider, executed, drain } = await midSetup('actually stop', turn(say('s2', 'stopping, furnace is done anyway')), {
      settleDuringCall: true,
      after: [turn(say('s3', 'back to the table'), { id: 'a2', name: 'goTo', input: {} })],
    })
    await drain()
    expect(orch.currentLoop).toBeNull()
    expect(provider.calls.length).toBe(2)
    expect(executed).toEqual(['gather'])
  })

  it('still cancels when the reply is end_loop', async () => {
    const { orch, provider, aborted, drain } = await midSetup('ok stop', turn(say('s2', 'fine'), { id: 'e1', name: 'end_loop', input: {} }))
    await drain()
    expect(aborted).toEqual(['gather'])
    expect(orch.currentLoop).toBeNull()
    expect(provider.calls.length).toBe(2)
  })

  it('leaves a non-stop line answered with words to the running action', async () => {
    const { orch, aborted } = await midSetup('nice, how many so far', turn(say('s2', 'like 3')))
    expect(aborted).toEqual([])
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })

  it('lets a reply that starts a new action decide for itself', async () => {
    const { orch, executed } = await midSetup('stop', turn(say('s2', 'ok, coming'), { id: 'a2', name: 'dig', input: {} }))
    expect(executed).toEqual(['gather', 'dig'])
    expect(orch.currentLoop?.inFlight?.name).toBe('dig')
  })
})

describe('orchestrator: a new order during an action', () => {
  it('brings the order back in the completion turn when the reply started nothing', async () => {
    const { provider, running, queue, drain } = await midSetup('go get more wood, like 10 more', turn(say('s2', 'on it after this')), {
      after: [turn(say('s3', 'more wood'), { id: 'a2', name: 'dig', input: {} })],
    })
    running.gather('gathered 8/8 oak_log')
    await flush()
    expect(queue.some((q) => q.event === 'sei:action_complete')).toBe(true)
    await drain()
    const text = lastUserText(provider.calls[2])
    expect(text).toContain('previous action completed: gather')
    expect(text).toContain('go get more wood, like 10 more')
    expect(text).toContain('start it now, before your own plan')
  })

  it('brings it back when the action finished during the reply', async () => {
    const { provider, drain } = await midSetup('go get more wood, like 10 more', turn(say('s2', 'yep after this')), {
      settleDuringCall: true,
      after: [turn(say('s3', 'more wood'), { id: 'a2', name: 'dig', input: {} })],
    })
    await drain()
    expect(provider.calls.length).toBeGreaterThanOrEqual(3)
    const text = lastUserText(provider.calls[2])
    expect(text).toContain('previous action completed: gather')
    expect(text).toContain('start it now, before your own plan')
  })

  it('does not repeat the order once the reply started an action for it', async () => {
    const { orch, provider, running, drain } = await midSetup('dig here instead', turn(say('s2', 'ok'), { id: 'a2', name: 'dig', input: {} }), {
      after: [turn(say('s3', 'done'))],
    })
    expect(orch.currentLoop?._replyDeferred ?? null).toBeNull()
    running.dig('dug 1')
    await flush()
    await drain()
    for (const c of provider.calls.slice(2)) expect(lastUserText(c)).not.toContain('before your own plan')
  })
})

describe('isBareStopLine (pass 9c review)', () => {
  it('still matches real stop orders', () => {
    for (const t of ['stop', 'actually stop', 'ok stop', 'STOP!', 'sui stop', 'wait stop', 'ok stop it', 'stop now pls', 'cancel']) {
      expect(isBareStopLine(t)).toBe(true)
      expect(isBareStopLine(t, { wordsOnly: true })).toBe(true)
    }
  })
  it('does not match negations, questions or complaints', () => {
    for (const t of ['cant stop', "can't stop", 'wont stop', "won't stop", 'doesnt stop', "doesn't stop", 'didnt stop', "didn't stop", 'why stop?', 'why stop', 'stop?', 'sui stop?', 'ok stop ?']) {
      expect(isBareStopLine(t)).toBe(false)
    }
  })
  it('keeps nevermind for the end_loop backstop, not for a words-only reply', () => {
    for (const t of ['nevermind', 'ok nevermind', 'never mind']) {
      expect(isBareStopLine(t)).toBe(true)
      expect(isBareStopLine(t, { wordsOnly: true })).toBe(false)
    }
  })
})

describe('orchestrator: a group-call line to someone else (pass 9c review)', () => {
  it('"lyra stop" answered with silence leaves her own action running', async () => {
    const { orch, aborted } = await midSetup('lyra stop', turn(), { group: true })
    expect(aborted).toEqual([])
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })
  it('"lyra stop" answered with end_loop leaves it running too', async () => {
    const { orch, aborted } = await midSetup('lyra stop', turn({ id: 'e1', name: 'end_loop', input: {} }), { group: true })
    expect(aborted).toEqual([])
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })
  it('"lyra go get wood" is not carried into her completion turn', async () => {
    const { provider, running, drain } = await midSetup('lyra go get wood', turn(say('s2', 'go lyra')), {
      group: true, after: [turn(say('s3', 'done'))],
    })
    running.gather('gathered 8/8 oak_log')
    await flush()
    await drain()
    for (const c of provider.calls.slice(2)) expect(lastUserText(c)).not.toContain('before your own plan')
  })
})

describe('orchestrator: the deferred order is kept until a player turn settles it', () => {
  it('is not carried when the reply said nothing', async () => {
    const { provider, running, drain } = await midSetup('go get more wood, like 10 more', turn(), { after: [turn(say('s3', 'ok'))] })
    running.gather('gathered 8/8 oak_log')
    await flush()
    await drain()
    for (const c of provider.calls.slice(2)) expect(lastUserText(c)).not.toContain('you answered without starting anything')
  })
})
