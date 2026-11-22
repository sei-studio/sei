// 261011: a hit that lands while an action runs is delivered mid-action.
//
// Quality eval 2026-10-11 (combat_night): every throttled sei:attacked tore
// the loop down, so attackEntity was aborted by the next hit 10 times, the
// goTo back to a 3 hp player was cut, and each hit forced a fresh warning
// ("drowned on me, swinging back, stay put" a dozen times). Now the hit is
// delivered like a player line (the action keeps running), further hits
// within 10s are coalesced, and a hit soon after she already spoke about the
// fight says so.
//
// Harness mirrors orchestrator.stopVsEndLoop.test.js.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

function makeProvider(script) {
  let i = 0
  const calls = []
  return {
    calls,
    capabilities: { vision: false, cached: false, local: false },
    buildCachedSystem: (blocks) => blocks,
    setAuthToken() {},
    setBackend() {},
    async call(args) {
      calls.push(args)
      const r = script[Math.min(i, script.length - 1)]
      i += 1
      if (typeof r === 'function') return r(args)
      return r
    },
  }
}

// gather runs until aborted (a long foreground job); follow never settles
// (background trail); unfollow and goTo settle at once.
function makeAdapter() {
  const executed = []
  const aborted = []
  const adapter = {
    listActions: () => ['gather', 'goTo', 'follow', 'unfollow'],
    getActionSchema: () => z.object({ name: z.string().optional(), player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: (ev, d) => (ev === 'sei:attacked' ? `Interrupted: ${d?.attackerLabel ?? 'something'} hit you. Tell the player.` : ''),
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, args, opts) => {
      executed.push(name)
      if (name === 'gather') {
        return new Promise((resolve) => {
          const sig = opts?.signal
          if (sig) sig.addEventListener('abort', () => { aborted.push(name); resolve('aborted after 2/12 oak_log') }, { once: true })
        })
      }
      if (name === 'follow') return new Promise(() => {})
      return Promise.resolve(`${name} ok`)
    },
  }
  return { adapter, executed, aborted }
}

function makeConfig() {
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-midattack-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
    },
  }
}

const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const flush = () => new Promise((r) => setTimeout(r, 0))
const gatherTurn = { text: '', toolUses: [{ id: 'g1', name: 'gather', input: { name: 'oak_log' } }] }

function toolResultsOf(call) {
  const out = []
  for (const m of call?.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === 'tool_result') out.push(b)
  }
  return out
}


const hit = (label = 'zombie') => ({ attackerLabel: label, attackerKind: 'mob' })
const lastUserText = (call) => {
  const msgs = call?.messages ?? []
  const u = [...msgs].reverse().find((m) => m.role === 'user')
  return (u?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

describe('261011 mid-action attack delivery', () => {
  it('a hit during gather is delivered without aborting it; a second hit within 10s is coalesced', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'zombie on me, swinging' } }] },
      { text: '', toolUses: [] },
    ])
    const { adapter, aborted } = makeAdapter()
    const reenqueued = []
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: (e, d) => reenqueued.push(e), _anthropicOverride: provider })

    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:attacked', hit())
    await flush()
    expect(aborted).toEqual([])
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
    expect(provider.calls.length).toBe(2)
    const text = lastUserText(provider.calls[1])
    expect(text).toContain('zombie hit you')
    expect(text).toContain("You're currently: gather")
    expect(text).toContain('call stop')
    expect(adapter.chat).toHaveBeenCalledWith('zombie on me, swinging')
    // no teardown re-fire of the attack
    expect(reenqueued).not.toContain('sei:attacked')

    await orch.handleDispatch('sei:attacked', hit())
    expect(provider.calls.length).toBe(2) // coalesced
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })

  it('a hit inside the window still gets through when health fell by 4 or more', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [] },
      { text: '', toolUses: [] },
      { text: '', toolUses: [] },
    ])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:attacked', { ...hit(), health: 18 })
    await flush()
    expect(provider.calls.length).toBe(2)
    await orch.handleDispatch('sei:attacked', { ...hit(), health: 16 })
    expect(provider.calls.length).toBe(2) // small drop: coalesced
    await orch.handleDispatch('sei:attacked', { ...hit(), health: 13 })
    await flush()
    expect(provider.calls.length).toBe(3) // 18 -> 13: delivered
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })

  it('the model can answer a mid-action hit by switching actions (R2 replaces the gather)', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      gatherTurn,
      { text: '', toolUses: [{ id: 'go1', name: 'goTo', input: {} }] },
      { text: '', toolUses: [] },
    ])
    const { adapter, aborted, executed } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:attacked', hit())
    await flush()
    expect(aborted).toEqual(['gather'])
    expect(executed).toContain('goTo')
  })

  it('a fresh attack turn soon after she spoke about the fight says she already told the player', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'zombie on me' } }] },
      { text: '', toolUses: [] },
    ])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:attacked', hit())
    expect(lastUserText(provider.calls[0])).not.toContain('You already told the player')
    expect(orch.currentLoop).toBeNull()
    await orch.handleDispatch('sei:attacked', hit())
    expect(lastUserText(provider.calls[1])).toContain('You already told the player about this fight')
  })
  // 261018 (pass 17): night_social-01. Her reply said what she was doing and
  // a defend heads-up landed right after; that turn now shows her the line.
  it('a mid-action heads-up right after a reply quotes the line she just said', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [
        { id: 's0', name: 'say', input: { text: 'going after the zombie now' } },
        { id: 'g1', name: 'gather', input: { name: 'oak_log' } },
      ] },
      { text: '', toolUses: [] },
    ])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('are you ok??'))
    await orch.handleDispatch('sei:attacked', hit())
    await flush()
    expect(provider.calls.length).toBe(2)
    const text = lastUserText(provider.calls[1])
    expect(text).toMatch(/Your last line to the player, \d+s ago, was "going after the zombie now"/)
    expect(text).not.toContain('You already told the player about this fight')
  })

  it('a heads-up with no line of hers in the last 15s quotes nothing', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([gatherTurn, { text: '', toolUses: [] }])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:attacked', hit())
    await flush()
    expect(lastUserText(provider.calls[1])).not.toContain('Your last line to the player')
  })

  it('a reflex / defend heads-up does not open a window that swallows the next real hit', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([gatherTurn, { text: '', toolUses: [] }])
    const { adapter } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    await orch.handleDispatch('sei:attacked', { attackerLabel: 'Steve', attackerKind: 'defend' })
    await flush()
    expect(provider.calls.length).toBe(2)
    await orch.handleDispatch('sei:attacked', { ...hit(), health: 19 })
    await flush()
    expect(provider.calls.length).toBe(3)
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })

  it('a second hit while the mid-action reaction call is parked is swallowed, not torn down', async () => {
    _setTickIntervalForTests(10_000_000)
    let release
    const parked = new Promise((r) => { release = r })
    let claimed = null
    const provider = makeProvider([
      gatherTurn,
      async () => {
        claimed = orch.handlePreempt('sei:attacked', { ...hit('skeleton'), health: 17 })
        await parked
        return { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'two of them now' } }] }
      },
      { text: '', toolUses: [] },
    ])
    const { adapter, aborted } = makeAdapter()
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('grab some logs'))
    const p = orch.handleDispatch('sei:attacked', { ...hit(), health: 19 })
    await flush()
    release()
    await p
    await flush()
    expect(claimed).toBe(true)
    expect(aborted).toEqual([])
    expect(adapter.chat).toHaveBeenCalledWith('two of them now')
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
  })
})




