// 261018: quality pass 15. "We want natural behavior initiated by the AI,
// rather than hard coded." The pass-14 phrase matchers (isMovementOrder cut
// the running action on "follow me"; isHoldLine plus a hard block held her
// after "stay here") are gone:
//  - a player line mid-action rides the running action into a turn whose
//    frame asks keep-or-switch evenly; the model's own action does the switch
//  - when she answers a line with stop or unfollow, later turns carry a short
//    stay note quoting that line; nothing is blocked
//  - the note ends on new work or a goal from the player's line, or after a
//    few minutes, not on a plain chat line

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { NUDGES } from './promptLibrary.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

afterEach(() => { vi.restoreAllMocks() })

// â”€â”€â”€ orchestrator harness â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// gather runs until settled or aborted; follow never settles (background);
// everything else is instant.
function makeAdapter(executed, running, aborted, snapshotOpts) {
  const ACTIONS = ['gather', 'dig', 'give', 'goTo', 'follow', 'unfollow', 'explore', 'look', 'attackEntity']
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ name: z.string().optional(), item: z.string().optional(), player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: (opts) => { snapshotOpts?.push(opts); return opts?.hideNext ? 'SNAPSHOT' : 'SNAPSHOT\nnext: make a furnace' } }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, _args, opts = {}) => {
      executed.push(name)
      if (name === 'follow') return new Promise(() => {})
      if (name !== 'gather' && name !== 'dig') return Promise.resolve(`${name} ok`)
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
      memory_md_path: path.join(os.tmpdir(), `sei-p15-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p15-hb-${tag}.md`),
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

function setup(script, cfg = config()) {
  _setTickIntervalForTests(10_000_000)
  const executed = []
  const running = {}
  const aborted = []
  const snapshotOpts = []
  const queue = []
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter: makeAdapter(executed, running, aborted, snapshotOpts), config: cfg,
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  const drain = async () => {
    for (let guard = 0; queue.length && guard < 20; guard++) {
      const next = queue.shift()
      if (DRAINED.has(next.event)) await orch.handleDispatch(next.event, next.data)
    }
  }
  return { orch, provider, executed, running, aborted, snapshotOpts, queue, drain }
}

const hasNote = (call) => lastUserText(call).includes('hold: you stopped')

describe('a movement line mid-action is the model\'s call', () => {
  it('"follow me" during a gather is not cut by code; her follow replaces the gather', async () => {
    const { orch, provider, executed, aborted, drain } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'stone' })),
      turn(say('s2', 'coming'), act('f1', 'follow', { player: 'Steve' })),
    ])
    await orch.handleDispatch('sei:chat_received', line('get some stone'))
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
    await orch.handleDispatch('sei:chat_received', line('è·Ÿæˆ‘æ¥'))
    await flush()
    await drain()
    expect(provider.calls.length).toBe(2)
    const text = lastUserText(provider.calls[1])
    expect(text).toContain('è·Ÿæˆ‘æ¥')
    expect(text).toContain('If they ask you to come to them or follow them, or point out where they are, call the action that takes you to them')
    expect(text).not.toContain('KEEP GOING')
    expect(aborted).toEqual(['gather'])
    expect(executed).toEqual(['gather', 'follow'])
  })

  it('a chat line answered in words leaves the gather running', async () => {
    const { orch, aborted } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'stone' })),
      turn(say('s2', 'np')),
    ])
    await orch.handleDispatch('sei:chat_received', line('get some stone'))
    await orch.handleDispatch('sei:chat_received', line('come here when youre done'))
    await flush()
    expect(aborted).toEqual([])
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })
})

