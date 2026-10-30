// 261019 (quality pass 19): a mob hit used to wreck whatever walk was running.
// Retaliation called stopFollow() (the follow target was forgotten for good)
// and its 1s exit called pathfinder.stop() unconditionally, so a goTo or
// pickup walk hit on the way failed as "cant_reach (closest=3.4m)" on open
// ground (combat_night eval). Now the trail is paused with its target kept,
// and the exit stops the pathfinder only for this engagement's own pursuit.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import pkg from 'mineflayer-pathfinder'
import { startCombat } from './combat.js'
import { noteLostWeapon } from './weaponSelect.js'
import { startFollow, stopFollow, pauseFollow } from './follow.js'

const { goals } = pkg

vi.mock('./follow.js', () => ({
  startFollow: vi.fn(),
  stopFollow: vi.fn(),
  pauseFollow: vi.fn(),
}))

function makeBot() {
  const bot = new EventEmitter()
  const pos = (x, y, z) => ({ x, y, z, distanceTo: (p) => Math.hypot(p.x - x, p.y - y, p.z - z) })
  bot.entity = { id: 1, position: pos(0, 64, 0), velocity: { x: 0, y: 0, z: 0 } }
  const zombie = { id: 5, name: 'zombie', position: pos(1, 64, 0), yaw: 0 }
  bot.entities = { 1: bot.entity, 5: zombie }
  bot._zombie = zombie
  bot.pathfinder = { goal: null, setGoal: vi.fn(), stop: vi.fn(), setMovements: vi.fn() }
  bot.look = vi.fn()
  bot.attack = vi.fn()
  bot.swingArm = vi.fn()
  bot.inventory = { items: () => [] }
  bot.heldItem = null
  return bot
}

const cfg = { adapter: { kind: 'minecraft', minecraft: { attack_react_throttle_ms: 0 } } }

beforeEach(() => { vi.mocked(startFollow).mockClear(); vi.mocked(stopFollow).mockClear(); vi.mocked(pauseFollow).mockClear() })
afterEach(() => { vi.useRealTimers() })

describe('retaliation keeps the walk and the follow target', () => {
  it('pauses the trail instead of forgetting it', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    startCombat(bot, cfg)
    bot.emit('entityHurt', bot.entity, bot._zombie)
    expect(pauseFollow).toHaveBeenCalledTimes(1)
    expect(stopFollow).not.toHaveBeenCalled()
  })

  it('the exit leaves a running goTo goal alone and keeps its movements', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    startCombat(bot, cfg)
    const walk = new goals.GoalNear(20, 64, 0, 2)
    bot.pathfinder.goal = walk
    bot.emit('entityHurt', bot.entity, bot._zombie)
    vi.advanceTimersByTime(1000)
    expect(bot.pathfinder.stop).not.toHaveBeenCalled()
    expect(startFollow).toHaveBeenCalledWith(bot, cfg, { keepMovements: true })
  })

  it('with no walk running, the exit stops the pathfinder and restores the trail', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    startCombat(bot, cfg)
    bot.emit('entityHurt', bot.entity, bot._zombie)
    vi.advanceTimersByTime(1000)
    expect(bot.pathfinder.stop).toHaveBeenCalledTimes(1)
    expect(startFollow).toHaveBeenCalledWith(bot, cfg, { keepMovements: false })
  })

  // A goTo resumed through the fight: turning to the mob every 250ms fought
  // the pathfinder's steering and walked her off the route (pathing-repro
  // hit_walk_goto ended "stuck" 12 blocks off the line).
  it('swings without turning while an action walk is moving her', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    startCombat(bot, cfg)
    bot._seiActionActive = 1
    bot.pathfinder.isMoving = () => true
    bot.emit('entityHurt', bot.entity, bot._zombie)
    vi.advanceTimersByTime(600)
    expect(bot.attack).toHaveBeenCalled()
    expect(bot.look).not.toHaveBeenCalled()
  })

  it('still turns to the mob when standing still', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    startCombat(bot, cfg)
    bot._seiActionActive = 1
    bot.pathfinder.isMoving = () => false
    bot.emit('entityHurt', bot.entity, bot._zombie)
    vi.advanceTimersByTime(600)
    expect(bot.look).toHaveBeenCalled()
  })
})

// 261030 (quality pass 31): after a death took her weapon the turn says get
// away, and the 250ms swing-back loop turning her to the mob fought it. A bot
// that never had a weapon keeps swinging back (dev).
describe('own-hit swing-back after a death took her weapon', () => {
  it('never had a weapon: swings back as on dev', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    startCombat(bot, cfg)
    bot.emit('entityHurt', bot.entity, bot._zombie)
    vi.advanceTimersByTime(300)
    expect(pauseFollow).toHaveBeenCalledTimes(1)
    expect(bot.look).toHaveBeenCalled()
  })

  it('lost her weapon on death: the hit is reported, no swing-back, the trail is kept', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    noteLostWeapon(bot, [{ item: 'iron_sword', n: 1 }])
    const seen = []
    bot.on('sei:attacked', (p) => seen.push(p))
    startCombat(bot, cfg)
    bot.emit('entityHurt', bot.entity, bot._zombie)
    vi.advanceTimersByTime(1500)
    expect(seen).toHaveLength(1)
    expect(seen[0].attackerKind).toBe('hostile_mob')
    expect(pauseFollow).not.toHaveBeenCalled()
    expect(bot.look).not.toHaveBeenCalled()
    expect(bot.attack).not.toHaveBeenCalled()
  })
})
