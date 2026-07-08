// 260611 regression — zombie loop after end_loop with a live long-runner,
// and the 429 rate-limit redrive.
//
// Playlog 25770cd6-…-2026-06-11T20-29-34: the model answered a player chat
// with end_loop while `follow` was in flight. R3 set only `loop.isTerminal`;
// the still-unsettled in_flight made every continuation tail return
// "suspended", and the eventual settle was dropped by the isTerminal guard —
// so the loop was never torn down. currentLoop stayed set and THREE
// subsequent player messages were swallowed (40s of silence) until the
// player punched the bot (P0 attack teardown).
//
// Same harness pattern as orchestrator.visualize.test.js: real orchestrator,
// scripted provider, mock adapter whose `follow` never settles (matching the
// real follow behavior — a background trail with no natural completion).

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createOrchestrator, _setTickIntervalForTests, typingDelayMs, readingDelayMs, splitChatMessages } from './orchestrator.js'

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
  const adapter = {
    listActions: () => ['follow', 'goTo'],
    getActionSchema: () => z.object({}),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    // follow mirrors the real behavior: a background trail that never
    // settles on its own (and this mock ignores aborts entirely, the
    // worst case for the teardown race).
    executeAction: (name) => (name === 'follow' ? new Promise(() => {}) : Promise.resolve('done')),
  }
  return adapter
}

