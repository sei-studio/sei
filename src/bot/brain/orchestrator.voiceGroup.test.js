// 260708 regressions — group-voice-call session fixes (playlogs 25770cd6 +
// bbf5b66f, 2026-07-08T06-28: two companions in-game while the player talked
// over a live call).
//
// Three structural failures from that session:
//   1. Every voice utterance reached the in-game brain wrapped in "messaged
//      you through Sei chat. They are NOT in the game with you right now."
//      while the player stood 3 blocks away — and the mandatory-reply framing
//      forced BOTH bots to answer every line, so addressing one bot by name
//      never worked (names also arrive garbled by STT: "Marv" as "My bar",
//      "Sui" as "sweet"/"soy"). Voice lines now deliver the RAW words with
//      voice:true and take group-addressing framing (decide for yourself,
//      silence yields to the teammate).
//   2. A 12s call-budget timeout silently dropped the turn — Sui never
//      responded to "fight each other" at all. A timeout now retries once.
//   3. An attack teardown discarded a chat-TRIGGERED loop's own unanswered
//      trigger ("Um" got zero response: its loop died to a sei:attacked
//      preempt with iterations=0). The trigger is now preserved and re-fired
//      after the attack, like pendingInterrupt always was.
//
// Same harness pattern as orchestrator.zombie.test.js: real orchestrator,
// scripted provider, mock adapter.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { NUDGES, voiceGroupGuidance } from './prompts.js'

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
      if (r instanceof Error) throw r
      return r
    },
  }
}

function makeAdapter() {
  return {
    listActions: () => ['follow', 'goTo', 'attackEntity'],
    getActionSchema: () => z.object({}),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: () => Promise.resolve('done'),
  }
}

function makeConfig() {
  return {
    player_username: 'SSk1tz',
    preferred_name: 'Sei',
    player_display_name: 'Sei',
    persona: { name: 'Sui', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-voicegroup-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
    },
  }
}

// A voice-call utterance as deliverSeiChat now enqueues it: RAW words plus
// routing flags, no wrapper baked into the text.
const voiceChat = (text) => ({
  text,
  message: text,
  username: 'Sei',
  playerSpoke: true,
  addressed: true,
  seiChat: true,
  voice: true,
  ts: Date.now(),
})

const promptTextOf = (call) => JSON.stringify(call.messages)

const timeoutErr = () => Object.assign(new Error('anthropic call exceeded 12000ms budget'), {
  name: 'AbortError',
  isTimeout: true,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('260708 group-voice framing', () => {
  it('a group-call voice line seeds with group-addressing framing, not the "NOT in the game" wrapper', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
    })
    orch.setVoiceCall(true)
    orch.setCompanions(['Marv'])

    await orch.handleDispatch('sei:chat_received', voiceChat('Marv, attack this zombie'))

    const prompt = promptTextOf(provider.calls[0])
    expect(prompt).toContain('the player just said this on the voice call')
    expect(prompt).toContain('Marv, attack this zombie')
    // Group-addressing guidance replaces the mandatory reply.
    expect(prompt).toContain('Decide from context who it is addressed to')
    expect(prompt).not.toContain('a direct message never gets silence')
    expect(prompt).not.toContain('NOT in the game')
  })

  it('a solo-call voice line keeps the mandatory reply', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
    })
    orch.setVoiceCall(true) // no companions

    await orch.handleDispatch('sei:chat_received', voiceChat('come here'))

    const prompt = promptTextOf(provider.calls[0])
    expect(prompt).toContain('the player just said this on the voice call')
    expect(prompt).toContain('a direct message never gets silence')
  })

  it('actionTurn renders the group-voice variant for mid-action and no-action lines', () => {
    const noAction = NUDGES.actionTurn({
      action: null, stopTool: 'end_loop', playerLine: 'sweet, make two wooden swords',
      who: 'Sei', voice: true, peers: ['Marv'],
    })
    expect(noAction).toContain('said on the voice call')
    expect(noAction).toContain('Decide from context who it is addressed to')
    expect(noAction).not.toContain('That say() is required')

    const midAction = NUDGES.actionTurn({
      action: 'gather oak_log', stopTool: 'end_loop', playerLine: 'sweet, make two wooden swords',
      who: 'Sei', voice: true, peers: ['Marv'],
    })
    expect(midAction).toContain('KEEP GOING')
    expect(midAction).toContain('Decide from context who it is addressed to')
    expect(midAction).not.toContain('you must still call say()')

    // Non-voice rendering is unchanged.
    const typed = NUDGES.actionTurn({
      action: null, stopTool: 'end_loop', playerLine: 'come here', who: 'Sei',
    })
    expect(typed).toContain('That say() is required')
    expect(typed).not.toContain('voice call')
  })

  it('voiceGroupGuidance names the peers and is empty with no peers', () => {
    expect(voiceGroupGuidance(['Marv'])).toContain('Marv')
    expect(voiceGroupGuidance(['Marv'])).toContain('garbles names')
    expect(voiceGroupGuidance([])).toBe('')
  })
})

