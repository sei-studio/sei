// 261015: quality pass 8, announced-but-not-taken actions and hand-overs.
//  - a turn whose only work was a NEW setGoal gets one more call in the same
//    loop, told the goal starts nothing (start its first step or end_loop)
//  - setGoal, MEMORY_GOAL_TAIL and clearGoal say a goal / hand-over is not
//    done by writing or saying it
//  - give (Minecraft) hands items to the player in one call

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { NUDGES, ACTION_DESCRIPTIONS, PERSONALITY_TOOL_DESCRIPTIONS as TOOL, MEMORY_GOAL_TAIL } from './promptLibrary.js'
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

function makeAdapter(executed = []) {
  const ACTIONS = ['follow', 'unfollow', 'goTo', 'gather', 'dig', 'give']
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ player: z.string().optional(), name: z.string().optional(), item: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name) => {
      executed.push(name)
      return name === 'follow' || name === 'gather' ? new Promise(() => {}) : Promise.resolve('done')
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
      memory_md_path: path.join(os.tmpdir(), `sei-p8-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p8-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

const say = (id, text) => ({ id, name: 'say', input: { text } })
const goal = (id, text) => ({ id, name: 'setGoal', input: { text, for_player: true } })
const turn = (...toolUses) => ({ text: '', toolUses })
const lastUserText = (call) => JSON.stringify((call.messages ?? []).slice(-1))
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })

describe('orchestrator: a goal written down with no action started', () => {
  it('gets one more call that says the goal starts nothing, and the action it starts runs', async () => {
    _setTickIntervalForTests(10_000_000)
    const executed = []
    const provider = makeProvider([
      turn(goal('g1', 'Get 20 logs for the house. Done when Steve has them.'), say('s1', "on it, i'll get the logs")),
      turn({ id: 'a1', name: 'gather', input: { name: 'oak_log' } }),
    ])
    const orch = createOrchestrator({ adapter: makeAdapter(executed), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('go get some wood, like 20 logs'))
    expect(provider.calls.length).toBe(2)
    expect(lastUserText(provider.calls[1])).toContain(NUDGES.goalNotStarted)
    expect(executed).toEqual(['gather'])
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })

  it('ends the loop when the extra call only talks or ends the turn', async () => {
    _setTickIntervalForTests(10_000_000)
    for (const second of [turn({ id: 'e1', name: 'end_loop', input: {} }), turn(say('s2', 'later then'))]) {
      const provider = makeProvider([
        turn(goal('g1', 'Build a dock with Steve tomorrow. Done when the dock is built.'), say('s1', 'deal, tomorrow')),
        second,
      ])
      const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
      await orch.handleDispatch('sei:chat_received', line('lets build a dock tomorrow'))
      expect(provider.calls.length).toBe(2)
      expect(orch.currentLoop).toBeNull()
    }
  })

  it('fires once per loop, not again on a second goal-only turn', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      turn(goal('g1', 'Get stone for a pickaxe. Done when I have 3 cobblestone.'), say('s1', 'ok')),
      turn(goal('g2', 'Then get iron. Done when I hold an iron pickaxe.')),
      turn(say('s3', 'unreachable')),
    ])
    const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('yeah sounds good'))
    expect(provider.calls.length).toBe(2)
  })

  it('does not fire for a goal already in the heartbeat', async () => {
    _setTickIntervalForTests(10_000_000)
    const text = 'Get 8 logs for the dock. Done when Steve has them.'
    const provider = makeProvider([
      turn(goal('g1', text), say('s1', 'ok')),
      turn({ id: 'e1', name: 'end_loop', input: {} }),
      turn(goal('g2', text), say('s2', 'yep, still on it')),
      turn(say('s3', 'unreachable')),
    ])
    const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('get me 8 logs'))
    expect(provider.calls.length).toBe(2)
    await orch.handleDispatch('sei:chat_received', line('ok'))
    expect(provider.calls.length).toBe(3)
  })

  it('does not fire when the turn also started an action, or ended itself', async () => {
    _setTickIntervalForTests(10_000_000)
    const cases = [
      turn(goal('g1', 'Get 10 logs. Done when Steve has them.'), say('s1', 'on it'), { id: 'a1', name: 'gather', input: { name: 'oak_log' } }),
      turn(goal('g1', 'Get 10 logs later. Done when Steve has them.'), say('s1', 'later'), { id: 'e1', name: 'end_loop', input: {} }),
    ]
    for (const first of cases) {
      const provider = makeProvider([first, turn(say('s9', 'unreachable'))])
      const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
      await orch.handleDispatch('sei:chat_received', line('get some wood'))
      expect(provider.calls.length).toBe(1)
    }
  })

  it('does not fire while a foreground action runs (the goal is the next job)', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      turn({ id: 'a1', name: 'gather', input: { name: 'oak_log' } }, say('s1', 'chopping')),
      turn(goal('g1', 'After the logs, get coal for Steve. Done when Steve has the coal.'), say('s2', 'coal after this')),
      turn(say('s9', 'unreachable')),
    ])
    const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('get wood'))
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
    await orch.handleDispatch('sei:chat_received', line('then grab me some coal'))
    expect(provider.calls.length).toBe(2)
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })

  it('fires while she only follows (a background action), so the order can replace it', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      turn({ id: 'f1', name: 'follow', input: { player: 'Steve' } }, say('s1', 'coming')),
      turn(goal('g1', 'Chop 10 logs for Steve. Done when Steve has them.'), say('s2', 'ok, wood run')),
      turn({ id: 'a1', name: 'gather', input: { name: 'oak_log' } }),
    ])
    const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('follow me'))
    await orch.handleDispatch('sei:chat_received', line('actually go chop 10 logs'))
    expect(provider.calls.length).toBe(3)
    expect(lastUserText(provider.calls[2])).toContain(NUDGES.goalNotStarted)
  })
})

describe('orchestrator: the goal nudge is only for work the player asked for', () => {
  it('does not fire on the greeting or an idle turn that sets her own goal', async () => {
    _setTickIntervalForTests(10_000_000)
    for (const data of [{ reason: 'just_connected_first_spawn' }, { quietMs: 20000 }]) {
      const provider = makeProvider([
        turn(say('s1', 'yo, gonna get us iron tools today'), goal('g1', 'Get a stone pickaxe, then iron. Done when I hold an iron pickaxe.')),
        turn(say('s9', 'unreachable')),
      ])
      const executed = []
      const orch = createOrchestrator({ adapter: makeAdapter(executed), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
      await orch.handleDispatch('sei:idle', data)
      expect(provider.calls.length).toBe(1)
      expect(executed).toEqual([])
    }
  })

  it('asks for the reply only once when the player line was answered with setGoal alone', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      turn(goal('g1', 'Get 10 logs for Steve. Done when Steve has them.')),
      turn(say('s2', 'on it'), { id: 'a1', name: 'gather', input: { name: 'oak_log' } }),
    ])
    const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('get me 10 logs'))
    expect(provider.calls.length).toBe(2)
    const sent = lastUserText(provider.calls[1])
    expect(sent).toContain(NUDGES.goalNotStartedReplyOwed)
    expect(sent).not.toContain(NUDGES.goalNotStarted)
    expect(sent).toContain('Answer them now with one short say()')
  })
})

describe('prompt text', () => {
  const texts = () => [NUDGES.goalNotStarted, NUDGES.goalNotStartedReplyOwed, ACTION_DESCRIPTIONS.give, ACTION_DESCRIPTIONS.dropItem, TOOL.setGoal, TOOL.clearGoal, MEMORY_GOAL_TAIL]

  it('says writing a goal down starts nothing, near the end of a player turn and in the tool', () => {
    expect(NUDGES.goalNotStarted).toContain('does not start any work')
    expect(TOOL.setGoal).toContain('Recording a goal does not start it: when the player wants it done now')
    expect(MEMORY_GOAL_TAIL).toContain('setGoal only writes the task down')
  })

  it('makes give the hand-over verb and ties a hand-over task to it', () => {
    expect(ACTION_DESCRIPTIONS.give).toContain('Hand items to the player')
    expect(ACTION_DESCRIPTIONS.dropItem).toContain('use give instead')
    expect(TOOL.clearGoal).toContain('done once give has run')
    expect(MEMORY_GOAL_TAIL).toContain('reaches them only through give')
  })

  it('has no em dashes and does not judge speech in the give description', () => {
    for (const t of texts()) expect(t).not.toMatch(/â€”/)
    expect(ACTION_DESCRIPTIONS.give).not.toMatch(/\bsay(ing)?\b/i)
  })
})

describe('orchestrator: clearGoal in the same turn as give', () => {
  const GOAL = 'Bring Steve 3 coal. Done when Steve has the coal.'

  async function run(giveResult, secondTurn) {
    _setTickIntervalForTests(10_000_000)
    const cfg = config()
    const events = []
    const executed = []
    const base = makeAdapter(executed)
    const adapter = {
      ...base,
      handOverResult: (name, r) => (name === 'give' ? /^gave \d/.test(String(r ?? '')) : null),
      executeAction: (name) => {
        executed.push(name)
        return Promise.resolve(name === 'give' ? giveResult : 'done')
      },
    }
    const provider = makeProvider([
      turn(goal('g1', GOAL), say('s1', 'ok'), { id: 'e1', name: 'end_loop', input: {} }),
      secondTurn,
      turn({ id: 'e2', name: 'end_loop', input: {} }),
    ])
    const orch = createOrchestrator({ adapter, config: cfg, reenqueue: (ev, d) => events.push([ev, d]), _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('bring me 3 coal'))
    await orch.handleDispatch('sei:chat_received', line('got it?'))
    for (let i = 0; i < 20 && !events.some(([ev]) => ev === 'sei:action_complete'); i++) await new Promise(r => setTimeout(r, 5))
    const done = events.find(([ev]) => ev === 'sei:action_complete')
    if (done) await orch.handleDispatch(done[0], done[1])
    const fs = await import('node:fs')
    const heartbeat = fs.existsSync(cfg.memory.heartbeat_md_path) ? fs.readFileSync(cfg.memory.heartbeat_md_path, 'utf8') : ''
    return { provider, executed, heartbeat }
  }

  const giveUse = { id: 'gv', name: 'give', input: { item: 'coal', count: 3 } }
  const clearUse = { id: 'cg', name: 'clearGoal', input: { text: 'Bring Steve 3 coal' } }

  it('clears the goal once give hands the items over', async () => {
    const { provider, executed, heartbeat } = await run(
      'gave 3 coal to Steve, tossed at their feet; you have 0 coal left',
      turn(say('s2', 'here'), giveUse, clearUse),
    )
    expect(executed).toEqual(['give'])
    expect(heartbeat).not.toContain('Bring Steve 3 coal')
    expect(JSON.stringify(provider.calls[2].messages)).toContain('goal cleared (1)')
  })

  it('keeps the goal when give fails, even with clearGoal first in the turn', async () => {
    const { provider, executed, heartbeat } = await run(
      'cannot see Steve nearby, so nothing was given; you still have 3 coal',
      turn(say('s2', 'here'), clearUse, giveUse),
    )
    expect(executed).toEqual(['give'])
    expect(heartbeat).toContain('Bring Steve 3 coal')
    const sent = JSON.stringify(provider.calls[2].messages)
    expect(sent).toContain('goal kept')
    expect(sent).not.toContain('goal cleared')
  })

  it('clears right away when there is no give in the turn', async () => {
    const { provider, heartbeat } = await run('unused', turn(say('s2', 'all done'), clearUse, { id: 'e3', name: 'end_loop', input: {} }))
    expect(heartbeat).not.toContain('Bring Steve 3 coal')
    expect(provider.calls.length).toBe(2)
  })
})




