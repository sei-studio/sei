// src/bot/brain/orchestrator.conversation.test.js
//
// 260921: the conversation fixes that came out of one Stardew session log
// (Lyra, 17 minutes, 48 loops). Each test below is one measured failure:
//
//   - a question answered twice with two different answers, because the idle
//     turn that followed the reply was composed before the reply's paced chat
//     line had been sent, so it did not know the reply existed;
//   - "answer my question" -> "what question", because the two one-sided chat
//     lists hid which line answered which, and a mid-loop player line arrived
//     with no conversation at all;
//   - an answer written in the private scratchpad beside a world action, with
//     no say(), under a "You are MID-ACTION, KEEP GOING" framing for an action
//     that had already finished;
//   - three web searches in 50 seconds on one topic, each forgotten by the
//     next turn, producing six answers that did not agree;
//   - a game event ("A new day") framed as someone speaking, reply mandatory;
//   - the same sentence sent twice with nothing from the player in between.
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import {
  createOrchestrator,
  _setTickIntervalForTests,
  replyWindowRemainingMs,
  replyWindowApplies,
  isExactRepeatSincePlayerSpoke,
  splitRepeatedSegments,
  joinSegments,
  splitChatMessages,
  REPLY_WINDOW_MS,
} from './orchestrator.js'
import { createConvoMemory, playerLabel } from './convoMemory.js'
import { createLookupLog, extractServerLookup } from './lookups.js'

function makeProvider(script) {
  let i = 0
  const calls = []
  return {
    calls,
    buildCachedSystem: (blocks) => blocks,
    setAuthToken() {},
    setBackend() {},
    async call(args) {
      // Snapshot the named blocks: the orchestrator mutates its message array
      // after the call returns.
      calls.push({ ...args, blocks: JSON.parse(JSON.stringify(args.namedUserBlocks ?? [])) })
      const r = script[Math.min(i, script.length - 1)]
      i += 1
      return typeof r === 'function' ? r(args) : r
    },
  }
}

function makeAdapter({ executeAction, gameName = 'Stardew Valley' } = {}) {
  const ACTIONS = ['follow', 'unfollow', 'goTo', 'gather']
  return {
    gameName,
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ player: z.string().optional(), kind: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: executeAction ?? (() => Promise.resolve('done')),
  }
}

function makeConfig(extra = {}) {
  return {
    player_username: 'newb',
    preferred_name: 'newb',
    persona: { name: 'Lyra', expanded: 'You are a soft-spoken companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-orch-convo-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`),
      iteration_cap: 30,
    },
    web: { enabled: false },
    ...extra,
  }
}

function makeOrch({ script, adapter = makeAdapter(), config = makeConfig(), reenqueue = () => {} }) {
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter, config, reenqueue,
    sessionState: { playerData: () => ({}), onLoopTerminal: async () => {} },
    playerStore: { formatPlayerSeedBlock: () => 'PLAYER' },
    _anthropicOverride: provider,
  })
  return { orch, provider, adapter }
}

const chat = (text) => ({ text, message: text, username: 'newb', playerSpoke: true, ts: Date.now() })
const say = (id, text) => ({ id, name: 'say', input: { text } })
const blockNames = (call) => call.blocks.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).map((b) => b?.name).filter(Boolean)
const blockText = (call, name) => call.blocks
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .filter((b) => b?.name === name).map((b) => b.text).join('\n')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('convoMemory.formatConversationBlock', () => {
  it('renders both sides as one exchange in the order it happened', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const m = createConvoMemory().recentChat
    m.pushPlayer('newb', 'do all worlds spawn in the same place?')
    vi.setSystemTime(1_010_000)
    m.pushSelf('Lyra', 'you ready to plant?')
    vi.setSystemTime(1_020_000)
    m.pushPlayer('newb', 'answer my question')
    vi.setSystemTime(1_021_000)
    const lines = m.formatConversationBlock().split('\n').slice(1)
    expect(lines).toEqual([
      '[21s ago] player (newb): do all worlds spawn in the same place?',
      '[11s ago] you: you ready to plant?',
      '[1s ago] player (newb): answer my question',
    ])
  })

  it('is null before anyone has spoken', () => {
    expect(createConvoMemory().recentChat.formatConversationBlock()).toBeNull()
  })
})