describe('260708 group-voice yield stays private (thought-leak fix)', () => {
  // Live failure (session 2026-07-08T17-58): a bot that decided a line was the
  // teammate's wrote the reasoning into its private scratchpad and called
  // end_loop — and the 260703 scratchpad salvage spoke that reasoning over TTS
  // ("the player said 'mars, where are you?' - that's marv, not me / i stay
  // silent and let marv answer that"). On a group-voice line the silent end is
  // deliberate, so the salvage must not fire.
  it('does NOT speak the scratchpad when a group-voice line ends with end_loop and no say()', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      {
        text: "that's for Marv, not me. I stay silent and let Marv answer.",
        toolUses: [{ id: 'el1', name: 'end_loop', input: {} }],
      },
    ])
    const adapter = makeAdapter()
    const spoken = []
    const orch = createOrchestrator({
      adapter,
      config: makeConfig(),
      reenqueue: () => {},
      onSeiChatReply: (msg) => spoken.push(msg),
      _anthropicOverride: provider,
    })
    orch.setVoiceCall(true)
    orch.setCompanions(['Marv'])

    await orch.handleDispatch('sei:chat_received', voiceChat('Mars, where are you?'))

    expect(spoken).toEqual([])
    expect(adapter.chat).not.toHaveBeenCalled()
  })

  it('still salvages the scratchpad on a SOLO call (reply is mandatory there)', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      {
        text: 'yeah, right here by the oak logs.',
        toolUses: [{ id: 'el1', name: 'end_loop', input: {} }],
      },
    ])
    const spoken = []
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      onSeiChatReply: (msg) => spoken.push(msg),
      _anthropicOverride: provider,
    })
    orch.setVoiceCall(true) // no companions

    await orch.handleDispatch('sei:chat_received', voiceChat('where are you?'))

    expect(spoken.join(' ').toLowerCase()).toContain('right here by the oak logs')
  })

  it('a group-voice seed carries the group hint, not the mandatory-reply hint', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
    })
    orch.setVoiceCall(true)
    orch.setCompanions(['Marv'])

    await orch.handleDispatch('sei:chat_received', voiceChat('Marv, come here'))

    const prompt = promptTextOf(provider.calls[0])
    expect(prompt).toContain('If the line is yours to answer, reply with say()')
    expect(prompt).not.toContain('leaves them on read')
  })
})

// A teammate's call line as the observe-wake coalescer enqueues it: the bot
// now wakes on EVERY companion line (not just named ones) and decides for
// itself whether to answer or end silently.
const teammateChat = (text, from = 'Marv') => ({
  text,
  message: text,
  username: from,
  playerSpoke: false,
  addressed: true,
  seiChat: true,
  voice: true,
  ts: Date.now(),
})

describe('260708 teammate-line wakes (responsive to the whole call)', () => {
  it('an idle bot seeds a teammate call line with yield-allowed framing, not mandatory reply', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
    })
    orch.setVoiceCall(true) // Marv is call-only: NO in-game companions

    await orch.handleDispatch('sei:chat_received', teammateChat('sui, you good? you went quiet.'))

    const prompt = promptTextOf(provider.calls[0])
    expect(prompt).toContain('your teammate Marv just said this on the voice call')
    expect(prompt).toContain('sui, you good?')
    expect(prompt).toContain('only if it is aimed at you')
    expect(prompt).not.toContain('a direct message never gets silence')
    expect(prompt).not.toContain('leaves them on read')
  })

  it('a silent end on a teammate line speaks NOTHING (salvage skipped without a roster)', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      {
        text: 'that was aimed at the player, nothing needed from me.',
        toolUses: [{ id: 'el1', name: 'end_loop', input: {} }],
      },
    ])
    const adapter = makeAdapter()
    const spoken = []
    const orch = createOrchestrator({
      adapter,
      config: makeConfig(),
      reenqueue: () => {},
      onSeiChatReply: (msg) => spoken.push(msg),
      _anthropicOverride: provider,
    })
    orch.setVoiceCall(true) // no in-game companions — the fromTeammate leg must cover this

    await orch.handleDispatch('sei:chat_received', teammateChat('the universe is unchanged.'))

    expect(spoken).toEqual([])
    expect(adapter.chat).not.toHaveBeenCalled()
  })

  it('a teammate line landing mid-action is delivered (not dropped) and the action keeps running', async () => {
    _setTickIntervalForTests(10_000_000)
    let followSignal = null
    const adapter = makeAdapter()
    adapter.executeAction = (name, args, opts) => {
      if (name === 'follow') {
        followSignal = opts?.signal ?? null
        return new Promise(() => {}) // long-runner: suspends the loop
      }
      return Promise.resolve('done')
    }
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'f1', name: 'follow', input: {} }] },
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'right here, marv' } }] },
    ])
    const spoken = []
    const orch = createOrchestrator({
      adapter,
      config: makeConfig(),
      reenqueue: () => {},
      onSeiChatReply: (msg) => spoken.push(msg),
      _anthropicOverride: provider,
    })
    orch.setVoiceCall(true)

    await orch.handleDispatch('sei:chat_received', voiceChat('follow me'))
    expect(orch.currentLoop?.inFlight?.name).toBe('follow')

    // Pre-fix this fell to "dispatch arrived while loop active — dropping".
    await orch.handleDispatch('sei:chat_received', teammateChat('sui, where are you?'))

    expect(provider.calls.length).toBe(2)
    const prompt = promptTextOf(provider.calls[1])
    expect(prompt).toContain('sui, where are you?')
    expect(prompt).toContain('only if it is aimed at you')
    // The reply reached the call, and the running action was never aborted.
    expect(spoken.join(' ')).toContain('right here, marv')
    expect(followSignal?.aborted).toBe(false)
    expect(orch.currentLoop?.inFlight?.name).toBe('follow')
  })
})

