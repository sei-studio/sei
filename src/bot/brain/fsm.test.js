// Tests for the FSM preempt hook (onPreempt) added to unblock the dispatch
// thread when a player chat / attack arrives while a mid-loop LLM call is
// parked inside onDispatch. See createPriorityQueue({ onPreempt }).

import { describe, it, expect, vi } from 'vitest'
import { createPriorityQueue, Priority } from './fsm.js'

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