describe('replyWindowRemainingMs', () => {
  it('holds the floor after her line and releases it once the player speaks', () => {
    const now = 100_000
    expect(replyWindowRemainingMs({ lastSelf: { at: now - 4000 }, lastPlayer: null, now })).toBe(REPLY_WINDOW_MS - 4000)
    expect(replyWindowRemainingMs({ lastSelf: { at: now - 4000 }, lastPlayer: { at: now - 1000 }, now })).toBe(0)
    expect(replyWindowRemainingMs({ lastSelf: { at: now - REPLY_WINDOW_MS - 1 }, lastPlayer: null, now })).toBe(0)
    expect(replyWindowRemainingMs({ lastSelf: null, lastPlayer: null, now })).toBe(0)
  })

  it('opens when the paced line is readable, not when it was decided', () => {
    const now = 100_000
    expect(replyWindowRemainingMs({ lastSelf: { at: now }, lastPlayer: null, sendDeadline: now + 5000, now }))
      .toBe(REPLY_WINDOW_MS + 5000)
  })
})

describe('the reply window is Stardew only', () => {
  it('applies to Stardew and not to Minecraft, DST or an unnamed adapter', () => {
    expect(replyWindowApplies({ gameName: 'Stardew Valley' })).toBe(true)
    expect(replyWindowApplies({ gameName: 'Minecraft' })).toBe(false)
    expect(replyWindowApplies({ gameName: "Don't Starve Together" })).toBe(false)
    expect(replyWindowApplies({})).toBe(false)
    expect(replyWindowApplies(null)).toBe(false)
  })

  async function holdAfterSay(gameName) {
    _setTickIntervalForTests(10_000_000)
    const { orch } = makeOrch({
      adapter: makeAdapter({ gameName }),
      script: [{ text: '', toolUses: [say('t1', 'want to go fishing after this?')] }],
    })
    orch.recordIncomingChat('newb', 'hey')
    await orch.handleDispatch('sei:chat_received', chat('hey'))
    return orch.replyWindowRemainingMs()
  }

  it('holds the idle floor after her line in Stardew', async () => {
    const held = await holdAfterSay('Stardew Valley')
    expect(held).toBeGreaterThan(REPLY_WINDOW_MS - 5000)
    expect(held).toBeLessThanOrEqual(REPLY_WINDOW_MS)
  })

  it('does not hold it in Minecraft, so the agentic cadence resumes the goal as before', async () => {
    expect(await holdAfterSay('Minecraft')).toBe(0)
  })
})

describe('isExactRepeatSincePlayerSpoke', () => {
  const now = 500_000
  const selfLines = [{ at: now - 9000, text: 'what question, i\'m listening nya' }]
  it('catches the same sentence with nothing from the player in between', () => {
    expect(isExactRepeatSincePlayerSpoke({ segments: ['What question, I\'m listening nya!'], selfLines, lastPlayer: { at: now - 12_000 }, now })).toBe(true)
  })
  it('lets a reworded line through: similarity is not this test\'s business', () => {
    expect(isExactRepeatSincePlayerSpoke({ segments: ['which question do you mean'], selfLines, lastPlayer: { at: now - 12_000 }, now })).toBe(false)
  })
  it('allows the same words again once the player has spoken', () => {
    expect(isExactRepeatSincePlayerSpoke({ segments: ['what question, i\'m listening nya'], selfLines, lastPlayer: { at: now - 3000 }, now })).toBe(false)
  })
  it('needs EVERY segment to be a repeat', () => {
    expect(isExactRepeatSincePlayerSpoke({ segments: ['what question, i\'m listening nya', 'oh, the spawn one'], selfLines, lastPlayer: null, now })).toBe(false)
  })
  it('works for non-Latin text', () => {
    expect(isExactRepeatSincePlayerSpoke({ segments: ['等等，什么问题'], selfLines: [{ at: now - 1000, text: '等等,什么问题?' }], lastPlayer: null, now })).toBe(true)
  })
})