function makeConfig() {
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-zombie-test-${process.pid}-${Date.now()}-${Math.random()}.md`),
      iteration_cap: 30,
    },
  }
}

const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })

afterEach(() => {
  vi.useRealTimers()
})

describe('260611 zombie-loop regression', () => {
  it('end_loop while follow is in flight tears the loop down; the next chat gets answered', async () => {
    _setTickIntervalForTests(10_000_000) // park the 10s auto-tick
    const provider = makeProvider([
      // Turn 1 (chat "lets go explore"): start following → loop suspends.
      { text: 'fine.', toolUses: [{ id: 'fu1', name: 'follow', input: { player: 'Steve' } }] },
      // Turn 2 (chat while following, delivered via the action-tick path):
      // the model replies AND ends the loop — the playlog shape.
      { text: 'jungle turned to plains. boring.', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
      // Turn 3 (the chat that used to be swallowed by the zombie).
      { text: 'you called it boring first.', toolUses: [{ id: 'el2', name: 'end_loop', input: {} }] },
    ])
    const reenqueued = []
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: (ev, d) => reenqueued.push([ev, d]),
      _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:chat_received', chat('lets go explore'))
    expect(orch.currentLoop).not.toBeNull() // suspended on follow

    await orch.handleDispatch('sei:chat_received', chat('what do you think so far'))
    // THE fix: end_loop + live in_flight must fully tear down, even though
    // the aborted follow never settles. Pre-fix, currentLoop stayed set here
    // and every later chat was swallowed.
    expect(orch.currentLoop).toBeNull()

    await orch.handleDispatch('sei:chat_received', chat('well u called this place boring'))
    expect(provider.calls.length).toBe(3) // the third chat reached the model
  })

  it('260703: a chat answered with only end_loop still speaks — the scratchpad reply is salvaged', async () => {
    // Observed failure (playlog 2026-07-03T17-40): "i wanna be alone for a
    // bit" → model wrote its reply into the invisible text scratchpad and
    // called only end_loop — the player got pure silence, twice in a row.
    // The backstop routes that scratchpad through the say pipeline.
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      { text: "I read that. you've made that clear.", toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const adapter = makeAdapter()
    const orch = createOrchestrator({
      adapter,
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:chat_received', chat('i wanna be alone for a bit'))
    expect(orch.currentLoop).toBeNull() // end_loop still terminates the loop
    expect(adapter.chat).toHaveBeenCalled() // …but the reply reached chat
    // postProcessSay may normalize casing — compare case-insensitively.
    const said = adapter.chat.mock.calls.map((c) => c[0]).join(' ').toLowerCase()
    expect(said).toContain('i read that')
  })

  it('260704: the salvage also fires on the action-tick interrupt path — a say() from BEFORE the interrupt does not count as answering it', async () => {
    // The 260703 backstop reset _spokeThisLoop only in interruptTurnText, but
    // the COMMON delivery path for a chat landing mid-action is handleActionTick
    // (dispatcher Change 1), which builds its own actionTurn. A say() earlier in
    // the loop left the flag stale-true there, so the salvage predicate skipped
    // and the player got silence — the exact failure the backstop exists for.
    _setTickIntervalForTests(10_000_000)
    const provider = makeProvider([
      // Turn 1 (chat "lets go explore"): speak AND start following → the say()
      // sets _spokeThisLoop; the loop suspends on follow.
      {
        text: '',
        toolUses: [
          { id: 'say1', name: 'say', input: { text: 'sure, lets go' } },
          { id: 'fu1', name: 'follow', input: { player: 'Steve' } },
        ],
      },
      // Turn 2 ("i wanna be alone for a bit", delivered via the action-tick
      // path because follow is in flight): the model writes its reply ONLY in
      // the scratchpad and calls end_loop — the 260703 silence shape. One
      // sentence, so the salvage lands as a single synchronous chat call
      // (multi-segment replies stagger on a timer).
      { text: 'ok, ill leave you be then', toolUses: [{ id: 'el1', name: 'end_loop', input: {} }] },
    ])
    const adapter = makeAdapter()
    const orch = createOrchestrator({
      adapter,
      config: makeConfig(),
      reenqueue: () => {},
      _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:chat_received', chat('lets go explore'))
    expect(orch.currentLoop).not.toBeNull() // suspended on follow
    expect(adapter.chat).toHaveBeenCalled() // turn 1's say() reached chat

    await orch.handleDispatch('sei:chat_received', chat('i wanna be alone for a bit'))
    expect(orch.currentLoop).toBeNull() // end_loop tore the loop down
    // Pre-fix: the stale _spokeThisLoop=true from turn 1's say() skipped the
    // salvage and this reply never reached chat.
    const said = adapter.chat.mock.calls.map((c) => c[0]).join(' ').toLowerCase()
    expect(said).toContain('leave you be')
  })

  it('schedules a delayed redrive of a chat the rate limit killed', async () => {
    vi.useFakeTimers()
    _setTickIntervalForTests(10_000_000)
    const rateErr = Object.assign(new Error('429 rate_limited'), {
      status: 429,
      error: { error: 'rate_limited', kind: 'itpm', retry_after_seconds: 15 },
    })
    const provider = makeProvider([rateErr])
    const reenqueued = []
    const orch = createOrchestrator({
      adapter: makeAdapter(),
      config: makeConfig(),
      reenqueue: (ev, d) => reenqueued.push([ev, d]),
      _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:chat_received', chat('thank you. it is my lifelong work'))
    expect(orch.currentLoop).toBeNull() // loop died on the 429

    // No redrive yet (window not elapsed)…
    const before = reenqueued.filter(([ev]) => ev === 'sei:chat_received').length
    expect(before).toBe(0)
    // …after retry_after (15s) + pad, the original chat is re-enqueued.
    await vi.advanceTimersByTimeAsync(16_000)
    const redriven = reenqueued.filter(([ev]) => ev === 'sei:chat_received')
    expect(redriven.length).toBe(1)
    expect(redriven[0][1].text).toBe('thank you. it is my lifelong work')
  })

  it('260703 follow-up: quit() waits for the FULL realistic-typing goodbye, not just the old 2s cap', async () => {
    // The 2s cap on quit()'s teardown defer predates realistic typing. With
    // config.realistic_typing on (the default), reading + typing delay alone
    // can reach 2500 + 5000 = 7500ms before the first goodbye segment even
    // sends, and a multi-sentence farewell adds (segments-1)*550ms on top —
    // comfortably over the old 2s cap. This reproduces exactly that: a long
    // trigger message (caps readingDelayMs) + a long, multi-sentence farewell
    // (caps typingDelayMs and adds segment stagger) and asserts onQuitRequested
    // fires only once the real deadline elapses, not at the old 2s mark.
    vi.useFakeTimers()
    _setTickIntervalForTests(10_000_000)

    const TRIGGER = 'tell me all about the incredible journey you have been on today, every single detail, i have got all the time in the world to listen so do not leave anything out please'
    const FAREWELL = 'Goodbye my friend. It has been wonderful adventuring with you today. I will miss our chats and our builds. See you around sometime soon.'

    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'q1', name: 'quit_game', input: { farewell: FAREWELL } }] },
    ])
    const onQuitRequested = vi.fn()
    const adapter = makeAdapter()
    const config = makeConfig()
    config.realistic_typing = true
    const orch = createOrchestrator({
      adapter,
      config,
      reenqueue: () => {},
      onQuitRequested,
      _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:chat_received', chat(TRIGGER))

    // Derive the expected wait from the same building blocks the orchestrator
    // uses, so this test doesn't hardcode a number that drifts if the pacing
    // constants change.
    const leadMs = readingDelayMs(TRIGGER) + typingDelayMs(FAREWELL)
    const segments = splitChatMessages(FAREWELL).length
    const expectedWaitMs = Math.min(10_000, Math.max(0, leadMs + (segments - 1) * 550) + 250)
    // Sanity check this scenario actually exercises the bug: the legitimate
    // deadline here must exceed the old (wrong) 2s cap.
    expect(expectedWaitMs).toBeGreaterThan(2_000)

    // Just short of the real deadline: teardown must NOT have fired yet.
    await vi.advanceTimersByTimeAsync(expectedWaitMs - 100)
    expect(onQuitRequested).not.toHaveBeenCalled()

    // Past the real deadline: teardown fires, and by then the full farewell
    // reached chat (the goodbye-before-teardown guarantee this defer exists for).
    await vi.advanceTimersByTimeAsync(200)
    expect(onQuitRequested).toHaveBeenCalledTimes(1)
    // postProcessSay may normalize casing — compare case-insensitively.
    const said = adapter.chat.mock.calls.map((c) => c[0]).join(' ').toLowerCase()
    expect(said).toContain('see you around sometime soon')
  })
})

// 260703 — stale pre-interrupt action_complete must not hijack a batch drain,
// and a loop torn down mid-batch must still run its model-ordered tools.
//
// Live-session failure (cloud proxy, claude-haiku-4-5): the player said "go pick
// up the full diamond armor set" while a `goTo` was in flight, then "equip it".
// The goTo settled (tick-claimed) BEFORE the "equip it" interrupt folded, so its
// action_complete sat FIFO-queued at P2.1. The interrupt turn produced a batch —
// say() + equip(helmet/chest/legs/boots). The helmet dispatched (remaining 3
// equips stashed on loop._pendingToolUses), but the STALE tick-claimed
// "goTo -> reached" settle drained ahead of the helmet's own settle and drove a
// full LLM iteration narrating it — which then died on a 502/timeout, dropping
// the 3 remaining equips silently. See orchestrator.js handleActionCompleteTickClaimed
// (fix a) and drainPendingToolsOnTeardown (fix b).

function makeBatchAdapter() {
  const ACTIONS = ['goTo', 'equip', 'follow']
  const executed = []
  let goToResolve = null
  const adapter = {
    listActions: () => ACTIONS,
    getActionSchema: () =>
      z.object({
        x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
        item: z.string().optional(), player: z.string().optional(),
      }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, args) => {
      executed.push({ name, args })
      // goTo suspends until resolved by the test (simulating the long-runner
      // that settles while the interrupt turn's LLM call is in flight).
      if (name === 'goTo') return new Promise((res) => { goToResolve = res })
      // equip is fast + synchronous like the real thing.
      return Promise.resolve(`${name}:ok`)
    },
  }
  return { adapter, executed, resolveGoTo: (v) => goToResolve && goToResolve(v) }
}

// Flush pending settle microtasks (registry promise → settle handler → reenqueue).
const flush = () => new Promise((r) => setTimeout(r, 0))

// Drive the recorded sei:action_complete events back through handleDispatch in
// FIFO order, mimicking the FSM's P2.1 queue. Only action_complete is pumped
// (loop_terminal / chat redrives are the brain's job, not the orchestrator's).
async function pumpActionCompletes(orch, reenqueued) {
  for (let guard = 0; guard < 64; guard++) {
    await flush()
    const next = reenqueued.find((e) => e.ev === 'sei:action_complete' && !e._done)
    if (!next) break
    next._done = true
    await orch.handleDispatch('sei:action_complete', next.d)
  }
  await flush()
}

describe('260703 stale pre-interrupt action_complete + mid-batch teardown drain', () => {
  it('(i) a stale tick-claimed settle does NOT stall the equip batch — all four equips execute, no iteration narrates it', async () => {
    _setTickIntervalForTests(10_000_000) // park the 10s auto-tick
    const { adapter, executed, resolveGoTo } = makeBatchAdapter()
    const reenqueued = []
    const reenqueue = (ev, d, p) => reenqueued.push({ ev, d, p: p ?? 2 })

    const batch = {
      text: 'gearing up',
      toolUses: [
        { id: 'say1', name: 'say', input: { text: 'equipping now' } },
        { id: 'eq1', name: 'equip', input: { item: 'diamond_helmet' } },
        { id: 'eq2', name: 'equip', input: { item: 'diamond_chestplate' } },
        { id: 'eq3', name: 'equip', input: { item: 'diamond_leggings' } },
        { id: 'eq4', name: 'equip', input: { item: 'diamond_boots' } },
      ],
    }
    const provider = makeProvider([
      // Call 1 (fresh loop, chat "come pick up the armor"): start goTo → suspend.
      { text: '', toolUses: [{ id: 'go1', name: 'goTo', input: { x: -28, y: 65, z: -10 } }] },
      // Call 2 (the "equip it" interrupt, delivered via the action-tick path
      // because goTo is in flight): the goTo settles DURING this call — exactly
      // as in the incident — then the model returns the say + 4-equip batch.
      async () => {
        resolveGoTo('reached')  // goTo settles (tick-claimed) before the batch dispatches
        await flush()           // let its settle handler null inFlight + enqueue the stale action_complete
        return batch
      },
      // Call 3+ (natural end-of-batch continuation): text-only, ends the loop.
      { text: 'all geared up', toolUses: [] },
    ])

    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue, _anthropicOverride: provider,
    })

    // Fresh loop opens and suspends on goTo.
    await orch.handleDispatch('sei:chat_received', chat('come pick up the full diamond armor set'))
    expect(orch.currentLoop?.inFlight?.name).toBe('goTo')

    // "equip it" lands while goTo is in flight → Change-1 tick path. Inside the
    // resulting LLM call the goTo settles, then the batch dispatches the helmet.
    await orch.handleDispatch('sei:chat_received', chat('equip it'))
    await flush()

    // Two action_complete events are now queued FIFO: the STALE tick-claimed
    // goTo settle first, then the helmet equip's settle.
    const acNames = reenqueued.filter((e) => e.ev === 'sei:action_complete').map((e) => e.d?.name)
    expect(acNames[0]).toBe('goTo') // stale one is ahead in the queue

    // Drain the queue. The stale goTo settle must be dropped (fix a), letting the
    // helmet's settle drain the remaining chest/legs/boots equips.
    await pumpActionCompletes(orch, reenqueued)

    // All four armor pieces were equipped — the batch was NOT stalled.
    const equipItems = executed.filter((e) => e.name === 'equip').map((e) => e.args.item)
    expect(equipItems).toEqual([
      'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
    ])
    // The say() line landed.
    expect(adapter.chat).toHaveBeenCalledWith('equipping now')
    // No LLM iteration was ever spent narrating the stale completion.
    const sawStaleNarration = provider.calls.some((c) =>
      JSON.stringify(c.messages ?? c).includes('goTo -> reached'))
    expect(sawStaleNarration).toBe(false)
    // The loop closed cleanly.
    expect(orch.currentLoop).toBeNull()
  })

  it('(ii) a loop torn down mid-batch drains its undispatched batch tools directly, with no extra LLM call', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, executed } = makeBatchAdapter()
    const reenqueued = []
    const reenqueue = (ev, d, p) => reenqueued.push({ ev, d, p: p ?? 2 })

    const provider = makeProvider([
      // Fresh loop: a batch whose FIRST tool (goTo) never settles, so the loop
      // stays suspended with the three equips stranded on loop._pendingToolUses.
      {
        text: 'gearing up',
        toolUses: [
          { id: 'say1', name: 'say', input: { text: 'gearing up' } },
          { id: 'go1', name: 'goTo', input: { x: 1, y: 64, z: 1 } },
          { id: 'eq1', name: 'equip', input: { item: 'diamond_helmet' } },
          { id: 'eq2', name: 'equip', input: { item: 'diamond_chestplate' } },
          { id: 'eq3', name: 'equip', input: { item: 'diamond_leggings' } },
        ],
      },
    ])

    const orch = createOrchestrator({
      adapter, config: makeConfig(), reenqueue, _anthropicOverride: provider,
    })

    await orch.handleDispatch('sei:chat_received', chat('armor up and come here'))
    // Suspended on goTo, with the equips queued behind it.
    expect(orch.currentLoop?.inFlight?.name).toBe('goTo')
    expect(orch.currentLoop?._pendingToolUses?.length).toBe(3)

    // An attack tears the loop down mid-batch (the one teardown path that can
    // reach teardownLoop with a live pending queue).
    await orch.handleDispatch('sei:attacked', { attackerLabel: 'zombie', attackerKind: 'mob' })
    await flush()

    // The three queued equips ran directly — the player's ordered actions still
    // happened even though the loop died.
    const equipItems = executed.filter((e) => e.name === 'equip').map((e) => e.args.item)
    expect(equipItems).toEqual(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings'])
    // The drain used NO LLM — exactly one personality call was ever made.
    expect(provider.calls.length).toBe(1)
    // Loop is gone; the attack was re-enqueued for a fresh reaction loop.
    expect(orch.currentLoop).toBeNull()
    expect(reenqueued.some((e) => e.ev === 'sei:attacked')).toBe(true)
  })
})
