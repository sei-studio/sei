// src/bot/brain/orchestrator.ownRepeats.test.js
//
// 261013 (pass6a review): the own_repeats note takes its wording from the kind
// of turn. A reply to the player keeps the full ask (what moved the MC
// repetitive share); an idle seed gets no quote and no ask, only what repeats,
// since the quote silenced proactive idle turns in the persona eval; a
// check-in while an action runs gets the short form.
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
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
      calls.push({ ...args, blocks: JSON.parse(JSON.stringify(args.namedUserBlocks ?? [])) })
      const r = script[Math.min(i, script.length - 1)]
      i += 1
      return typeof r === 'function' ? r(args) : r
    },
  }
}

function makeOrch(script, executeAction = () => Promise.resolve('done'), extraAdapter = {}) {
  const provider = makeProvider(script)
  const adapter = {
    gameName: 'Minecraft',
    listActions: () => ['gather'],
    getActionSchema: () => z.object({ kind: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction,
    gameVocabulary: () => ['oak_log'],
    ...extraAdapter,
  }
  const config = {
    player_username: 'newb',
    preferred_name: 'newb',
    persona: { name: 'Sui', expanded: 'You are a chaotic gremlin.', proactiveness: 2 },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-orch-repeats-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`),
      iteration_cap: 30,
    },
    web: { enabled: false },
  }
  const orch = createOrchestrator({
    adapter, config, reenqueue: () => {},
    sessionState: { playerData: () => ({}), onLoopTerminal: async () => {} },
    playerStore: { formatPlayerSeedBlock: () => 'PLAYER' },
    _anthropicOverride: provider,
  })
  return { orch, provider }
}

const chat = (text) => ({ text, message: text, username: 'newb', playerSpoke: true, ts: Date.now() })
const say = (id, text) => ({ id, name: 'say', input: { text } })
const blockText = (call, name) => call.blocks
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .filter((b) => b?.name === name).map((b) => b.text).join('\n')
const lastTurnText = (call) => call.blocks.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')

const REPLY_ASK = 'do not reuse a joke, comeback, greeting, offer or plan from your recent lines in this one; find something new to say, or say less.'

afterEach(() => { vi.restoreAllMocks() })

describe('own_repeats wording by kind of turn', () => {
  it('idle seed gets no quote, a player line the full ask', async () => {
    _setTickIntervalForTests(10_000_000)
    const { orch, provider } = makeOrch([
      { text: '', toolUses: [say('t1', 'want to go fishing after this?')] },
      { text: '', toolUses: [say('t2', "i'll get the oak trees, keep an eye on me?")] },
      { text: '', toolUses: [say('t3', 'ok!')] },
    ])
    orch.recordIncomingChat('newb', 'hey')
    await orch.handleDispatch('sei:chat_received', chat('hey'))
    await orch.handleDispatch('sei:idle', { quietMs: 20_000 })
    expect(JSON.stringify(provider.calls[1].blocks)).toContain('want to go fishing after this?')
    expect(blockText(provider.calls[1], 'own_repeats')).toBe('')

    orch.recordIncomingChat('newb', 'sure')
    await orch.handleDispatch('sei:chat_received', chat('sure'))
    const reply = blockText(provider.calls[2], 'own_repeats')
    expect(reply).toContain(REPLY_ASK)
  })

  it('a silent check-in mid-action gets the short form', async () => {
    _setTickIntervalForTests(10_000_000)
    let finish
    const { orch, provider } = makeOrch([
      { text: '', toolUses: [say('t1', 'on it, chopping now'), { id: 'g1', name: 'gather', input: { kind: 'oak_log' } }] },
      { text: '', toolUses: [] },
    ], () => new Promise((resolve) => { finish = resolve }))
    orch.recordIncomingChat('newb', 'get wood')
    await orch.handleDispatch('sei:chat_received', chat('get wood'))
    await orch.handleDispatch('sei:action_tick', { elapsedSec: 10 })
    const text = lastTurnText(provider.calls.at(-1))
    expect(text).toContain('Your last line to them was "on it, chopping now". They already heard it, so if you say something this tick, make it new.')
    expect(text).not.toContain(REPLY_ASK)
    finish?.('done')
  })

  // 261021 (pass 21 review): a player line that lands mid-action renders
  // through interruptTurnText, and its reply quote is the four-turn one too.
  it('a player line mid-action quotes her last four turns', async () => {
    _setTickIntervalForTests(10_000_000)
    let now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let finish
    const { orch, provider } = makeOrch([
      { text: '', toolUses: [say('t1', 'first line')] },
      { text: '', toolUses: [say('t2', 'second line')] },
      { text: '', toolUses: [say('t3', 'third line')] },
      { text: '', toolUses: [say('t4', 'fourth line, chopping now'), { id: 'g1', name: 'gather', input: { kind: 'oak_log' } }] },
      { text: '', toolUses: [] },
    ], () => new Promise((resolve) => { finish = resolve }))
    for (const line of ['hey', 'whats up', 'cool', 'get wood']) {
      now += 8_000
      orch.recordIncomingChat('newb', line)
      await orch.handleDispatch('sei:chat_received', chat(line))
    }
    now += 8_000
    orch.recordIncomingChat('newb', 'lol ur slow')
    await orch.handleDispatch('sei:chat_received', chat('lol ur slow'))
    const text = lastTurnText(provider.calls.at(-1))
    expect(text).toContain('lol ur slow')
    expect(text).toContain('If it is chat, a question, a joke or encouragement')
    expect(text).toContain('Your last lines to them were "first line" and then "second line" and then "third line" and then "fourth line, chopping now".')
    finish?.('done')
  })
})

// 261017 (pass 13): the player's first line crossed her first-contact hello.
// That turn already says a plain hello needs no say(); the reply ask ("find
// something new to say") pulled the other way. The next line gets the full
// ask again.
describe('own_repeats on the reply to a hello that crossed hers', () => {
  it('quotes her hello without the ask, once', async () => {
    _setTickIntervalForTests(10_000_000)
    const { orch, provider } = makeOrch([
      { text: '', toolUses: [say('t1', 'oh hey newb, first time in this world')] },
      { text: '', toolUses: [{ id: 'e1', name: 'end_loop', input: {} }] },
      { text: '', toolUses: [say('t3', 'wood, sure')] },
    ])
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn', quietMs: 0 })
    orch.recordIncomingChat('newb', 'hey sui')
    await orch.handleDispatch('sei:chat_received', chat('hey sui'))
    const crossed = blockText(provider.calls[1], 'own_repeats')
    expect(crossed).toBe('Your last line to them was "oh hey newb, first time in this world". They already heard it.')
    orch.recordIncomingChat('newb', 'wanna get wood')
    await orch.handleDispatch('sei:chat_received', chat('wanna get wood'))
    expect(blockText(provider.calls[2], 'own_repeats')).toContain(REPLY_ASK)
  })
})

// 261121 (pass 60): the player's third "stay close pls" gets the note right
// under their line; the first two do not.
describe('repeated player ask', () => {
  it('goes under their line from the third time on', async () => {
    _setTickIntervalForTests(10_000_000)
    let now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { orch, provider } = makeOrch([
      { text: '', toolUses: [say('t1', 'staying right here')] },
      { text: '', toolUses: [say('t2', 'yeah i got you')] },
      { text: '', toolUses: [say('t3', 'skeletons are far')] },
    ])
    const lines = ['ok sui thx. stay close pls', 'ok sui. stay close pls, im scared', 'ok thx sui. stay close pls']
    for (const line of lines) {
      now += 11_000
      orch.recordIncomingChat('newb', line)
      await orch.handleDispatch('sei:chat_received', chat(line))
    }
    const payload = (i) => JSON.stringify(provider.calls[i].blocks)
    expect(payload(0)).not.toContain('much the same thing')
    expect(payload(1)).not.toContain('much the same thing')
    const third = payload(2)
    const at = third.indexOf('Their line, player (newb): ok thx sui. stay close pls')
    expect(at).toBeGreaterThan(-1)
    expect(third.indexOf('They have now said much the same thing three times in the last 22 seconds')).toBeGreaterThan(at)
  })
})

// 261123 (pass 61): the same ask while she is already by their side (adapter
// playerNearby) owes no reply: no mandate, the near note under the line, and
// no unanswered-line retry when she stays quiet.
describe('repeated player ask while she is by their side', () => {
  const run = async (near) => {
    _setTickIntervalForTests(10_000_000)
    let now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { orch, provider } = makeOrch([
      { text: '', toolUses: [say('t1', 'staying right here')] },
      { text: '', toolUses: [say('t2', 'yeah i got you')] },
      { text: '', toolUses: [] },
      { text: '', toolUses: [say('t4', 'here')] },
    ], undefined, { playerNearby: (name) => (name === 'newb' ? near : null) })
    const lines = ['ok sui thx. stay close pls', 'ok sui. stay close pls, im scared', 'ok thx sui. stay close pls']
    for (const line of lines) {
      now += 11_000
      orch.recordIncomingChat('newb', line)
      await orch.handleDispatch('sei:chat_received', chat(line))
    }
    return provider
  }

  it('drops the reply mandate and the retry when she is 2 blocks away', async () => {
    const provider = await run({ distance: 2, following: false })
    expect(provider.calls).toHaveLength(3)
    const third = JSON.stringify(provider.calls[2].blocks)
    const at = third.indexOf('Their line, player (newb): ok thx sui. stay close pls')
    expect(at).toBeGreaterThan(-1)
    expect(third.indexOf('You are 2 blocks from them. If what they keep asking for is already happening, this line needs no answer')).toBeGreaterThan(at)
    expect(third).not.toContain('Answer it with say().')
    expect(third).not.toContain('a direct message never gets silence')
    expect(third).not.toContain('but say something')
    // The first two lines are no repeat yet: the mandate stands.
    expect(JSON.stringify(provider.calls[1].blocks)).toContain('Answer it with say().')
  })

  it('keeps the mandate and the retry when she is far off', async () => {
    const provider = await run({ distance: 15, following: false })
    expect(provider.calls).toHaveLength(4)
    const third = JSON.stringify(provider.calls[2].blocks)
    expect(third).toContain('Answer it with say().')
    expect(third).toContain('They have now said much the same thing three times')
    expect(third).not.toContain('this line needs no answer')
  })
})