describe('lookups', () => {
  it('reads queries and the post-result conclusion out of a server search response', () => {
    const got = extractServerLookup([
      { type: 'text', text: "i'll search for that" },
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'stardew farm maps same for everyone' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
      { type: 'text', text: 'there are eight farm maps; you pick one at the start.' },
      { type: 'tool_use', id: 't1', name: 'say', input: { text: 'depends on the farm type' } },
    ])
    expect(got.queries).toEqual(['stardew farm maps same for everyone'])
    expect(got.finding).toBe('there are eight farm maps; you pick one at the start.')
    expect(extractServerLookup([{ type: 'text', text: 'hi' }])).toBeNull()
  })

  it('keeps a bounded log and renders it for the seed', () => {
    const log = createLookupLog({ capacity: 2 })
    expect(log.formatBlock()).toBeNull()
    expect(log.record({ queries: ['q0'], finding: '', told: '' })).toBe(false) // nothing worth keeping
    log.record({ queries: ['q1'], finding: 'f1', told: 't1' })
    log.record({ queries: ['q2'], finding: 'f2' })
    log.record({ queries: ['q3'], finding: 'f3' })
    const text = log.formatBlock()
    expect(text).not.toContain('"q1"')
    expect(text).toContain('searched: "q2"')
    expect(text).toContain('found: f3')
  })
})

describe('what she said is visible to her next turn the moment it is decided', () => {
  it('an idle turn composed during the typing delay already sees the queued reply', async () => {
    _setTickIntervalForTests(10_000_000)
    vi.useFakeTimers()
    const { orch, provider, adapter } = makeOrch({
      config: makeConfig({ realistic_typing: true }),
      script: [
        { text: '', toolUses: [say('t1', 'we can sell the stone at the shipping bin')] },
        { text: '', toolUses: [] },
      ],
    })
    // brain/index.js records an incoming line before it enqueues the event.
    orch.recordIncomingChat('newb', 'is there anything we can do with the rocks')
    await orch.handleDispatch('sei:chat_received', chat('is there anything we can do with the rocks'))
    // The paced send has NOT fired yet: nothing has reached the game's chat.
    expect(adapter.chat).not.toHaveBeenCalled()
    await orch.handleDispatch('sei:idle', { quietMs: 5001 })
    const convo = blockText(provider.calls[1], 'recent_conversation')
    expect(convo).toContain('player (newb): is there anything we can do with the rocks')
    expect(convo).toContain('you: we can sell the stone at the shipping bin')
    expect(convo.indexOf('] player (newb):')).toBeLessThan(convo.indexOf('] you:')) // the header itself mentions "you:"
    // The merged block replaces the two one-sided lists.
    expect(blockNames(provider.calls[1])).not.toContain('your_recent_messages')
    expect(blockNames(provider.calls[1])).not.toContain('recent_player_chat')
    await vi.runAllTimersAsync()
    expect(adapter.chat).toHaveBeenCalledTimes(1)
  })
})

describe('a web lookup outlives the loop that made it', () => {
  it('carries the finding into the next loop\'s seed', async () => {
    _setTickIntervalForTests(10_000_000)
    const searched = {
      text: "i'll search for thateight farm maps; the layout depends on the one you picked.",
      content: [
        { type: 'text', text: "i'll search for that" },
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'stardew valley do all farms start the same' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
        { type: 'text', text: 'eight farm maps; the layout depends on the one you picked.' },
        { type: 'tool_use', id: 't1', name: 'say', input: { text: 'depends on the farm type you picked' } },
      ],
      toolUses: [say('t1', 'depends on the farm type you picked')],
    }
    const { orch, provider } = makeOrch({ script: [searched, { text: '', toolUses: [] }] })
    await orch.handleDispatch('sei:chat_received', chat('can u search that to be sure'))
    expect(blockNames(provider.calls[0])).not.toContain('lookups')
    await orch.handleDispatch('sei:chat_received', chat('oh so the trees are different?'))
    const notes = blockText(provider.calls[1], 'lookups')
    expect(notes).toContain('searched: "stardew valley do all farms start the same"')
    expect(notes).toContain('found: eight farm maps; the layout depends on the one you picked.')
    expect(notes).toContain('you told them: depends on the farm type you picked')
    expect(notes).not.toContain("i'll search for that") // the preamble is not a finding
  })
})

