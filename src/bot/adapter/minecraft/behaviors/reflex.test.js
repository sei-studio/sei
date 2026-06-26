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

import { describe, it, expect, vi, afterEach } from 'vitest'
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
  bot.pathfinder = {
    goal: null,
    setGoal(goal) { this.goal = goal; this._setCount = (this._setCount ?? 0) + 1 },
  }
  return bot
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
