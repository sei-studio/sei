// 261115 (quality pass 56): a fight that lands while she is busy with a long
// action of her own.
//
// Scorecard 11-14 (night_social-03): she was running shelter() when a zombie
// went for the player ("theres a zombie!! kill it") and then hit her. The
// defend turn said "you are ALREADY swinging at it on reflex, so you do not
// need to call attackEntity", the hit turn said "your reflexes swing back on
// their own if you stand your ground", and both said the shelter "keeps
// running while you deal with this". She said "im on it" and kept building.
// While an action runs it moves her and holds its own item (combat.js skips
// the weapon swap then), so those reflex swings were bare-handed pokes.
// The mid-action delivery now tells the turn which action is in the way
// (busyAction) and the hit / defend text says to fight with attackEntity.
// A background action (follow: the reflex pauses the trail and fights with
// the weapon) and a running fight keep the old text.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { eventAddendum, NUDGES, ATTACKED_ADDENDUM } from './promptLibrary.js'

describe('pass 56 busy-action fight text', () => {
  const defend = { attackerLabel: 'zombie', attackerKind: 'defend', ownerLabel: 'Alex', distance: 5, engaged: true }
  const hit = { attackerLabel: 'zombie', attackerKind: 'hostile_mob' }

  it('a defend turn while an action runs does not say the reflex has it', () => {
    const t = eventAddendum('sei:attacked', { ...defend, busyAction: 'shelter' })
    expect(t).not.toMatch(/ALREADY swinging/)
    expect(t).not.toMatch(/do not need to call attackEntity/)
    expect(t).toMatch(/Call attackEntity on it/)
    expect(t).toMatch(/replaces shelter/)
    expect(t).not.toMatch(/—/)
  })

  it('a defend turn with nothing running (or the fight action on it) keeps its text', () => {
    expect(eventAddendum('sei:attacked', defend)).toBe(eventAddendum('sei:attacked', { ...defend, busyAction: null }))
    expect(eventAddendum('sei:attacked', defend)).toMatch(/ALREADY swinging/)
    const onIt = { ...defend, actionOnIt: true, busyAction: 'shelter' }
    expect(eventAddendum('sei:attacked', onIt)).toBe(eventAddendum('sei:attacked', { ...defend, actionOnIt: true }))
  })

  it('a mob hit while an action runs says the action is in the way and how to fight', () => {
    const t = eventAddendum('sei:attacked', { ...hit, busyAction: 'gather 3 oak_log' })
    expect(t).toMatch(/^Interrupted — zombie hit you\. TELL THE PLAYER/)
    expect(t).not.toMatch(/swing back on their own if you stand your ground/)
    expect(t).toMatch(/gather 3 oak_log is still running/)
    expect(t).toMatch(/call attackEntity on it \(that replaces gather 3 oak_log\)/)
  })

  it('a mob hit with nothing running, unarmed, or from a player keeps its text', () => {
    expect(eventAddendum('sei:attacked', hit)).toBe(ATTACKED_ADDENDUM('zombie', 'hostile_mob'))
    expect(eventAddendum('sei:attacked', hit)).toMatch(/swing back on their own if you stand your ground/)
    expect(eventAddendum('sei:attacked', { ...hit, unarmed: true, busyAction: 'shelter' }))
      .toBe(eventAddendum('sei:attacked', { ...hit, unarmed: true }))
    const pvp = { attackerLabel: 'Alex', attackerKind: 'player' }
    expect(eventAddendum('sei:attacked', { ...pvp, busyAction: 'shelter' })).toBe(eventAddendum('sei:attacked', pvp))
  })

  it('the mid-action tail drops "keeps running while you deal with this" only when busy', () => {
    const plain = NUDGES.attackMidAction({ action: 'follow Alex', stopTool: 'unfollow' })
    expect(plain).toContain('It keeps running while you deal with this.')
    const busy = NUDGES.attackMidAction({ action: 'shelter', stopTool: 'stop', busy: true })
    expect(busy).not.toContain('while you deal with this')
    expect(busy).toContain("You're currently: shelter.")
    expect(busy).toContain('call stop')
  })
})

// ---- orchestrator: which mid-action deliveries are "busy" ------------------

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
      return r
    },
  }
}