describe('a player line answered with actions only is delivered once more', () => {
  it('re-presents the line as unanswered instead of leaving the reply in the scratchpad', async () => {
    _setTickIntervalForTests(10_000_000)
    const reenqueued = []
    let finish
    const adapter = makeAdapter({ executeAction: () => new Promise((resolve) => { finish = resolve }) })
    const { orch, provider } = makeOrch({
      adapter,
      reenqueue: (event, data) => reenqueued.push({ event, data }),
      script: [
        { text: "i'm not sure, but i think each world is its own farm", toolUses: [{ id: 'g1', name: 'gather', input: { kind: 'debris' } }] },
        { text: '', toolUses: [say('t2', "not sure, i think each farm is its own")] },
      ],
    })
    await orch.handleDispatch('sei:chat_received', chat('do all worlds spawn in the same place?'))
    const tick = reenqueued.find((r) => r.event === 'sei:action_tick' && r.data?.unanswered === true)
    expect(tick?.data.playerMessage).toBe('do all worlds spawn in the same place?')
    expect(adapter.chat).not.toHaveBeenCalled() // the scratchpad is NOT salvaged

    await orch.handleDispatch('sei:action_tick', tick.data)
    const lastTurn = provider.calls[1].blocks.at(-1)
    const text = lastTurn.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    expect(text).toContain('Your last turn did NOT call say()')
    expect(text).toContain('"do all worlds spawn in the same place?"')
    expect(adapter.chat).toHaveBeenCalledTimes(1)

    // One retry per line: a second silent turn does not loop.
    expect(reenqueued.filter((r) => r.data?.unanswered === true).length).toBe(1)
    finish?.('done')
  })
})

describe('"mid-action" only when something is running', () => {
  it('a line that lands between actions is not told to keep going', async () => {
    _setTickIntervalForTests(10_000_000)
    let orchRef
    const adapter = makeAdapter({ executeAction: () => Promise.resolve('cleared 30 pieces of debris') })
    let call = 0
    const { orch, provider } = makeOrch({
      adapter,
      script: [
        { text: '', toolUses: [{ id: 'g1', name: 'gather', input: { kind: 'debris' } }] },
        // The continuation call after the gather FINISHED is the one a player
        // line preempts.
        () => {
          call += 1
          if (call === 1) {
            orchRef.recordIncomingChat('newb', 'do all worlds spawn in the same place?')
            orchRef.handlePreempt('sei:chat_received', chat('do all worlds spawn in the same place?'))
            const err = new Error('aborted'); err.name = 'AbortError'; throw err
          }
          return { text: '', toolUses: [say('t9', 'not sure, let me check')] }
        },
      ],
    })
    orchRef = orch
    await orch.handleDispatch('sei:idle', { quietMs: 9000 })
    await orch.handleDispatch('sei:action_complete', { name: 'gather', tool_use_id: 'g1', result: 'cleared 30 pieces of debris' }).catch(() => {})
    const last = provider.calls.at(-1)
    const text = last.blocks.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    expect(text).toContain('do all worlds spawn')
    expect(text).not.toContain('MID-ACTION')
    expect(text).toContain('NOT in the middle of anything')
    // ...and it arrives with the conversation it belongs to.
    expect(text).toContain('Your recent conversation with the player')
  })
})

describe('a game event is not someone speaking', () => {
  it('carries no reply obligation and no speaker framing', async () => {
    _setTickIntervalForTests(10_000_000)
    const { orch, provider, adapter } = makeOrch({ script: [{ text: 'new day. nothing to add.', toolUses: [{ id: 'e1', name: 'end_loop', input: {} }] }] })
    await orch.handleDispatch('sei:chat_received', {
      username: 'sei', text: '[A new day: spring 2, sunny.]', message: '[A new day: spring 2, sunny.]', playerSpoke: false, gameEvent: true,
    })
    expect(blockNames(provider.calls[0])).not.toContain('player_message')
    const ev = blockText(provider.calls[0], 'event')
    expect(ev).toContain('Event: game_event')
    expect(ev).toContain('say() is optional')
    expect(ev).not.toContain('just spoke to you')
    // The silent end is respected: the scratchpad is never spoken.
    expect(adapter.chat).not.toHaveBeenCalled()
  })
})

