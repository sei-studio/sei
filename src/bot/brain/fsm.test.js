// Tests for the FSM preempt hook (onPreempt) added to unblock the dispatch
// thread when a player chat / attack arrives while a mid-loop LLM call is
// parked inside onDispatch. See createPriorityQueue({ onPreempt }).

import { describe, it, expect, vi } from 'vitest'
import { createPriorityQueue, Priority, attackedPriority } from './fsm.js'

// Drain the queue's setImmediate-chained dispatch loop. processNext handles ONE
// item then re-schedules itself via setImmediate, so draining K items needs K
// cycles — a single macrotask (setTimeout 0) races under load and could observe
// 1 dispatch where the test expects 2. Pump several setImmediate cycles so a
// multi-item enqueue settles deterministically.
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
}

describe('createPriorityQueue onPreempt hook', () => {
  it('calls onPreempt for a player chat and SKIPS enqueue when claimed', async () => {
    const onDispatch = vi.fn()
    const onPreempt = vi.fn(() => true) // claimed
    const q = createPriorityQueue({ onDispatch, onPreempt, idleFallbackMs: 1_000_000 })

    q.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true, text: 'hi' })
    await flush()

    expect(onPreempt).toHaveBeenCalledTimes(1)
    expect(onPreempt).toHaveBeenCalledWith('sei:chat_received', { playerSpoke: true, text: 'hi' })
    // Claimed → the event is folded into the running loop, not dispatched.
    expect(onDispatch).not.toHaveBeenCalled()
    q.dispose()
  })

  it('calls onPreempt for an attack but STILL dispatches when not claimed', async () => {
    const onDispatch = vi.fn()
    const onPreempt = vi.fn(() => false) // unblock only, do not claim
    const q = createPriorityQueue({ onDispatch, onPreempt, idleFallbackMs: 1_000_000 })

    q.enqueue(Priority.P0_SAFETY, 'sei:attacked', { entityId: 7 })
    await flush()

    expect(onPreempt).toHaveBeenCalledWith('sei:attacked', { entityId: 7 })
    // Not claimed → the attack is dispatched through its own branch.
    expect(onDispatch).toHaveBeenCalledTimes(1)
    expect(onDispatch.mock.calls[0][0]).toBe('sei:attacked')
    q.dispose()
  })

  it('does NOT call onPreempt for non-chat / non-attack events (idle, action_tick)', async () => {
    const onDispatch = vi.fn()
    const onPreempt = vi.fn(() => true)
    const q = createPriorityQueue({ onDispatch, onPreempt, idleFallbackMs: 1_000_000 })

    q.enqueue(Priority.P3_IDLE, 'sei:idle', {})
    q.enqueue(Priority.P2_ACTION_TICK, 'sei:action_tick', { name: 'follow' })
    await flush()

    expect(onPreempt).not.toHaveBeenCalled()
    // Both still dispatch normally.
    expect(onDispatch).toHaveBeenCalledTimes(2)
    q.dispose()
  })

  it('does NOT call onPreempt for a non-player (system) chat', async () => {
    const onDispatch = vi.fn()
    const onPreempt = vi.fn(() => true)
    const q = createPriorityQueue({ onDispatch, onPreempt, idleFallbackMs: 1_000_000 })

    q.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: false, text: 'server msg' })
    await flush()

    expect(onPreempt).not.toHaveBeenCalled()
    expect(onDispatch).toHaveBeenCalledTimes(1)
    q.dispose()
  })

  it('works without an onPreempt hook (back-compat): chat dispatches normally', async () => {
    const onDispatch = vi.fn()
    const q = createPriorityQueue({ onDispatch, idleFallbackMs: 1_000_000 })

    q.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true, text: 'hi' })
    await flush()

    expect(onDispatch).toHaveBeenCalledTimes(1)
    expect(onDispatch.mock.calls[0][0]).toBe('sei:chat_received')
    q.dispose()
  })

  it('a thrown onPreempt does not break enqueue (falls through to dispatch)', async () => {
    const onDispatch = vi.fn()
    const onPreempt = vi.fn(() => { throw new Error('boom') })
    const q = createPriorityQueue({
      onDispatch,
      onPreempt,
      idleFallbackMs: 1_000_000,
      logger: { warn: () => {} },
    })

    q.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true, text: 'hi' })
    await flush()

    // Hook threw → not claimed → event still dispatched (no message lost).
    expect(onDispatch).toHaveBeenCalledTimes(1)
    q.dispose()
  })
})

