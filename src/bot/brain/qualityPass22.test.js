// 261022: quality pass 22.
//  - Called-off items were handed over later. "actually forget the logs,
//    just meet me over here" while the give ran got stop + goTo and no
//    clearGoal ("logs ride with me"), and the turn she arrived read the task
//    ("Done when 8 logs are handed to Alex via give") and gave them. Now a
//    task whose action she stopped or replaced on a player's line is held
//    with that line, and every snapshot shows the player's open task next to
//    what they said since asking for it (or the line she stopped on).

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { renderHeartbeat, PLAYER_TASKS_HELD_HEAD, PLAYER_TASKS_HEAD } from './promptLibrary.js'
import { createOrchestrator, composeSeedBlocks, _setTickIntervalForTests } from './orchestrator.js'

afterEach(() => { vi.restoreAllMocks() })

// â”€â”€â”€ orchestrator harness (as qualityPass15.test.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// gather runs until settled or aborted; everything else is instant.
function makeAdapter(executed, running, aborted) {
  const ACTIONS = ['gather', 'give', 'goTo', 'follow', 'unfollow']
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ name: z.string().optional(), count: z.number().optional(), item: z.string().optional(), player: z.string().optional() }),
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
      if (name !== 'gather') return Promise.resolve(`${name} ok`)
      return new Promise((resolve) => {
        running[name] = resolve
        opts.signal?.addEventListener?.('abort', () => { aborted.push(name); resolve(`aborted ${name}`) }, { once: true })
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
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-p22-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p22-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

const say = (id, text) => ({ id, name: 'say', input: { text } })
const act = (id, name, input = {}) => ({ id, name, input })
const turn = (...toolUses) => ({ text: '', toolUses })
const lastUserText = (call) => JSON.stringify((call.messages ?? []).slice(-1))
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const DRAINED = new Set(['sei:action_complete', 'sei:chat_received', 'sei:action_tick'])
const flush = () => new Promise((r) => setTimeout(r, 5))
// A player line as index.js delivers it: recorded, then dispatched. The
// wait keeps its stamp off the millisecond of the turn before (a line in
// the same ms as the setGoal reads as said before the task was set).
async function hear(orch, text) {
  await new Promise((r) => setTimeout(r, 2))
  orch.recordIncomingChat('Steve', text)
  await orch.handleDispatch('sei:chat_received', line(text))
}

function setup(script, cfg = config()) {
  _setTickIntervalForTests(10_000_000)
  const executed = []
  const running = {}
  const aborted = []
  const queue = []
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter: makeAdapter(executed, running, aborted), config: cfg,
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  const drain = async () => {
    for (let guard = 0; queue.length && guard < 20; guard++) {
      const next = queue.shift()
      if (DRAINED.has(next.event)) await orch.handleDispatch(next.event, next.data)
    }
  }
  const settle = async () => { await flush(); await drain(); await flush(); await drain() }
  return { orch, provider, executed, running, aborted, drain, settle }
}

const DOCK = "Get 8 logs for Steve's dock. Done when 8 logs are handed to Steve via give."
const ASK = turn(say('s1', 'on it'), act('g1', 'setGoal', { text: DOCK, for_player: true }), act('a1', 'gather', { name: 'oak_log', count: 8 }))
const CALL_OFF = 'actually forget the logs, just meet me over here'
const held = (call) => lastUserText(call).includes(`on hold: Steve's task \\"Get 8 logs for Steve's dock.`)
const since = (call) => lastUserText(call).includes(`Steve's task \\"Get 8 logs for Steve's dock.`) && lastUserText(call).includes('Since they asked for it, they said')

const switched = (call) => lastUserText(call).includes(`switched: Steve's task \\"Get 8 logs for Steve's dock.`)
const COAL = 'Bring Steve 4 coal from the ore by the hill. Done when 4 coal are handed to Steve via give.'
const heldCoal = (call) => /(on hold|switched): Steve's task \\"Bring Steve 4 coal/.test(lastUserText(call))

describe('a task whose action she stopped on the player\'s line', () => {
  it('is held on a plain stop, and the next turn shows it with the line she stopped on', async () => {
    const { orch, provider, aborted, running, settle } = setup([
      ASK,
      turn(say('s2', 'ok ok, holding'), act('st', 'stop')),
      turn(say('s3', 'still here')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, CALL_OFF)
    await settle()
    expect(aborted).toEqual(['gather'])
    await hear(orch, 'lol')
    await settle()
    const text = lastUserText(provider.calls[provider.calls.length - 1])
    expect(held(provider.calls[provider.calls.length - 1])).toBe(true)
    expect(text).toContain(`when they said \\"${CALL_OFF}\\"`)
    expect(text).toContain('Do not pick it back up, or hand anything over for it, unless they ask for it again. If they ask for it again, call setGoal with the same text to pick it back up.')
  })

  it('is only noted as switched when another action replaces it (a detour or a call-off)', async () => {
    const { orch, provider, settle } = setup([
      ASK,
      turn(say('s2', 'ok coming, logs ride with me'), act('st', 'stop'), act('m1', 'goTo', { player: 'Steve' })),
      turn(say('s3', 'here')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, 'come look at this a sec')
    await settle()
    const last = provider.calls[2]
    expect(held(last)).toBe(false)
    expect(switched(last)).toBe(true)
    expect(lastUserText(last)).toContain('If it was only a detour, go back to the task once that is done.')
  })

  it('a detour is back on once she starts an action for the task again', async () => {
    const { orch, provider, running, settle } = setup([
      ASK,
      turn(say('s2', 'coming'), act('m1', 'goTo', { player: 'Steve' })),
      turn(say('s3', 'back to the trees'), act('a2', 'gather', { name: 'oak_log', count: 8 })),
      turn(say('s4', 'got them')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, 'come look at this a sec')
    await settle()
    // The walk ends at once here; that turn still shows the switch.
    expect(switched(provider.calls[2])).toBe(true)
    running.gather('gathered 8/8 oak_log')
    await settle()
    const last = provider.calls[provider.calls.length - 1]
    expect(switched(last)).toBe(false)
    expect(held(last)).toBe(false)
  })

  it('holds only the task the stopped action worked', async () => {
    const { orch, provider, settle } = setup([
      turn(say('s0', 'coal, got it'), act('g0', 'setGoal', { text: COAL, for_player: true })),
      ASK,
      turn(say('s2', 'ok, stopping'), act('st', 'stop')),
      turn(say('s3', 'hm')),
    ])
    await hear(orch, 'can u get me 4 coal from that ore')
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, 'actually forget the logs')
    await settle()
    await hear(orch, 'lol')
    await settle()
    const last = provider.calls[provider.calls.length - 1]
    expect(held(last)).toBe(true)
    expect(heldCoal(last)).toBe(false)
  })

  it('is not held when the same action is called again (a new count)', async () => {
    const { orch, provider, running, settle } = setup([
      ASK,
      turn(say('s2', 'ten it is'), act('a2', 'gather', { name: 'oak_log', count: 10 })),
      turn(say('s3', 'got them')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, 'make it 10')
    await settle()
    running.gather('gathered 10/10 oak_log')
    await settle()
    for (const c of provider.calls) { expect(held(c)).toBe(false); expect(switched(c)).toBe(false) }
  })

  it('is not held when that turn clears the goal', async () => {
    const { orch, provider, settle } = setup([
      ASK,
      turn(say('s2', 'ok'), act('st', 'stop'), act('c1', 'clearGoal', { text: 'Get 8 logs' }), act('m1', 'goTo', { player: 'Steve' })),
      turn(say('s3', 'here')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, CALL_OFF)
    await settle()
    const last = provider.calls[provider.calls.length - 1]
    expect(held(last)).toBe(false)
    expect(switched(last)).toBe(false)
    expect(since(last)).toBe(false)
  })

  it('setting the task again picks it back up', async () => {
    const { orch, provider, settle } = setup([
      ASK,
      turn(say('s2', 'ok holding'), act('st', 'stop')),
      turn(say('s3', 'back on it'), act('g2', 'setGoal', { text: DOCK, for_player: true }), act('a2', 'gather', { name: 'oak_log', count: 8 })),
      turn(say('s4', 'lol')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, 'wait hold on')
    await settle()
    await hear(orch, 'ok go get them after all')
    await settle()
    await hear(orch, 'haha')
    await settle()
    const last = provider.calls[provider.calls.length - 1]
    expect(held(last)).toBe(false)
  })

  it('starting an action for it again picks it back up, without setGoal', async () => {
    const { orch, provider, settle } = setup([
      ASK,
      turn(say('s2', 'ok holding'), act('st', 'stop')),
      turn(say('s3', 'back on it'), act('a2', 'gather', { name: 'oak_log', count: 8 })),
      turn(say('s4', 'lol')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, 'wait hold on')
    await settle()
    await hear(orch, 'ok go get them after all')
    await settle()
    await hear(orch, 'haha')
    await settle()
    const last = provider.calls[provider.calls.length - 1]
    expect(held(last)).toBe(false)
    expect(switched(last)).toBe(false)
  })

  it('a walk to the player does not pick a held task back up', async () => {
    const { orch, provider, settle } = setup([
      ASK,
      turn(say('s2', 'ok holding'), act('st', 'stop')),
      turn(say('s3', 'coming'), act('m1', 'goTo', { player: 'Steve' })),
      turn(say('s4', 'lol')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, 'wait hold on')
    await settle()
    await hear(orch, 'come here')
    await settle()
    await hear(orch, 'haha')
    await settle()
    expect(held(provider.calls[provider.calls.length - 1])).toBe(true)
  })
})

describe('the player\'s open task on later turns', () => {
  it('shows what they said since asking for it', async () => {
    const { orch, provider, running, settle } = setup([
      ASK,
      turn(say('s2', 'dirt, obviously')),
      turn(say('s3', 'got them')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, 'whats ur favorite block')
    await settle()
    running.gather('gathered 8/8 oak_log')
    await settle()
    const last = provider.calls[provider.calls.length - 1]
    expect(since(last)).toBe(true)
    expect(lastUserText(last)).toContain('they said \\"whats ur favorite block\\". If that calls it off or changes it, call clearGoal on it, and in this same turn still do what they asked for now, such as going to them if they asked you to come over.')
    // The line that asked for it is not "since".
    expect(lastUserText(last)).not.toContain('they said \\"get me like 8 logs')
  })

  it('is not on the turn that answers their line, only on the turns after it', async () => {
    const { orch, provider, running, settle } = setup([
      ASK,
      turn(say('s2', 'dirt, obviously')),
      turn(say('s3', 'got them')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    const before = provider.calls.length
    await hear(orch, 'whats ur favorite block')
    await settle()
    const answering = provider.calls[before]
    expect(lastUserText(answering)).toContain('whats ur favorite block')
    expect(since(answering)).toBe(false)
    running.gather('gathered 8/8 oak_log')
    await settle()
    expect(since(provider.calls[provider.calls.length - 1])).toBe(true)
  })

  it('is not on the call-off turn when they said something else before it', async () => {
    const { orch, provider, settle } = setup([
      ASK,
      turn(say('s2', 'dirt, obviously')),
      turn(say('s3', 'ok coming'), act('m1', 'goTo', { player: 'Steve' })),
      turn(say('s4', 'here')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, 'whats ur favorite block')
    await settle()
    const before = provider.calls.length
    await hear(orch, CALL_OFF)
    await settle()
    const answering = provider.calls[before]
    expect(lastUserText(answering)).toContain('forget the logs')
    expect(since(answering)).toBe(false)
  })

  it('counts a line sent while she was still answering the ask', async () => {
    let orchRef = null
    const { orch, provider, running, settle } = setup([
      // "nvm" lands while the turn that sets the task is still thinking.
      async () => { await new Promise((r) => setTimeout(r, 3)); orchRef.recordIncomingChat('Steve', 'nvm actually'); await new Promise((r) => setTimeout(r, 3)); return ASK },
      turn(say('s3', 'got them')),
    ])
    orchRef = orch
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await settle()
    running.gather('gathered 8/8 oak_log')
    await settle()
    const last = provider.calls[provider.calls.length - 1]
    expect(lastUserText(last)).toContain('they said \\"nvm actually\\"')
  })

  it('says nothing before they have said anything more', async () => {
    const { orch, provider, running, settle } = setup([ASK, turn(say('s3', 'got them'))])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    running.gather('gathered 8/8 oak_log')
    await settle()
    for (const c of provider.calls) expect(lastUserText(c)).not.toContain('Since they asked for it')
  })
})

describe('a task she cleared on the player\'s line', () => {
  const cleared = (call) => lastUserText(call).includes(`cleared: Steve's task \\"Get 8 logs for Steve's dock.`)
  it('is noted on the next turns with the line, then not after a few minutes', async () => {
    const cfg = config()
    cfg.memory.cleared_task_note_ms = 60_000
    const { orch, provider, settle } = setup([
      ASK,
      turn(say('s2', 'ok'), act('st', 'stop'), act('c1', 'clearGoal', { text: 'Get 8 logs' }), act('m1', 'goTo', { player: 'Steve' })),
      turn(say('s3', 'here')),
      turn(say('s4', 'lol')),
    ], cfg)
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    await hear(orch, CALL_OFF)
    await settle()
    const after = provider.calls[2]
    expect(cleared(after)).toBe(true)
    expect(lastUserText(after)).toContain(`after they said \\"${CALL_OFF}\\". Nothing is owed for it now: do not hand anything over for it or set it again unless they ask for it again.`)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    await hear(orch, 'haha')
    await settle()
    expect(cleared(provider.calls[provider.calls.length - 1])).toBe(false)
  })

  it('is not noted when the clear rides a hand-over (the task finishing)', async () => {
    const { orch, provider, running, settle } = setup([
      ASK,
      turn(say('s2', 'here you go'), act('gv', 'give', { item: 'oak_log', count: 8, player: 'Steve' }), act('c1', 'clearGoal', { text: 'Get 8 logs' })),
      turn(say('s3', 'np')),
    ])
    await hear(orch, 'get me like 8 logs, i wanna build a dock')
    running.gather('gathered 8/8 oak_log')
    await settle()
    await hear(orch, 'ok give them to me')
    await settle()
    for (const c of provider.calls) expect(cleared(c)).toBe(false)
  })
})

describe('renderHeartbeat with held tasks', () => {
  const now = Date.parse('2026-10-22T10:00:00Z')
  const goals = [
    `- [2026-10-22T10:01:00.000Z] (player task) ${DOCK}`,
    '- [2026-10-22T10:02:00.000Z] (player task) Bring Steve a stack of torches.',
  ].join('\n')
  it('puts a held task under its own head, with the line she stopped on', () => {
    const out = renderHeartbeat(2, goals, '', {
      sessionStartMs: now,
      heldTask: (l) => (l.includes('dock') ? { who: 'Steve', line: CALL_OFF } : null),
    })
    expect(out).toContain(`${PLAYER_TASKS_HEAD}\n- [2026-10-22T10:02:00.000Z] (player task) Bring Steve a stack of torches.`)
    expect(out).toContain(`${PLAYER_TASKS_HELD_HEAD}\n- [2026-10-22T10:01:00.000Z] (player task) ${DOCK} (you stopped it when Steve said "${CALL_OFF}")`)
    expect(out).not.toMatch(/[â€”â€“]/)
  })
  it('with every task held, offers no new project', () => {
    const out = renderHeartbeat(2, goals.split('\n')[0], 'make a furnace', { sessionStartMs: now, heldTask: () => ({ who: 'Steve', line: CALL_OFF }) })
    expect(out).not.toContain('No active goals yet')
    expect(out).not.toContain(PLAYER_TASKS_HEAD)
  })
  it('reaches the seed through composeSeedBlocks', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sei-p22-seed-'))
    try {
      const hb = path.join(tmp, 'HEARTBEAT.md')
      await fs.writeFile(hb, `# Heartbeat\n${goals}\n`)
      const blocks = await composeSeedBlocks({
        sessionState: { playerData: () => ({}) },
        playerStore: { formatPlayerSeedBlock: () => 'PLAYER' },
        config: { memory: { heartbeat_md_path: hb }, persona: { proactiveness: 2 } },
        eventText: 'Event: sei:idle',
        snapshotText: 'pos: 0,64,0',
        sessionStartMs: now,
        heldTask: (l) => (l.includes('dock') ? { who: 'Steve', line: CALL_OFF } : null),
      })
      const text = blocks.find((b) => b.name === 'heartbeat')?.text ?? ''
      expect(text).toContain(`${PLAYER_TASKS_HELD_HEAD}\n- [2026-10-22T10:01:00.000Z] (player task) ${DOCK} (you stopped it when Steve said`)
    } finally { await fs.rm(tmp, { recursive: true, force: true }) }
  })
  it('is unchanged without holds', () => {
    expect(renderHeartbeat(2, goals, '', { sessionStartMs: now })).toBe(renderHeartbeat(2, goals, '', { sessionStartMs: now, heldTask: () => null }))
  })
})