describe('the same sentence twice', () => {
  it('is sent once when the player has said nothing in between', async () => {
    _setTickIntervalForTests(10_000_000)
    const { orch, adapter } = makeOrch({
      script: [
        { text: '', toolUses: [say('t1', 'what did you figure out')] },
        { text: '', toolUses: [say('t2', 'what did you figure out?')] },
        { text: '', toolUses: [say('t3', 'what did you figure out')] },
      ],
    })
    await orch.handleDispatch('sei:idle', { quietMs: 10_000 })
    await orch.handleDispatch('sei:idle', { quietMs: 20_000 })
    expect(adapter.chat).toHaveBeenCalledTimes(1)
    // Once the player speaks, the same words are allowed again.
    orch.recordIncomingChat('newb', 'huh?')
    await orch.handleDispatch('sei:chat_received', chat('huh?'))
    expect(adapter.chat).toHaveBeenCalledTimes(2)
  })
})

// 260925: v0.6.5-beta.2 playtest (Sui, Stardew). The player's preferred name
// was "Sei", the app's own name. Asked in the app to "ask me a question about
// what i want to do on the farm today", she asked; her come() finished 8 s
// later and the action-complete turn said "i'm here. <the same question>",
// which went out whole because "i'm here" was new; then 20 s later an idle
// turn answered the question herself, her scratchpad reading "They asked
// 'so what's the vibe...'", her own line, attributed to the player.
const Q = "so what's the vibe, you wanna just plant these parsnips or you got something else in mind for the farm"

describe('who said it stays unambiguous when the player is called "Sei"', () => {
  it('labels the human by role and a sibling companion by name', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    const m = createConvoMemory().recentChat
    m.pushPlayer('Sei', 'hey sui, ask me a question about the farm')
    m.pushPlayer('Marv', 'i will get wood', { companion: true })
    m.pushSelf('Sui', Q)
    const lines = m.formatConversationBlock().split('\n').slice(1)
    expect(lines).toEqual([
      '[0s ago] player (Sei): hey sui, ask me a question about the farm',
      '[0s ago] Marv: i will get wood',
      `[0s ago] you: ${Q}`,
    ])
    expect(m.formatPlayerBlock()).toContain('] player (Sei): hey sui')
  })

  it('never produces a bare name, even one equal to hers', () => {
    expect(playerLabel('Sui')).toBe('player (Sui)')
    expect(playerLabel('The player')).toBe('player')
    expect(playerLabel('')).toBe('player')
  })

  it('the transcript header says the player is never her, and her own open question waits on them', async () => {
    _setTickIntervalForTests(10_000_000)
    const { orch, provider } = makeOrch({ script: [{ text: '', toolUses: [] }] })
    orch.recordIncomingChat('Sei', 'hey sui, ask me a question about the farm')
    await orch.handleDispatch('sei:idle', { quietMs: 23_000 })
    const convo = blockText(provider.calls[0], 'recent_conversation')
    expect(convo).toContain('] player (Sei): hey sui')
    expect(convo).not.toMatch(/\] Sei:/)
    expect(convo).toContain('it is still them, never you')
    expect(convo).toContain('do not answer it yourself')
  })

  it('a mid-action player line names them by role in the turn text', async () => {
    _setTickIntervalForTests(10_000_000)
    let release
    const running = new Promise((r) => { release = r })
    const adapter = makeAdapter({ executeAction: () => running })
    const { orch, provider } = makeOrch({
      adapter,
      script: [
        { text: '', toolUses: [{ id: 'g1', name: 'goTo', input: {} }] },
        { text: '', toolUses: [say('t2', 'ok')] },
        { text: '', toolUses: [] },
      ],
    })
    const first = orch.handleDispatch('sei:idle', { quietMs: 10_000 })
    await vi.waitFor(() => expect(provider.calls.length).toBe(1))
    orch.recordIncomingChat('Sei', 'wait for me')
    const second = orch.handleDispatch('sei:chat_received', { ...chat('wait for me'), username: 'Sei' })
    release('arrived')
    await Promise.allSettled([first, second])
    const texts = provider.calls.slice(1).map((c) => JSON.stringify(c.blocks) + JSON.stringify(c.messages ?? []))
    expect(texts.join('\n')).toContain('player (Sei)')
  })
})