function makeAdapter() {
  const seen = []
  const adapter = {
    listActions: () => ['gather', 'follow', 'attackEntity'],
    getActionSchema: () => z.object({ name: z.string().optional(), player: z.string().optional(), entity: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: (ev, d) => {
      if (ev !== 'sei:attacked') return ''
      seen.push(d)
      return eventAddendum(ev, d)
    },
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, args, opts) => new Promise((resolve) => {
      opts?.signal?.addEventListener?.('abort', () => resolve(`${name} aborted`), { once: true })
    }),
  }
  return { adapter, seen }
}

const config = () => ({
  player_username: 'Steve',
  preferred_name: 'Steve',
  persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
  anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
  llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
  memory: {
    memory_md_path: path.join(os.tmpdir(), `sei-pass56-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
    iteration_cap: 30,
  },
})
const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const flush = () => new Promise((r) => setTimeout(r, 0))
const lastUserText = (call) => {
  const u = [...(call?.messages ?? [])].reverse().find((m) => m.role === 'user')
  return (u?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}
const start = (name, input) => ({ text: '', toolUses: [{ id: 'a1', name, input }] })

async function hitDuring(name, input) {
  _setTickIntervalForTests(10_000_000)
  const provider = makeProvider([start(name, input), { text: '', toolUses: [] }])
  const { adapter, seen } = makeAdapter()
  const orch = createOrchestrator({ adapter, config: config(), reenqueue: () => {}, _anthropicOverride: provider })
  await orch.handleDispatch('sei:chat_received', chat('go'))
  await orch.handleDispatch('sei:attacked', { attackerLabel: 'zombie', attackerKind: 'hostile_mob' })
  await flush()
  return { orch, provider, seen, text: lastUserText(provider.calls[1]) }
}

describe('pass 56 mid-action delivery marks a busy action', () => {
  it('a hit during gather names gather as the action in the way', async () => {
    const { orch, seen, text } = await hitDuring('gather', { name: 'oak_log' })
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
    expect(seen.at(-1).busyAction).toMatch(/^gather/)
    expect(text).toMatch(/gather oak_log is still running/)
    expect(text).not.toContain('It keeps running while you deal with this.')
  })

  it('a hit during follow (a background action) keeps the old text', async () => {
    const { seen, text } = await hitDuring('follow', { player: 'Steve' })
    expect(seen.at(-1).busyAction).toBeUndefined()
    expect(text).toContain('swing back on their own if you stand your ground')
    expect(text).toContain('It keeps running while you deal with this.')
  })

  it('a hit during the fight action itself keeps the old text', async () => {
    const { seen, text } = await hitDuring('attackEntity', { entity: 'zombie' })
    expect(seen.at(-1)?.busyAction).toBeUndefined()
    expect(text).not.toMatch(/is still running/)
  })
})

// ---- the fight's result names the action it cut short ----------------------

function toolResultTexts(calls) {
  const out = []
  for (const c of calls) for (const m of c?.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === 'tool_result') out.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content))
  }
  return out
}

function makeFightAdapter() {
  const adapter = makeAdapter().adapter
  adapter.executeAction = (name, args, opts) => {
    if (name === 'attackEntity') return Promise.resolve('killed zombie (3 hits)')
    return new Promise((resolve) => {
      opts?.signal?.addEventListener?.('abort', () => resolve(`${name} aborted`), { once: true })
    })
  }
  return adapter
}

describe('pass 56 fight that replaced a long action', () => {
  it('the kill result says the gather was cut short', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      start('gather', { name: 'oak_log' }),
      { text: '', toolUses: [{ id: 'k1', name: 'attackEntity', input: { entity: 'zombie' } }] },
      { text: '', toolUses: [] },
      { text: '', toolUses: [] },
    ])
    const orch = createOrchestrator({ adapter: makeFightAdapter(), config: config(), reenqueue: (e, d) => { if (e === 'sei:action_complete') queueMicrotask(() => orch.handleDispatch(e, d)) }, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('go'))
    await orch.handleDispatch('sei:attacked', { attackerLabel: 'zombie', attackerKind: 'hostile_mob' })
    for (let i = 0; i < 10; i++) await flush()
    const kill = toolResultTexts(provider.calls).find((t) => t.includes('killed zombie'))
    expect(kill).toBeTruthy()
    expect(kill).toContain('This fight cut short your gather oak_log before it was done')
  })

  it('a fight with no busy action behind it gets no note', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      start('attackEntity', { entity: 'zombie' }),
      { text: '', toolUses: [] },
      { text: '', toolUses: [] },
    ])
    const orch = createOrchestrator({ adapter: makeFightAdapter(), config: config(), reenqueue: (e, d) => { if (e === 'sei:action_complete') queueMicrotask(() => orch.handleDispatch(e, d)) }, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill it'))
    for (let i = 0; i < 10; i++) await flush()
    const kill = toolResultTexts(provider.calls).find((t) => t.includes('killed zombie'))
    expect(kill).toBeTruthy()
    expect(kill).not.toContain('cut short')
  })
})
