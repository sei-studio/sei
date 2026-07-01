// src/bot/adapter/minecraft/behaviors/reflex.test.js
//
// Reflex evasion micro-controller (Phase 17, plan 17-01).
//   Task 2 — ray math (closestApproach) + threat scan/priority + non-goal
//            pulse responses (arrow sidestep, melee strafe).
//   Task 3 — creeper flee goal takeover + _seiReflexActive mutex + single
//            sei:reflex announcement per engagement.
//
// The arrow ray test is the unit core: closest-approach (point-to-line)
// distance of the arrow's ray to the bot, plus an `ahead` flag so an arrow
// that already flew past never triggers a dodge.

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  startReflex,
  closestApproach,
  scanThreats,
  resolveReflexThresholds,
} from './reflex.js'

function makeBot() {
  const bot = new EventEmitter()
  bot.entity = {
    id: 1,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  }
  bot.health = 20
  bot.entities = { 1: bot.entity }
  bot._controls = {}
  bot.setControlState = (name, state) => { bot._controls[name] = state }
  bot.lookAt = () => {}
  bot._goalLog = []
  // Mirror mineflayer-pathfinder: setGoal stores the goal and emits
  // goal_updated (the installed ^2.4.5 does not expose bot.pathfinder.goal, so
  // the reflex loop tracks the external goal via this event).
  bot.pathfinder = {
    goal: null,
    dynamic: false,
    setGoal(goal, dynamic = false) {
      this.goal = goal
      this.dynamic = dynamic
      this._setCount = (this._setCount ?? 0) + 1
      bot._goalLog.push(goal)
      bot.emit('goal_updated', goal, dynamic)
    },
  }
  return bot
}

// A creeper entity at a given X distance along +x.
function creeperAt(d, metadata) {
  return { id: 7, name: 'creeper', position: { x: d, y: 0, z: 0 }, metadata }
}

const cfg = (mc = {}) => ({ adapter: { kind: 'minecraft', minecraft: mc } })

afterEach(() => {
  vi.useRealTimers()
})

