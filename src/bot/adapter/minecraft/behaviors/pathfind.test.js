// goTo() orphaned navigate() retry loop (Finding 6).
//
// navigate() races a wall-clock timeout against bot.pathfinder.goto(goal).
// When the timeout wins, goTo() has already returned to its caller — but the
// navigate() loop was still alive: if a reflex flee (bot._seiReflexActive)
// happened to be active at the moment the timeout rejected the in-flight
// goto, the old code treated that rejection as "flee took the goal" and
// looped back around to wait for the flee to clear, then re-issued
// `bot.pathfinder.goto(goal)` with the STALE destination — long after goTo
// already resolved and some other consumer (e.g. the follow tick) may have
// installed a different goal. The `settled` flag added in pathfind.js must
// stop that: once the race is settled, the orphaned loop exits without
// touching pathfinder again.

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'module'
import { goTo } from './pathfind.js'

const require = createRequire(import.meta.url)
const VERSION = '1.21.1'
const mcData = require('minecraft-data')(VERSION)

// Real minecraft-data registry (same pattern as craft.test.js) — Movements'
// constructor reads real block tables (registry.blocksByName.chest, etc.), so
// a bare stub object is not enough.
function makeBot() {
  const bot = {}
  bot.entity = { position: { x: 0, y: 0, z: 0 } }
  bot.registry = mcData

  // Reflex mutex flag the reflex micro-controller (reflex.js) sets while a
  // creeper-flee owns the pathfinder goal. Starts clear.
  bot._seiReflexActive = false

  // Fake pathfinder: goto() returns a controllable pending promise; stop()
  // rejects whichever goto is currently in flight, mirroring mineflayer-
  // pathfinder's behavior of throwing out of goto() when stop() is called.
  const pending = []
  bot.pathfinder = {
    setMovements: () => {},
    goto: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject })
        })
    ),
    stop: vi.fn(() => {
      const p = pending.pop()
      if (p) p.reject(new Error('stopped'))
    }),
  }
  return bot
}

describe('goTo — orphaned navigate() retry loop after timeout (Finding 6)', () => {
  it('does not re-issue pathfinder.goto when a reflex yield resumes after the timeout already won the race', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeBot()

      // y stays equal to the bot's own y so composeVerticalHint doesn't
      // append an "unreachable" suffix — irrelevant to this test.
      const resultPromise = goTo(bot, 10, 0, 10, 1, 1000)

      // The goto call happens synchronously inside navigate() before its
      // first await, so by now bot.pathfinder.goto has already been called
      // once and is pending. Simulate a reflex creeper-flee kicking in while
      // that goto is in flight.
      bot._seiReflexActive = true

      // Advance past the wall-clock timeout: the timeout handler sets
      // `settled = true`, calls pathfinder.stop() (which rejects the
      // in-flight goto), and resolves the race with 'timeout'.
      await vi.advanceTimersByTimeAsync(1000)

      expect(await resultPromise).toBe('timeout')
      expect(bot.pathfinder.goto).toHaveBeenCalledTimes(1)

      // The reflex flee now clears, as it eventually does in real play. The
      // orphaned navigate() loop (still alive in the background) must NOT
      // wake up from waitForReflexClear and re-issue a stale goto — goTo
      // already returned to its caller, who may have installed a different
      // goal by now.
      bot._seiReflexActive = false
      await vi.advanceTimersByTimeAsync(500) // past waitForReflexClear's 120ms poll

      expect(bot.pathfinder.goto).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