describe('a re-asked question is dropped sentence by sentence', () => {
  const now = 900_000
  it('keeps the new sentence and drops the repeated one', () => {
    const r = splitRepeatedSegments({
      segments: splitChatMessages(`i'm here. ${Q}`, 'deliberate'),
      selfLines: [{ at: now - 8000, text: Q }],
      lastPlayer: { at: now - 12_000 },
      now,
    })
    expect(r.kept).toEqual(["i'm here."])
    expect(r.dropped).toEqual([Q])
    // The whole-line predicate still reads "not every segment repeats".
    expect(isExactRepeatSincePlayerSpoke({ segments: [`i'm here`, Q], selfLines: [{ at: now - 8000, text: Q }], lastPlayer: null, now })).toBe(false)
  })

  it('drops nothing once the player has answered', () => {
    const r = splitRepeatedSegments({ segments: ["i'm here.", Q], selfLines: [{ at: now - 8000, text: Q }], lastPlayer: { at: now - 1000 }, now })
    expect(r.dropped).toEqual([])
  })

  it('re-joins survivors so they split back into the same messages', () => {
    const segs = ['ok.', 'first thing', 'then the second']
    expect(splitChatMessages(joinSegments(segs), 'deliberate')).toEqual(segs)
    expect(joinSegments(['one'])).toBe('one')
  })

  it('replays the playtest: the action-complete turn does not re-ask the open question', async () => {
    _setTickIntervalForTests(10_000_000)
    const { orch, adapter, provider } = makeOrch({
      script: [
        { text: '', toolUses: [say('t1', Q), { id: 'g1', name: 'goTo', input: {} }] },
        { text: '', toolUses: [say('t2', `i'm here. ${Q}`), { id: 'g2', name: 'goTo', input: {} }] },
        { text: '', toolUses: [] },
      ],
    })
    orch.recordIncomingChat('Sei', 'hey sui, ask me a question about what i want to do on the farm today, then let me think')
    await orch.handleDispatch('sei:chat_received', { ...chat('hey sui, ask me a question about what i want to do on the farm today, then let me think'), username: 'Sei' })
    await orch.handleDispatch('sei:action_complete', { name: 'goTo', tool_use_id: 'g1', result: 'arrived' }).catch(() => {})
    await vi.waitFor(() => expect(adapter.chat.mock.calls.map((c) => c[0])).toContain("i'm here"))
    const sent = adapter.chat.mock.calls.map((c) => c[0])
    expect(sent.filter((t) => t === Q)).toHaveLength(1)
    // The model is told what was held back and not to answer it for them
    // (visible on the next call of the loop, after the second walk).
    await orch.handleDispatch('sei:action_complete', { name: 'goTo', tool_use_id: 'g2', result: 'arrived' }).catch(() => {})
    const results = JSON.stringify(provider.calls.map((c) => c.messages ?? []))
    expect(results).toContain('Do not reword it or answer it for them')
  })

  it('still drops the whole line when every sentence repeats', async () => {
    _setTickIntervalForTests(10_000_000)
    const { orch, adapter } = makeOrch({
      script: [
        { text: '', toolUses: [say('t1', Q)] },
        { text: '', toolUses: [say('t2', `${Q}.`)] },
      ],
    })
    await orch.handleDispatch('sei:idle', { quietMs: 10_000 })
    await orch.handleDispatch('sei:idle', { quietMs: 30_000 })
    expect(adapter.chat).toHaveBeenCalledTimes(1)
  })
})