describe('closestApproach (arrow ray math)', () => {
  it('arrow aimed directly at the bot → missDist ≈ 0, ahead = true', () => {
    // Arrow at (5,0,0) flying toward the origin where the bot stands.
    const r = closestApproach({ x: 5, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(r.ahead).toBe(true)
    expect(r.missDist).toBeCloseTo(0, 5)
  })

  it('arrow already past the bot (velocity points away) → ahead = false', () => {
    // Arrow at the origin moving in +x, bot behind it at -x: it is leaving.
    const r = closestApproach({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -10, y: 0, z: 0 })
    expect(r.ahead).toBe(false)
  })

  it('arrow offset 5 blocks laterally → missDist ≈ 5, ahead = true (no dodge)', () => {
    // Arrow flies along +x; bot is 5 blocks off that line on +z.
    const r = closestApproach({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 10, y: 0, z: 5 })
    expect(r.ahead).toBe(true)
    expect(r.missDist).toBeCloseTo(5, 5)
  })
})

describe('resolveReflexThresholds (D-06 per-persona hook)', () => {
  it('returns the fixed config defaults and ignores personaWeights today', () => {
    const mc = {
      arrow_watch_blocks: 16, arrow_miss_threshold: 1.2,
      creeper_flee_enter_blocks: 8, creeper_flee_exit_blocks: 12, melee_kite_blocks: 4.5,
    }
    const a = resolveReflexThresholds(mc, undefined)
    const b = resolveReflexThresholds(mc, { aggression: 99 }) // weights ignored this phase
    expect(a).toEqual(b)
    expect(a.creeper_flee_enter_blocks).toBe(8)
    expect(a.arrow_miss_threshold).toBe(1.2)
  })
})

describe('scanThreats (classification + priority)', () => {
  it('prioritizes a fusing creeper over an incoming arrow', () => {
    const bot = makeBot()
    // Arrow on a direct collision course (would be an arrow threat on its own).
    bot.entities[2] = { id: 2, name: 'arrow', position: { x: 5, y: 0, z: 0 }, velocity: { x: -1, y: 0, z: 0 } }
    // A creeper mid-fuse (metadata[16] === 1) — panic override.
    bot.entities[3] = { id: 3, name: 'creeper', position: { x: 6, y: 0, z: 0 }, metadata: { 16: 1 } }

    const threat = scanThreats(bot, cfg().adapter.minecraft)
    expect(threat).toBeTruthy()
    expect(threat.kind).toBe('creeper')
    expect(threat.panic).toBe(true)
  })

  it('returns an arrow threat when only an incoming arrow is present', () => {
    const bot = makeBot()
    bot.entities[2] = { id: 2, name: 'arrow', position: { x: 5, y: 0, z: 0 }, velocity: { x: -1, y: 0, z: 0 } }
    const threat = scanThreats(bot, cfg().adapter.minecraft)
    expect(threat?.kind).toBe('arrow')
  })

  it('ignores an arrow that misses by more than the threshold', () => {
    const bot = makeBot()
    // Flies along +x, 5 blocks off the bot line → missDist 5 ≫ 1.2.
    bot.entities[2] = { id: 2, name: 'arrow', position: { x: 0, y: 0, z: 5 }, velocity: { x: 1, y: 0, z: 0 } }
    const threat = scanThreats(bot, cfg().adapter.minecraft)
    expect(threat).toBeNull()
  })
})

describe('startReflex pulse responses (no pathfinder goal contention)', () => {
  it('arrow threat issues a left/right control-state pulse and never sets a goal', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    bot.entities[2] = { id: 2, name: 'arrow', position: { x: 5, y: 0, z: 0 }, velocity: { x: -1, y: 0, z: 0 } }
    const dispose = startReflex(bot, cfg())
    bot.emit('physicsTick')
    const pressed = ['left', 'right'].some((s) => bot._controls[s] === true)
    expect(pressed).toBe(true)
    expect(bot.pathfinder.goal).toBeNull() // arrow dodge is a pulse, not a goal
    dispose()
  })

  it('melee strafe is suppressed when bot._seiOffensiveTarget matches the mob id', () => {
    const bot = makeBot()
    bot.entities[2] = { id: 2, name: 'zombie', position: { x: 3, y: 0, z: 0 } }
    bot._seiOffensiveTarget = 2 // we are deliberately attacking this mob
    const dispose = startReflex(bot, cfg())
    bot.emit('physicsTick')
    // No strafe control states asserted while offensively engaged.
    const strafed = ['left', 'right'].some((s) => bot._controls[s] === true)
    expect(strafed).toBe(false)
    dispose()
  })

  it('releases leftover strafe control states once the melee mob is gone', () => {
    const bot = makeBot()
    bot.entities[2] = { id: 2, name: 'zombie', position: { x: 3, y: 0, z: 0 } }
    const dispose = startReflex(bot, cfg())
    bot.emit('physicsTick') // strafing this tick
    expect(['left', 'right'].some((s) => bot._controls[s] === true)).toBe(true)
    // Mob leaves scan range → the next tick must drop the strafe controls so the
    // bot does not keep drifting after the fight.
    delete bot.entities[2]
    bot.emit('physicsTick')
    expect(['left', 'right', 'forward', 'back'].some((s) => bot._controls[s] === true)).toBe(false)
    dispose()
  })

  it('does NOT clear forward/back on a quiet tick when it was never strafing', () => {
    const bot = makeBot()
    bot._controls.forward = true // e.g. the pathfinder is mid-move
    const dispose = startReflex(bot, cfg())
    bot.emit('physicsTick') // no threats → releaseStrafe is a guarded no-op
    expect(bot._controls.forward).toBe(true)
    dispose()
  })

  it('reflex_enabled:false returns a no-op disposer and never subscribes', () => {
    const bot = makeBot()
    const dispose = startReflex(bot, cfg({ reflex_enabled: false }))
    expect(bot.listenerCount('physicsTick')).toBe(0)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('dispose() removes the physicsTick listener (no leaked handler)', () => {
    const bot = makeBot()
    const dispose = startReflex(bot, cfg())
    expect(bot.listenerCount('physicsTick')).toBe(1)
    dispose()
    expect(bot.listenerCount('physicsTick')).toBe(0)
  })
})

describe('startReflex creeper flee (goal takeover + mutex + announcement)', () => {
  // GoalInvert/GoalFollow live in the same package the loop uses.
  let GoalInvert
  beforeAll(async () => {
    const pkg = (await import('mineflayer-pathfinder')).default
    GoalInvert = pkg.goals.GoalInvert
  })

  it('enters flee: sets _seiReflexActive, saves the goal, installs GoalInvert', () => {
    const bot = makeBot()
    const dispose = startReflex(bot, cfg())
    const priorGoal = { _id: 'gather-goal' }
    bot.pathfinder.setGoal(priorGoal, true) // an in-flight action goal

    bot.entities[7] = creeperAt(7) // inside the 8-block enter band
    bot.emit('physicsTick')

    expect(bot._seiReflexActive).toBe(true)
    expect(bot._seiSavedGoal).toBe(priorGoal)
    expect(bot.pathfinder.goal).toBeInstanceOf(GoalInvert)
    dispose()
  })

  it('drives a creeper 7→13 blocks: GoalInvert set once, saved goal restored once (no oscillation)', () => {
    const bot = makeBot()
    const dispose = startReflex(bot, cfg())
    const priorGoal = { _id: 'gather-goal' }
    bot.pathfinder.setGoal(priorGoal, true)

    bot.entities[7] = creeperAt(7)
    bot.emit('physicsTick') // enter flee

    // Inside the hysteresis band (8 < d ≤ 12): keep fleeing, no new setGoal.
    bot.entities[7].position.x = 9
    bot.emit('physicsTick')
    bot.entities[7].position.x = 11
    bot.emit('physicsTick')

    // Past the exit band → restore.
    bot.entities[7].position.x = 13
    bot.emit('physicsTick')

    const invertSets = bot._goalLog.filter((g) => g instanceof GoalInvert)
    expect(invertSets).toHaveLength(1) // exactly one flee takeover
    expect(bot._seiReflexActive).toBe(false)
    expect(bot.pathfinder.goal).toBe(priorGoal) // restored
    dispose()
  })

  it('emits exactly one sei:reflex per engagement across many in-range ticks', () => {
    const bot = makeBot()
    const events = []
    bot.on('sei:reflex', (p) => events.push(p))
    const dispose = startReflex(bot, cfg())

    bot.entities[7] = creeperAt(5) // well inside the enter band
    for (let i = 0; i < 6; i++) bot.emit('physicsTick')

    expect(events).toHaveLength(1)
    expect(events[0].threat).toBe('creeper')
    dispose()
  })

  it('a fusing creeper panics into flee regardless of distance', () => {
    const bot = makeBot()
    const dispose = startReflex(bot, cfg())
    bot.entities[7] = creeperAt(20, { 16: 1 }) // far, but mid-fuse
    bot.emit('physicsTick')
    expect(bot._seiReflexActive).toBe(true)
    dispose()
  })
})