// A proactive reflex warning arrives on the 'sei:attacked' event but tagged
// attackerKind:'reflex'. The bot was NOT hit (reflex.js already evaded); the
// warning is conversation-tier, so it must never outrank or abort player chat.
// These tests pin the two mechanisms that keep it at P1: the attackedPriority
// helper (used by index.js onAttacked) and the enqueue-time onPreempt fast-path
// exclusion.
describe('reflex-tagged sei:attacked is conversation-tier, not safety-tier', () => {
  it('(i) attackedPriority: reflex → P1_CHAT, real attack (player/mob/unknown) → P0_SAFETY', () => {
    expect(attackedPriority({ attackerKind: 'reflex' })).toBe(Priority.P1_CHAT)
    expect(attackedPriority({ attackerKind: 'player' })).toBe(Priority.P0_SAFETY)
    expect(attackedPriority({ attackerKind: 'mob' })).toBe(Priority.P0_SAFETY)
    expect(attackedPriority({})).toBe(Priority.P0_SAFETY)
    expect(attackedPriority(undefined)).toBe(Priority.P0_SAFETY)
  })

  it('(ii) a reflex sei:attacked does NOT trigger the onPreempt abort fast-path', async () => {
    const onDispatch = vi.fn()
    const onPreempt = vi.fn(() => false)
    const q = createPriorityQueue({ onDispatch, onPreempt, idleFallbackMs: 1_000_000 })

    // Enqueued at the tier attackedPriority assigns it (P1_CHAT).
    q.enqueue(attackedPriority({ attackerKind: 'reflex' }), 'sei:attacked', {
      attackerKind: 'reflex',
      attackerLabel: 'a creeper',
    })
    await flush()

    // Fast-path excluded → no attempt to abort a parked LLM call. It still
    // dispatches normally through the queue.
    expect(onPreempt).not.toHaveBeenCalled()
    expect(onDispatch).toHaveBeenCalledTimes(1)
    expect(onDispatch.mock.calls[0][0]).toBe('sei:attacked')
    q.dispose()
  })

  it('(ii) a REAL attack sei:attacked STILL triggers the onPreempt fast-path', async () => {
    const onDispatch = vi.fn()
    const onPreempt = vi.fn(() => false)
    const q = createPriorityQueue({ onDispatch, onPreempt, idleFallbackMs: 1_000_000 })

    q.enqueue(attackedPriority({ attackerKind: 'mob' }), 'sei:attacked', { attackerKind: 'mob' })
    await flush()

    expect(onPreempt).toHaveBeenCalledTimes(1)
    expect(onPreempt.mock.calls[0][0]).toBe('sei:attacked')
    q.dispose()
  })

  it('a reflex does NOT outrank a pending player chat (FIFO within P1); a real attack DOES (P0 first)', async () => {
    // Ordering proof through the real queue. No onPreempt so the fast-path is a
    // no-op; nothing is in flight at enqueue time so the chat→P0 promotion does
    // not apply. Priority ordering alone decides dispatch order.
    const order = []
    const onDispatch = vi.fn((event) => { order.push(event) })
    const q = createPriorityQueue({ onDispatch, idleFallbackMs: 1_000_000 })

    // Player chat queued FIRST, then a reflex — both land at P1_CHAT.
    q.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true, text: 'hi' })
    q.enqueue(attackedPriority({ attackerKind: 'reflex' }), 'sei:attacked', { attackerKind: 'reflex' })
    await flush()

    // Same tier → FIFO → the waiting player is answered before the heads-up.
    expect(order).toEqual(['sei:chat_received', 'sei:attacked'])
    q.dispose()

    // Contrast: a REAL attack queued AFTER the chat still preempts it (P0 < P1).
    const order2 = []
    const onDispatch2 = vi.fn((event) => { order2.push(event) })
    const q2 = createPriorityQueue({ onDispatch: onDispatch2, idleFallbackMs: 1_000_000 })
    q2.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true, text: 'hi' })
    q2.enqueue(attackedPriority({ attackerKind: 'player' }), 'sei:attacked', { attackerKind: 'player' })
    await flush()
    expect(order2).toEqual(['sei:attacked', 'sei:chat_received'])
    q2.dispose()
  })
})

