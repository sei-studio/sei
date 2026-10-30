// 261029: a talk-only turn on a provider whose model takes tool calls one
// step at a time (capabilities.toolSteps, the ChatGPT-plan provider) gets one
// more call with that turn's outputs, so the action it meant for its next
// step runs ("follow me" -> say("on your six") -> follow). Providers without
// the flag end the loop on a say()-only turn exactly as before.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { NUDGES } from './promptLibrary.js'
import { createChatgptProvider } from './llm/chatgptProvider.js'

function makeProvider(script, capabilities) {
  let i = 0
  const calls = []
  return {
    calls,
    capabilities,
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
      memory_md_path: path.join(os.tmpdir(), `sei-steps-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-steps-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

const STEPS = { vision: false, cached: false, local: false, toolSteps: true }
const say = (id, text) => ({ id, name: 'say', input: { text } })
const turn = (...toolUses) => ({ text: '', toolUses })
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const lastUser = (call) => (call.messages ?? []).slice(-1)[0]

describe('orchestrator: talk-only turns on a step-wise provider', () => {
  it('sends the say() output back once and runs the action from the next step', async () => {
    _setTickIntervalForTests(10_000_000)
    const executed = []
    const provider = makeProvider([
      turn(say('s1', 'on your six')),
      turn({ id: 'a1', name: 'follow', input: { player: 'Steve' } }),
    ], STEPS)
    const adapter = makeAdapter(executed)
    const orch = createOrchestrator({ adapter, config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('follow me'))
    expect(provider.calls.length).toBe(2)
    // The extra call carries the say() output and no other added text.
    const pending = lastUser(provider.calls[1])
    expect(JSON.stringify(pending)).toContain('"tool_use_id":"s1"')
    expect(JSON.stringify(pending)).not.toContain('"name":"unanswered"')
    // Its output says the line was heard and the step is for an action.
    const out = pending.content.find(b => b.type === 'tool_result' && b.tool_use_id === 's1')
    expect(out.content).toBe(`said. ${NUDGES.talkOnlyNextStep}`)
    expect(executed).toEqual(['follow'])
    expect(adapter.chat).toHaveBeenCalledTimes(1)
  })

  it('ends the loop when the next step calls nothing', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([turn(say('s1', 'lol same')), { text: 'done', toolUses: [] }], STEPS)
    const adapter = makeAdapter()
    const orch = createOrchestrator({ adapter, config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('creepers are the best mob'))
    expect(provider.calls.length).toBe(2)
    expect(orch.currentLoop).toBeNull()
    expect(adapter.chat).toHaveBeenCalledTimes(1)
  })

  it('never gives two extra steps in a row', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      turn(say('s1', 'ok')),
      turn({ id: 'r1', name: 'remember', input: { text: 'Steve likes creepers' } }),
      turn(say('s3', 'unreachable')),
    ], STEPS)
    const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('remember i like creepers'))
    expect(provider.calls.length).toBe(2)
    expect(orch.currentLoop).toBeNull()
  })

  it('is off for a provider without toolSteps (the Anthropic default)', async () => {
    _setTickIntervalForTests(10_000_000)
    for (const caps of [undefined, { vision: true, cached: true, local: false, serverWebSearch: true }]) {
      const provider = makeProvider([turn(say('s1', 'on your six')), turn(say('s2', 'unreachable'))], caps)
      const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
      await orch.handleDispatch('sei:chat_received', line('follow me'))
      expect(provider.calls.length).toBe(1)
      expect(orch.currentLoop).toBeNull()
    }
  })

  it('does not fire when the turn ended itself, started an action, or was not for the player', async () => {
    _setTickIntervalForTests(10_000_000)
    const firsts = [
      turn(say('s1', 'nah'), { id: 'e1', name: 'end_loop', input: {} }),
      turn(say('s1', 'on it'), { id: 'a1', name: 'gather', input: { name: 'oak_log' } }),
    ]
    for (const first of firsts) {
      const provider = makeProvider([first, turn(say('s9', 'unreachable'))], STEPS)
      const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
      await orch.handleDispatch('sei:chat_received', line('get some wood'))
      expect(provider.calls.length).toBe(1)
    }
    const provider = makeProvider([turn(say('s1', 'pretty sunset')), turn(say('s9', 'unreachable'))], STEPS)
    const orch = createOrchestrator({ adapter: makeAdapter(), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:idle', {})
    expect(provider.calls.length).toBe(1)
  })

  it('does not fire while a foreground action runs', async () => {
    _setTickIntervalForTests(10_000_000)
    const executed = []
    const provider = makeProvider([
      turn(say('s1', 'on it'), { id: 'a1', name: 'gather', input: { name: 'oak_log' } }),
      turn(say('s2', 'two so far')),
      turn(say('s9', 'unreachable')),
    ], STEPS)
    const orch = createOrchestrator({ adapter: makeAdapter(executed), config: config(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', line('get some wood'))
    expect(provider.calls.length).toBe(1)
    await orch.handleDispatch('sei:chat_received', line('how many so far?'))
    expect(provider.calls.length).toBe(2)
    expect(executed).toEqual(['gather'])
  })
})

describe('chatgpt provider: toolSteps capability', () => {
  it('is set on the ChatGPT-plan provider', () => {
    const p = createChatgptProvider({ llm: { providers: { chatgpt: { api_key: 'x' } } } }, { fetchImpl: async () => { throw new Error('no network') } })
    expect(p.capabilities.toolSteps).toBe(true)
    p.dispose?.()
  })
})
