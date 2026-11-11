// 261111 (quality pass 51): a turn written against a fight that changed
// while it was being written is not run, and the "already told the player
// about this fight" note does not carry over to a new mob after a kill.
//
// combat_night evals (11-06 to 11-10): 10 attackEntity calls went out on a mob
// that had died 1-2s earlier, during the LLM call, with lines like "i'm on
// the spider" that the judge marked off. Like a turn written by a body that
// died (deathPending), such a turn is dropped and the next call sees the
// fight as it is now.
//
// Harness mirrors orchestrator.midActionAttack.test.js.

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

function makeAdapter({ staleTurn, sameFight } = {}) {
  const executed = []
  const staleAsked = []
  const adapter = {
    listActions: () => ['attackEntity', 'goTo'],
    getActionSchema: () => z.object({ entity: z.string().optional(), times: z.number().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: (ev, d) => (ev === 'sei:attacked' ? `Interrupted: ${d?.attackerLabel ?? 'something'} hit you.` : ''),
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, args) => {
      executed.push({ name, args })
      return Promise.resolve(`${name} ok`)
    },
  }
  if (staleTurn) {
    adapter.staleTurn = (toolUses, sinceMs) => {
      staleAsked.push({ names: toolUses.map((u) => u.name), sinceMs })
      return staleTurn(toolUses, sinceMs)
    }
  }
  if (sameFight) adapter.sameFight = sameFight
  return { adapter, executed, staleAsked }
}

function makeConfig() {
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-staleturn-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
    },
  }
}

const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const say = (id, text) => ({ id, name: 'say', input: { text } })
const attack = (id, entity = 'spider') => ({ id, name: 'attackEntity', input: { entity, times: 8 } })
const lastUserText = (call) => {
  const msgs = call?.messages ?? []
  const u = [...msgs].reverse().find((m) => m.role === 'user')
  return (u?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}
function toolResultsOf(call) {
  const out = []
  for (const m of call?.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === 'tool_result') out.push(b)
  }
  return out
}

describe('261111 a turn written before the fight changed is not run', () => {
  it('drops the say and the attack and asks again with the fight as it is now', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [say('s1', "i'm on the spider"), attack('a1')] },
      { text: '', toolUses: [say('s2', 'got it, spider is down')] },
    ])
    let first = true
    const { adapter, executed, staleAsked } = makeAdapter({
      staleTurn: () => (first ? ((first = false), { reason: 'the spider you went for died 1s ago' }) : null),
    })
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill that spider'))

    expect(adapter.chat).not.toHaveBeenCalledWith("i'm on the spider")
    expect(adapter.chat).toHaveBeenCalledWith('got it, spider is down')
    expect(executed.filter((e) => e.name === 'attackEntity')).toEqual([])
    expect(provider.calls).toHaveLength(2)
    // It is asked with the time of the snapshot the turn was written from.
    expect(staleAsked[0].sinceMs).toBeGreaterThan(0)
    expect(staleAsked[0].sinceMs).toBeLessThanOrEqual(Date.now())

    const text = lastUserText(provider.calls[1])
    expect(text).toContain('Nothing from your last turn ran')
    expect(text).toContain('the spider you went for died 1s ago')
    expect(text.split('\n')[0]).not.toMatch(/—/)
    const results = toolResultsOf(provider.calls[1])
    expect(results.find((r) => r.tool_use_id === 's1')?.content).toMatch(/^not said/)
    expect(results.find((r) => r.tool_use_id === 'a1')?.content).toMatch(/^not run/)
  })

  it('a turn the adapter does not call stale runs as before', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [say('s1', "i'm on the spider"), attack('a1')] },
      { text: '', toolUses: [] },
    ])
    const { adapter, executed } = makeAdapter({ staleTurn: () => null })
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill that spider'))
    expect(adapter.chat).toHaveBeenCalledWith("i'm on the spider")
    expect(executed.map((e) => e.name)).toEqual(['attackEntity'])
  })

  it('drops at most two turns per loop, so a wrong answer cannot stall her', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [say('s1', 'one'), attack('a1')] },
      { text: '', toolUses: [say('s2', 'two'), attack('a2')] },
      { text: '', toolUses: [say('s3', 'three'), attack('a3')] },
      { text: '', toolUses: [] },
    ])
    const { adapter, executed } = makeAdapter({ staleTurn: () => ({ reason: 'the spider you went for died 1s ago' }) })
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill that spider'))
    expect(adapter.chat).not.toHaveBeenCalledWith('one')
    expect(adapter.chat).not.toHaveBeenCalledWith('two')
    expect(adapter.chat).toHaveBeenCalledWith('three')
    expect(executed.map((e) => e.name)).toEqual(['attackEntity'])
  })

  it('an adapter whose staleTurn throws is treated as not stale', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [say('s1', 'on it'), attack('a1')] },
      { text: '', toolUses: [] },
    ])
    const { adapter, executed } = makeAdapter({ staleTurn: () => { throw new Error('boom') } })
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('kill that spider'))
    expect(adapter.chat).toHaveBeenCalledWith('on it')
    expect(executed.map((e) => e.name)).toEqual(['attackEntity'])
  })
})

describe('261111 the "already told" note follows the mob, not just the clock', () => {
  const zombie = (id) => ({ attackerLabel: 'zombie', attackerKind: 'mob', attacker: { id, name: 'zombie' } })

  it('a hit by a new zombie after the first one died is a new fight', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [say('s1', 'zombie on me')] },
      { text: '', toolUses: [] },
    ])
    const asked = []
    const dead = new Set()
    const { adapter } = makeAdapter({ sameFight: (prev, data) => { asked.push([prev, data?.attacker?.id]); return !dead.has(prev) } })
    const orch = createOrchestrator({ adapter, config: makeConfig(), reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:attacked', zombie(7))
    // Same zombie still around: she already told the player.
    await orch.handleDispatch('sei:attacked', zombie(7))
    expect(lastUserText(provider.calls[1])).toContain('You already told the player about this fight')
    expect(asked.at(-1)).toEqual([7, 7])
    // Zombie 7 died; zombie 8 hits her: no carry-over.
    dead.add(7)
    await orch.handleDispatch('sei:attacked', zombie(8))
    expect(lastUserText(provider.calls[2])).not.toContain('You already told the player about this fight')
    expect(asked.at(-1)).toEqual([7, 8])
  })
})