describe('createPriorityQueue setHold (game pause, 260725)', () => {
  it('holds every event the predicate rejects, KEEPING it queued for release', async () => {
    const order = []
    const onDispatch = vi.fn((event) => { order.push(event) })
    const q = createPriorityQueue({ onDispatch, idleFallbackMs: 1_000_000 })

    q.setHold(() => false) // pause: nothing allowed
    q.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true, text: 'hello?' })
    await flush()
    expect(onDispatch).not.toHaveBeenCalled()

    q.setHold(null) // unpause: the queued chat dispatches now
    await flush()
    expect(order).toEqual(['sei:chat_received'])
    q.dispose()
  })

  it('dispatches an allowed event even when a blocked higher-priority item sits ahead of it', async () => {
    const order = []
    const onDispatch = vi.fn((event) => { order.push(event) })
    const q = createPriorityQueue({ onDispatch, idleFallbackMs: 1_000_000 })

    // Only voice-call lines pass (the pause predicate's shape).
    q.setHold((event, data) => event === 'sei:chat_received' && data?.voice === true)
    // A P0 attack lands on the frozen bot, then a voice line arrives behind it.
    q.enqueue(Priority.P0_SAFETY, 'sei:attacked', { attackerKind: 'mob' })
    q.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true, voice: true, seiChat: true, text: 'you there?' })
    await flush()

    // The voice line dispatched; the attack stayed queued behind the hold.
    expect(order).toEqual(['sei:chat_received'])

    q.setHold(null)
    await flush()
    expect(order).toEqual(['sei:chat_received', 'sei:attacked'])
    q.dispose()
  })

  it('purges queued settle ticks (sei:idle / sei:loop_end) when the hold engages', async () => {
    const order = []
    const onDispatch = vi.fn((event, data) => { order.push({ event, data }) })
    const q = createPriorityQueue({ onDispatch, idleFallbackMs: 1_000_000 })

    // Stall the dispatcher with a long-running dispatch so ticks accumulate.
    let releaseFirst
    onDispatch.mockImplementationOnce(() => new Promise((r) => { releaseFirst = r }))
    q.enqueue(Priority.P2_MOVEMENT, 'sei:movement', {})
    await flush()
    q.enqueue(Priority.P3_IDLE, 'sei:idle', { quietMs: 1 })
    q.enqueue(Priority.P2_5_LOOP_END, 'sei:loop_end', {})

    q.setHold(() => false) // pause: aborts the in-flight dispatch + purges ticks
    releaseFirst?.()
    await flush()
    q.setHold(null) // resume with an explicit fresh tick, like the orchestrator does
    q.enqueue(Priority.P3_IDLE, 'sei:idle', { reason: 'game_unpaused' })
    await flush()

    // The stale idle/loop_end never dispatched; the explicit resume tick did
    // (enqueue-time idle dedupe would have swallowed it had the purge not run).
    const events = order.map((o) => o.event)
    expect(events.filter((e) => e === 'sei:loop_end')).toEqual([])
    expect(order.filter((o) => o.event === 'sei:idle').map((o) => o.data?.reason)).toEqual(['game_unpaused'])
    q.dispose()
  })

  it('disarms the idle timer while held and re-arms on release', async () => {
    vi.useFakeTimers()
    const onDispatch = vi.fn()
    const q = createPriorityQueue({ onDispatch, idleFallbackMs: 50 })

    q.setHold(() => false)
    await vi.advanceTimersByTimeAsync(500)
    expect(onDispatch).not.toHaveBeenCalled() // no idle ticks pile up while paused

    q.setHold(null)
    await vi.advanceTimersByTimeAsync(500)
    expect(onDispatch).toHaveBeenCalled()
    expect(onDispatch.mock.calls[0][0]).toBe('sei:idle')
    q.dispose()
    vi.useRealTimers()
  })
})
