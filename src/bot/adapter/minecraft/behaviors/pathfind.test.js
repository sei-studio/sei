// goTo() orphaned navigate() retry loop (Finding 6).
//
// navigate() races a wall-clock timeout against bot.pathfinder.goto(goal).
// When the timeout wins, goTo() has already returned to its caller â€” but the
// navigate() loop was still alive: if a reflex flee (bot._seiReflexActive)
// happened to be active at the moment the timeout rejected the in-flight
// goto, the old code treated that rejection as "flee took the goal" and
// looped back around to wait for the flee to clear, then re-issued
// `bot.pathfinder.goto(goal)` with the STALE destination â€” long after goTo
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

// Real minecraft-data registry (same pattern as craft.test.js) â€” Movements'
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

describe('goTo â€” orphaned navigate() retry loop after timeout (Finding 6)', () => {
  it('does not re-issue pathfinder.goto when a reflex yield resumes after the timeout already won the race', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeBot()

      // y stays equal to the bot's own y so composeVerticalHint doesn't
      // append an "unreachable" suffix â€” irrelevant to this test.
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
      // wake up from waitForReflexClear and re-issue a stale goto â€” goTo
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

// 261011 quality pass 2: the walk body, stuck bail, dig reach goal.
import { EventEmitter } from 'events'
import { companionMovements, GoalDigReach, stopPathfinderDig, STUCK_RESETS_TO_GIVE_UP, dropWalkOpts } from './pathfind.js'

function makeEmitterBot() {
  const bot = Object.assign(new EventEmitter(), makeBot())
  bot.on = EventEmitter.prototype.on.bind(bot)
  bot.off = EventEmitter.prototype.off.bind(bot)
  bot.emit = EventEmitter.prototype.emit.bind(bot)
  bot.entity.position = { x: 3.5, y: 0, z: 2.5 }
  return bot
}

describe('companionMovements (261011)', () => {
  it('never sprints, keeps digging a last resort, and can forbid digging', () => {
    const bot = makeBot()
    const m = companionMovements(bot)
    expect(m.allowSprinting).toBe(false)
    expect(m.digCost).toBe(8)
    expect(m.canDig).toBe(true)
    expect(companionMovements(bot, { canDig: false }).canDig).toBe(false)
  })

  // 261012: a drop walk must not bury the drop under a placed block, and a
  // gather walk must not scaffold with the item it is gathering.
  it('can forbid placing, or keep named items out of the scaffolding', () => {
    const bot = makeBot()
    const base = companionMovements(bot)
    expect(base.scafoldingBlocks.length).toBeGreaterThan(0)
    const noPlace = companionMovements(bot, { canPlace: false })
    expect(noPlace.scafoldingBlocks).toEqual([])
    expect(noPlace.allow1by1towers).toBe(false)
    const cobbleId = bot.registry.itemsByName.cobblestone.id
    expect(base.scafoldingBlocks).toContain(cobbleId)
    const keep = companionMovements(bot, { keepItems: ['cobblestone'] })
    expect(keep.scafoldingBlocks).not.toContain(cobbleId)
    expect(keep.scafoldingBlocks.length).toBe(base.scafoldingBlocks.length - 1)
  })

  // 261016 review: a walk out of a closed room cut through its planks.
  it('never breaks built blocks on the way, but still digs natural ground', () => {
    const bot = makeBot()
    const m = companionMovements(bot)
    const id = (n) => bot.registry.blocksByName[n].id
    for (const n of ['oak_planks', 'oak_door', 'glass', 'white_bed', 'chest', 'crafting_table', 'stone_bricks', 'oak_stairs', 'furnace']) {
      expect(m.blocksCantBreak.has(id(n)), n).toBe(true)
    }
    for (const n of ['stone', 'dirt', 'cobblestone', 'oak_log', 'oak_leaves', 'coal_ore', 'nether_quartz_ore', 'sand', 'deepslate']) {
      expect(m.blocksCantBreak.has(id(n)), n).toBe(false)
    }
  })

  it('goTo installs the no-sprint movements', async () => {
    const bot = makeBot()
    let installed = null
    bot.pathfinder.setMovements = (m) => { installed = m }
    bot.pathfinder.goto = vi.fn(async () => {})
    expect(await goTo(bot, 1, 0, 1, 1, 1000, undefined, { canDig: false })).toBe('reached')
    expect(installed.allowSprinting).toBe(false)
    expect(installed.canDig).toBe(false)
  })
})

describe('dropWalkOpts (261011)', () => {
  it('forbids digging only on the way to a tree drop', () => {
    for (const n of ['oak_log', 'birch_wood', 'crimson_stem', 'warped_hyphae', 'oak_leaves']) {
      expect(dropWalkOpts(n)).toEqual({ canDig: false, canPlace: false })
    }
    for (const n of ['stone', 'cobblestone', 'iron_ore', 'raw_iron', 'dirt', undefined]) {
      expect(dropWalkOpts(n)).toEqual({ canPlace: false })
    }
  })
})

describe('goTo stuck bail (261011)', () => {
  it('stops after repeated stuck resets and says where, instead of a bare timeout', async () => {
    const bot = makeEmitterBot()
    const p = goTo(bot, 10, 0, 10, 1, 60000)
    bot.emit('path_reset', 'chunk_loaded') // not a stuck reset, ignored
    for (let i = 0; i < STUCK_RESETS_TO_GIVE_UP; i++) bot.emit('path_reset', 'stuck')
    const r = await p
    expect(r).toMatch(/^stuck at 3,0,2, 9\.9m from 10,0,10: the path kept failing/)
    expect(bot.pathfinder.stop).toHaveBeenCalled()
    expect(bot.listenerCount('path_reset')).toBe(0)
  })

  // 261019 (pass 19): a resumable walk waiting out a fight heard the fight's
  // own pursuit getting stuck on the mob, and gave up on open ground.
  it('ignores stuck resets while another goal holds the pathfinder', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeEmitterBot()
      const pursuit = { name: 'GoalFollow' }
      let current
      Object.defineProperty(bot.pathfinder, 'goal', { get: () => current, configurable: true })
      bot.pathfinder.goto = vi.fn(async (g) => { current = g; await new Promise(() => {}) })
      const p = goTo(bot, 10, 0, 10, 1, 1000)
      current = pursuit
      for (let i = 0; i < STUCK_RESETS_TO_GIVE_UP; i++) bot.emit('path_reset', 'stuck')
      await vi.advanceTimersByTimeAsync(1000)
      expect(await p).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a stuck reset whose stall window held a fight', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeEmitterBot()
      const p = goTo(bot, 10, 0, 10, 1, 1000)
      bot._seiLastCombatAt = Date.now() - 1000
      for (let i = 0; i < STUCK_RESETS_TO_GIVE_UP; i++) bot.emit('path_reset', 'stuck')
      await vi.advanceTimersByTimeAsync(1000)
      expect(await p).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('one stuck reset is not enough to give up', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeEmitterBot()
      const p = goTo(bot, 10, 0, 10, 1, 1000)
      bot.emit('path_reset', 'stuck')
      await vi.advanceTimersByTimeAsync(1000)
      expect(await p).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('stopPathfinderDig (261011)', () => {
  it('a timed-out walk cancels the dig the pathfinder started', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeEmitterBot()
      bot.stopDigging = vi.fn()
      const p = goTo(bot, 10, 0, 10, 1, 1000)
      bot.targetDigBlock = { name: 'oak_log' } // pathfinder began breaking a block on the route
      await vi.advanceTimersByTimeAsync(1000)
      expect(await p).toBe('timeout')
      expect(bot.stopDigging).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves our own dig actions alone', () => {
    const bot = { targetDigBlock: { name: 'stone' }, _seiDigActive: 1, stopDigging: vi.fn() }
    stopPathfinderDig(bot)
    expect(bot.stopDigging).not.toHaveBeenCalled()
    bot._seiDigActive = 0
    stopPathfinderDig(bot)
    expect(bot.stopDigging).toHaveBeenCalledTimes(1)
  })
})

describe('GoalDigReach (261011)', () => {
  it('ends where the EYES reach the block, so a log five up the trunk needs no climb', () => {
    const g = new GoalDigReach(0, 68, 0, 4.2)
    // Standing on the ground next to the trunk: feet at y=64, eyes ~65.6,
    // block center 68.5. Distance ~3.1 from x=1.
    expect(g.isEnd({ x: 1, y: 64, z: 0 })).toBe(true)
    // GoalNear(â€¦,3) would demand the feet within 3 of y=68, i.e. a climb.
    expect(g.isEnd({ x: 6, y: 64, z: 0 })).toBe(false)
  })
})

describe('pursuitMovements (attack chase)', () => {
  it('sprints, unlike goTo and follow, with the same dig and drop tuning', async () => {
    const { pursuitMovements } = await import('./attack.js')
    const m = pursuitMovements(makeBot())
    expect(m.allowSprinting).toBe(true)
    expect(m.digCost).toBe(8)
    expect(m.maxDropDown).toBe(4)
  })
})

// 261015 quality pass 10: mineflayer-pathfinder's goto() resolves when a
// re-plan returns an empty path, which is also "no path from here". goTo used
// to call that 'reached' (cliff repro: "reached" a log 6 up a sheer mesa).
describe('goTo checks it actually ended at the goal (261015)', () => {
  it('turns a resolved goto that left the bot far from the goal into cant_reach', async () => {
    const bot = makeBot()
    bot.entity.position = { x: 180.5, y: 71, z: 6.5 }
    bot.pathfinder.goto = vi.fn(async () => {})
    const r = await goTo(bot, 184, 77, 6, 2, 1000)
    expect(r).toMatch(/^cant_reach \(closest=7\.0m to target 184,77,6\) â€” unreachable â€” try build to Y=77$/)
  })

  it('still reports reached at the goal, and within a block of the range', async () => {
    const bot = makeBot()
    bot.pathfinder.goto = vi.fn(async () => {})
    bot.entity.position = { x: 182.5, y: 71, z: 6.5 }
    expect(await goTo(bot, 184, 71, 6, 2, 1000)).toBe('reached')
    bot.entity.position = { x: 181.2, y: 71, z: 6.5 }
    expect(await goTo(bot, 184, 71, 6, 2, 1000)).toBe('reached')
  })

  it('measures a dig-reach walk from the eyes', async () => {
    const bot = makeBot()
    bot.pathfinder.goto = vi.fn(async () => {})
    bot.entity.position = { x: 1.5, y: 64, z: 0.5 }
    expect(await goTo(bot, 0, 68, 0, 3, 1000, undefined, { reach: 4.2 })).toBe('reached')
    bot.entity.position = { x: 9.5, y: 64, z: 0.5 }
    expect(await goTo(bot, 0, 68, 0, 3, 1000, undefined, { reach: 4.2 })).toMatch(/^cant_reach/)
  })
})

describe('companionMovements scaffolding (261015)', () => {
  it('may tower and bridge with common junk blocks, not only dirt and cobblestone', () => {
    const m = companionMovements(makeBot())
    for (const n of ['dirt', 'cobblestone', 'cobbled_deepslate', 'andesite', 'netherrack']) {
      expect(m.scafoldingBlocks).toContain(mcData.itemsByName[n].id)
    }
    expect(m.scafoldingBlocks).not.toContain(mcData.itemsByName.oak_planks.id)
    expect(m.scafoldingBlocks).not.toContain(mcData.itemsByName.sand.id)
  })
})

// 261019 (quality pass 19): a goTo cut off by another consumer of the
// pathfinder (a mob hit and its fight, a swim-up, a defend engagement) was
// reported as cant_reach. With opts.resume it waits for the body to be free
// and walks on; and a cut-off walk that already stands in range is reached.
describe('goTo after an interruption (261019)', () => {
  function interruptBot(startAt = { x: 0, y: 0, z: 0 }) {
    const bot = {}
    bot.entity = { position: { ...startAt } }
    bot.registry = mcData
    const calls = []
    bot.pathfinder = {
      goal: null,
      isMoving: () => false,
      setMovements: () => {},
      stop: vi.fn(),
      goto: vi.fn(() => new Promise((resolve, reject) => { calls.push({ resolve, reject }) })),
    }
    const named = (name) => { const e = new Error(name); e.name = name; return e }
    return { bot, calls, named }
  }

  it('without resume, an interruption is still cant_reach', async () => {
    const { bot, calls, named } = interruptBot()
    const p = goTo(bot, 20, 0, 0, 1, 5000)
    calls[0].reject(named('PathStopped'))
    expect(await p).toMatch(/^cant_reach/)
  })

  it('with resume, it waits until the fight is over and walks on', async () => {
    vi.useFakeTimers()
    try {
      const { bot, calls, named } = interruptBot()
      const p = goTo(bot, 20, 0, 0, 1, 20_000, undefined, { resume: true })
      // A defend engagement takes the body.
      bot._seiOffensiveTarget = 42
      calls[0].reject(named('GoalChanged'))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bot.pathfinder.goto).toHaveBeenCalledTimes(1)
      bot._seiOffensiveTarget = null
      await vi.advanceTimersByTimeAsync(400)
      expect(bot.pathfinder.goto).toHaveBeenCalledTimes(2)
      bot.entity.position = { x: 20, y: 0, z: 0 }
      calls[1].resolve()
      expect(await p).toBe('reached')
    } finally { vi.useRealTimers() }
  })

  it('a real NoPath is not resumed', async () => {
    const { bot, calls, named } = interruptBot()
    const p = goTo(bot, 20, 0, 0, 1, 5000, undefined, { resume: true })
    calls[0].reject(named('NoPath'))
    expect(await p).toMatch(/^cant_reach/)
    expect(bot.pathfinder.goto).toHaveBeenCalledTimes(1)
  })

  it('gives up after a few interruptions', async () => {
    vi.useFakeTimers()
    try {
      const { bot, calls, named } = interruptBot()
      const p = goTo(bot, 20, 0, 0, 1, 60_000, undefined, { resume: true })
      for (let i = 0; i < 4; i++) {
        calls[i].reject(named('PathStopped'))
        await vi.advanceTimersByTimeAsync(400)
      }
      expect(await p).toMatch(/^cant_reach/)
      expect(bot.pathfinder.goto).toHaveBeenCalledTimes(4)
    } finally { vi.useRealTimers() }
  })

  it('a cut-off walk that already stands in range is reached', async () => {
    const { bot, calls, named } = interruptBot({ x: 18.3, y: 0, z: 0 })
    const p = goTo(bot, 20, 0, 0, 2, 5000)
    calls[0].reject(named('PathStopped'))
    expect(await p).toBe('reached')
  })
})