describe('the stay note', () => {
  it('after she unfollows on "stop moving", the next turn sees the note, and nothing is blocked', async () => {
    const { orch, provider, executed, drain } = setup([
      turn(say('s1', 'ok'), act('f1', 'follow', { player: 'Steve' })),
      turn(say('s2', 'ok holding still'), act('u1', 'unfollow')),
      turn(say('s3', 'gonna grab some stone'), act('a2', 'gather', { name: 'stone' })),
    ])
    await orch.handleDispatch('sei:chat_received', line('follow me'))
    expect(hasNote(provider.calls[0])).toBe(false)
    await orch.handleDispatch('sei:chat_received', line('stop moving'))
    await flush()
    await drain()
    await flush()
    await drain()
    expect(provider.calls.length).toBe(3)
    expect(hasNote(provider.calls[2])).toBe(true)
    expect(lastUserText(provider.calls[2])).toContain('stop moving')
    // A note, not a block: her own choice still runs.
    expect(executed).toContain('gather')
  })

  it('is set by her stop in answer to a line in any language', async () => {
    const { orch, provider, drain } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'stone' })),
      turn(say('s2', 'å¥½çš„'), act('st', 'stop')),
      turn(say('s3', 'lol')),
    ])
    await orch.handleDispatch('sei:chat_received', line('get some stone'))
    await orch.handleDispatch('sei:chat_received', line('åˆ«åŠ¨'))
    await flush()
    await drain()
    await orch.handleDispatch('sei:chat_received', line('haha nice'))
    await flush()
    await drain()
    const last = provider.calls[provider.calls.length - 1]
    expect(hasNote(last)).toBe(true)
    expect(lastUserText(last)).toContain('åˆ«åŠ¨')
  })

  it('a plain chat line does not end it; new work from the player does', async () => {
    const { orch, provider, running, drain } = setup([
      turn(say('s1', 'ok'), act('f1', 'follow', { player: 'Steve' })),
      turn(say('s2', 'ok'), act('u1', 'unfollow')),
      turn(say('s3', 'staying')),
      turn(say('s4', 'haha')),
      turn(say('s5', 'on it'), act('a1', 'gather', { name: 'oak_log' })),
      turn(say('s6', 'got them')),
    ])
    await orch.handleDispatch('sei:chat_received', line('follow me'))
    await orch.handleDispatch('sei:chat_received', line('stay here'))
    await flush()
    await drain()
    await flush()
    await drain()
    await orch.handleDispatch('sei:chat_received', line('lol'))
    await flush()
    await drain()
    expect(hasNote(provider.calls[provider.calls.length - 1])).toBe(true)
    await orch.handleDispatch('sei:chat_received', line('ok now get wood'))
    await flush()
    await drain()
    expect(running.gather).toBeTypeOf('function')
    const before = provider.calls.length
    running.gather('gathered 4 oak_log')
    await flush()
    await drain()
    await flush()
    expect(provider.calls.length).toBeGreaterThan(before)
    expect(hasNote(provider.calls[provider.calls.length - 1])).toBe(false)
  })

  it('expires after a few minutes', async () => {
    const { orch, provider, drain } = setup([
      turn(say('s1', 'ok'), act('f1', 'follow', { player: 'Steve' })),
      turn(say('s2', 'ok'), act('u1', 'unfollow')),
      turn(say('s3', 'staying')),
      turn(say('s4', 'hi again')),
    ])
    await orch.handleDispatch('sei:chat_received', line('follow me'))
    await orch.handleDispatch('sei:chat_received', line('wait here'))
    await flush()
    await drain()
    await flush()
    await drain()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 181_000)
    await orch.handleDispatch('sei:chat_received', line('hey'))
    await flush()
    await drain()
    expect(hasNote(provider.calls[provider.calls.length - 1])).toBe(false)
  })

  it('stop + look: the idle hold keeps its pre-pass-14 trigger, the note is still set', async () => {
    const { orch, provider, drain } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'stone' })),
      turn(say('s2', 'ok'), act('st', 'stop'), act('l1', 'look')),
      turn(say('s3', 'hm')),
    ])
    await orch.handleDispatch('sei:chat_received', line('get some stone'))
    await orch.handleDispatch('sei:chat_received', line('stop'))
    await flush()
    await drain()
    await flush()
    await drain()
    // look is not unfollow, so (as before pass 14) the idle hold is off and
    // the idle tick reaches the model, which still sees the stay note.
    const before = provider.calls.length
    await orch.handleDispatch('sei:idle', {})
    await flush()
    expect(provider.calls.length).toBe(before + 1)
    expect(hasNote(provider.calls[provider.calls.length - 1])).toBe(true)
  })

  it('a world action she starts on a later turn the player did not start ends it', async () => {
    const { orch, provider, running, drain } = setup([
      turn(say('s1', 'ok'), act('f1', 'follow', { player: 'Steve' })),
      turn(say('s2', 'ok holding still'), act('u1', 'unfollow')),
      // the completion turn after the unfollow: her own project
      turn(say('s3', 'gonna grab some stone'), act('a2', 'gather', { name: 'stone' })),
      turn(say('s4', 'done')),
    ])
    await orch.handleDispatch('sei:chat_received', line('follow me'))
    await orch.handleDispatch('sei:chat_received', line('stop moving'))
    await flush()
    await drain()
    await flush()
    await drain()
    expect(hasNote(provider.calls[2])).toBe(true)
    expect(running.gather).toBeTypeOf('function')
    const before = provider.calls.length
    running.gather('gathered 3 cobblestone')
    await flush()
    await drain()
    await flush()
    expect(provider.calls.length).toBeGreaterThan(before)
    expect(hasNote(provider.calls[provider.calls.length - 1])).toBe(false)
  })

  it('a stationary action on a later turn keeps it', async () => {
    const { orch, provider, drain } = setup([
      turn(say('s1', 'ok'), act('f1', 'follow', { player: 'Steve' })),
      turn(say('s2', 'ok'), act('u1', 'unfollow')),
      turn(act('l1', 'look')),
      turn(say('s4', 'still here')),
    ])
    await orch.handleDispatch('sei:chat_received', line('follow me'))
    await orch.handleDispatch('sei:chat_received', line('stay here'))
    for (let i = 0; i < 3; i++) { await flush(); await drain() }
    expect(provider.calls.length).toBe(4)
    expect(hasNote(provider.calls[3])).toBe(true)
  })

  it('death ends it', async () => {
    const { orch, provider, drain } = setup([
      turn(say('s1', 'ok'), act('f1', 'follow', { player: 'Steve' })),
      turn(say('s2', 'ok'), act('u1', 'unfollow')),
      turn(say('s3', 'staying')),
      turn(say('s4', 'ugh i died')),
    ])
    await orch.handleDispatch('sei:chat_received', line('follow me'))
    await orch.handleDispatch('sei:chat_received', line('wait here'))
    for (let i = 0; i < 2; i++) { await flush(); await drain() }
    expect(hasNote(provider.calls[provider.calls.length - 1])).toBe(true)
    const before = provider.calls.length
    await orch.handleDispatch('sei:death', { reason: 'zombie' })
    for (let i = 0; i < 2; i++) { await flush(); await drain() }
    expect(provider.calls.length).toBeGreaterThan(before)
    expect(hasNote(provider.calls[provider.calls.length - 1])).toBe(false)
  })

  it('a teammate line never sets it', async () => {
    const { orch, provider, drain } = setup([
      turn(say('s1', 'ok'), act('f1', 'follow', { player: 'Steve' })),
      turn(act('u1', 'unfollow')),
      turn(say('s3', 'hm')),
    ])
    orch.setVoiceCall(true)
    await orch.handleDispatch('sei:chat_received', line('follow me'))
    await orch.handleDispatch('sei:chat_received', {
      text: 'stay here', message: 'stay here', username: 'Marv', playerSpoke: false,
      addressed: true, seiChat: true, voice: true, ts: Date.now(),
    })
    for (let i = 0; i < 3; i++) { await flush(); await drain() }
    expect(provider.calls.length).toBeGreaterThanOrEqual(3)
    expect(provider.calls.some(hasNote)).toBe(false)
  })

  it('a group-call line never sets it', async () => {
    const { orch, provider, drain } = setup([
      turn(say('s1', 'ok'), act('f1', 'follow', { player: 'Steve' })),
      turn(say('s2', 'ok'), act('u1', 'unfollow')),
      turn(say('s3', 'hm')),
    ])
    orch.setVoiceCall(true)
    orch.setCompanions(['Marv'])
    const voice = (text) => ({ text, message: text, username: 'Steve', playerSpoke: true, addressed: true, seiChat: true, voice: true, ts: Date.now() })
    await orch.handleDispatch('sei:chat_received', voice('follow me'))
    await orch.handleDispatch('sei:chat_received', voice('stay here'))
    for (let i = 0; i < 3; i++) { await flush(); await drain() }
    expect(provider.calls.length).toBeGreaterThanOrEqual(3)
    expect(provider.calls.some(hasNote)).toBe(false)
  })

  it('reads plainly', () => {
    const t = NUDGES.stayNote({ who: 'Steve', line: 'stay here', secs: 12 })
    expect(t).toContain('12s ago')
    expect(t).toContain('"stay here"')
    expect(t).not.toMatch(/â€”|[A-Z]{4,}/)
  })
})




