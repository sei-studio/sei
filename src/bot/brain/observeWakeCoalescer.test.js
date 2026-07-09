// 260708: the in-game brain now wakes on EVERY observed call line (the
// name-gate is gone — the user wants the bot responsive to the whole call,
// choosing silence itself). A companion's spoken turn arrives as separate
// mirrored sentences, so without coalescing one utterance would fire several
// P1 wakes ("make sure it doesn't fire twice to each message"). These pin the
// coalescer: same-speaker lines within the debounce window collapse to ONE
// wake with the joined text; a different speaker flushes the pending wake
// first; dispose() drops a pending wake (bot stop).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createObserveWakeCoalescer } from './index.js'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createObserveWakeCoalescer', () => {
  it('coalesces same-speaker lines into one wake with the joined text', () => {
    const fire = vi.fn()
    const c = createObserveWakeCoalescer(fire, 700)

    c.push('Marv', 'sui, you good?')
    c.push('Marv', 'you went quiet.')
    vi.advanceTimersByTime(699)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(fire).toHaveBeenCalledTimes(1)
    expect(fire).toHaveBeenCalledWith('Marv', 'sui, you good? you went quiet.')
  })

  it('each new line re-arms the window (a slow multi-sentence turn still fires once)', () => {
    const fire = vi.fn()
    const c = createObserveWakeCoalescer(fire, 700)

    c.push('Marv', 'one.')
    vi.advanceTimersByTime(500)
    c.push('Marv', 'two.')
    vi.advanceTimersByTime(500)
    expect(fire).not.toHaveBeenCalled() // window re-armed at "two."
    vi.advanceTimersByTime(200)

    expect(fire).toHaveBeenCalledTimes(1)
    expect(fire).toHaveBeenCalledWith('Marv', 'one. two.')
  })

  it('a line from a different speaker flushes the pending wake first (ordering holds)', () => {
    const fire = vi.fn()
    const c = createObserveWakeCoalescer(fire, 700)

    c.push('Marv', 'the void awaits.')
    c.push('Lyra', 'ready when you are.')

    expect(fire).toHaveBeenCalledTimes(1)
    expect(fire).toHaveBeenNthCalledWith(1, 'Marv', 'the void awaits.')

    vi.advanceTimersByTime(700)
    expect(fire).toHaveBeenCalledTimes(2)
    expect(fire).toHaveBeenNthCalledWith(2, 'Lyra', 'ready when you are.')
  })

  it('separate utterances (outside the window) fire separately', () => {
    const fire = vi.fn()
    const c = createObserveWakeCoalescer(fire, 700)

    c.push('Marv', 'first.')
    vi.advanceTimersByTime(700)
    c.push('Marv', 'second.')
    vi.advanceTimersByTime(700)

    expect(fire).toHaveBeenCalledTimes(2)
    expect(fire).toHaveBeenNthCalledWith(1, 'Marv', 'first.')
    expect(fire).toHaveBeenNthCalledWith(2, 'Marv', 'second.')
  })

  it('dispose() drops a pending wake so it cannot fire into a stopped brain', () => {
    const fire = vi.fn()
    const c = createObserveWakeCoalescer(fire, 700)

    c.push('Marv', 'later.')
    c.dispose()
    vi.advanceTimersByTime(1000)

    expect(fire).not.toHaveBeenCalled()
  })
})