describe('260708 dropped-turn fixes', () => {
  it('retries once after a call-budget timeout instead of dropping the turn', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      () => { throw timeoutErr() },
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'on it' } }] },
    ])
    const adapter = makeAdapter()
    const orch = createOrchestrator({
      adapter,
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:chat_received', voiceChat('fight each other'))

    expect(provider.calls.length).toBe(2) // first timed out, second is the retry
    const said = adapter.chat.mock.calls.map((c) => c[0]).join(' ').toLowerCase()
    expect(said).toContain('on it')
  })

  it('drops the turn after a second consecutive timeout (single retry only)', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      () => { throw timeoutErr() },
      () => { throw timeoutErr() },
    ])
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:chat_received', voiceChat('fight each other'))
    expect(provider.calls.length).toBe(2)
  })

  it('an attack teardown preserves a chat-triggered loop\'s unanswered trigger and re-fires it', async () => {
    _setTickIntervalForTests(10_000_000)
    // Call 1 (the chat turn) parks until its signal aborts — the in-flight
    // shape the sei:attacked preempt hits. Call 2 answers the attack loop.
    const provider = makeProvider([
      (args) => new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted (preempt)'), { name: 'AbortError' }))
        if (args.signal?.aborted) return abort()
        args.signal?.addEventListener('abort', abort, { once: true })
      }),
      { text: '', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const reenqueued = []
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: (ev, d) => reenqueued.push([ev, d]),
      _anthropicOverride: provider,
    })

    const chatDispatch = orch.handleDispatch('sei:chat_received', voiceChat('Um'))
    await new Promise((r) => setTimeout(r, 25)) // let the chat loop park on call 1
    await orch.handleDispatch('sei:attacked', { attackerKind: 'mob', mobType: 'drowned', username: 'Sei' })
    await chatDispatch

    // The attack re-fired at P0...
    expect(reenqueued.some(([ev]) => ev === 'sei:attacked')).toBe(true)
    // ...and the unanswered "Um" was preserved and re-fired with its routing
    // flags instead of being dropped (pre-fix: zero response, iterations=0).
    const preserved = reenqueued.find(([ev, d]) => ev === 'sei:chat_received' && d?.text === 'Um')
    expect(preserved).toBeTruthy()
    expect(preserved[1].voice).toBe(true)
    expect(preserved[1].seiChat).toBe(true)
  })
})

// 260709: continuous voice. Each onSeiChatReply message becomes its own TTS
// stream, and ElevenLabs synthesizes every fragment cold — so the old
// texting-style splitChatMessages fragmentation put an audible prosody cut
// between sentences of one spoken turn. On a live call the whole say() line
// ships as ONE message (= one streamed clip); the typed chat surface (seiChat
// without a call) keeps the texting-style split.
describe('260709 continuous voice — one say() line = one TTS message', () => {
  const TWO_SENTENCES = "yeah, i'm okay. are you doing alright out there?"

  it('ships the whole line as ONE message while a call is live', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: TWO_SENTENCES } }] },
    ])
    const spoken = []
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      onSeiChatReply: (msg) => spoken.push(msg),
      _anthropicOverride: provider,
    })
    orch.setVoiceCall(true)

    await orch.handleDispatch('sei:chat_received', voiceChat('how are you?'))

    expect(spoken).toHaveLength(1)
    expect(spoken[0]).toContain("i'm okay")
    expect(spoken[0]).toContain('are you doing alright')
  })

  it('typed sei-chat (no call) keeps the texting-style split', async () => {
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: TWO_SENTENCES } }] },
    ])
    const spoken = []
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: () => {},
      onSeiChatReply: (msg) => spoken.push(msg),
      _anthropicOverride: provider,
    })
    // No setVoiceCall — a typed message from the chat panel.
    const typed = { ...voiceChat('how are you?'), voice: false }
    await orch.handleDispatch('sei:chat_received', typed)

    expect(spoken.length).toBeGreaterThan(1)
  })
})
