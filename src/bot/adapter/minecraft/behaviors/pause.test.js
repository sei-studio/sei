// src/bot/adapter/minecraft/behaviors/pause.test.js
//
// Play/pause body freeze (260725). Pausing the brain only stops LLM turns —
// these tests pin the ADAPTER side: the freeze switch itself (goal dropped,
// controls released, auto-eat off, mutexes cleared), the re-apply hook a
// reconnect goes through, and the paused early-returns in the autonomous
// loops that would otherwise keep the body moving (reflex evasion, combat
// retaliation, follow trailing).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

// startFollow builds `new Movements(bot)`, which walks a real prismarine
// registry we have no bot for. Stub ONLY Movements; the goals classes stay
// real so the reflex flee assertions below test the actual goal takeover.
vi.mock('mineflayer-pathfinder', async (importOriginal) => {
  const actual = await importOriginal()
  const orig = actual.default ?? actual
  return { default: { ...orig, Movements: class Movements {} } }
})

import { setWorldPaused, applyWorldPause, isWorldPaused } from './pause.js'
import { startReflex } from './reflex.js'
import { startCombat } from './combat.js'
import { startFollow, setFollowTarget, stopFollow } from './follow.js'

function makeBot() {
  const bot = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0) }
  bot.health = 20
  bot.entities = { 1: bot.entity }
  bot._controls = {}
  bot.setControlState = (name, state) => { bot._controls[name] = state }
  bot.clearControlStates = () => { bot._controls = {} }
  bot.lookAt = () => {}
  bot.look = () => {}
  bot.attack = vi.fn()
  bot.swingArm = () => {}
  bot.stopDigging = vi.fn()
  bot.deactivateItem = vi.fn()
  bot.autoEat = { enableAuto: vi.fn(), disableAuto: vi.fn() }
  bot._goalLog = []
  // follow.js loads the pathfinder plugin itself unless it is already there.
  bot.hasPlugin = () => true
  bot.pathfinder = {
    goal: null,
    dynamic: false,
    isMoving: () => false,
    setMovements: () => {},
    stop: vi.fn(),
    setGoal(goal, dynamic = false) {
      this.goal = goal
      this.dynamic = dynamic
      bot._goalLog.push(goal)
      bot.emit('goal_updated', goal, dynamic)
    },
  }
  return bot
}

const cfg = (mc = {}) => ({ adapter: { kind: 'minecraft', minecraft: mc } })

// A creeper mid-fuse: the one reflex threat that takes the pathfinder goal.
function fusingCreeper(d) {
  return { id: 7, name: 'creeper', position: { x: d, y: 0, z: 0 }, metadata: { 16: 1 } }
}

afterEach(() => {
  vi.useRealTimers()
  stopFollow()
  // Never leave the module-scoped switch engaged for the next test file.
  setWorldPaused(null, false)
})

describe('setWorldPaused', () => {
  it('brings the body to a full stop on engage', () => {
    const bot = makeBot()
    bot.pathfinder.setGoal({ some: 'goal' }, true)
    bot.setControlState('forward', true)

    setWorldPaused(bot, true)

    expect(bot._seiPaused).toBe(true)
    expect(isWorldPaused()).toBe(true)
    expect(bot.pathfinder.goal).toBe(null)
    expect(bot.pathfinder.stop).toHaveBeenCalled()
    expect(bot._controls).toEqual({})
    expect(bot.stopDigging).toHaveBeenCalled()
    expect(bot.deactivateItem).toHaveBeenCalled()
    expect(bot.autoEat.disableAuto).toHaveBeenCalled()
  })

  it('drops the goal-ownership mutexes so nothing restores a goal behind the freeze', () => {
    const bot = makeBot()
    bot._seiReflexActive = true
    bot._seiSavedGoal = { old: 'goal' }
    bot._seiSurvivalActive = true
    bot._seiCriticalRetreat = true
    bot._seiOffensiveTarget = 9

    setWorldPaused(bot, true)

    expect(bot._seiReflexActive).toBe(false)
    expect(bot._seiSavedGoal).toBe(null)
    expect(bot._seiSurvivalActive).toBe(false)
    expect(bot._seiCriticalRetreat).toBe(false)
    expect(bot._seiOffensiveTarget).toBe(null)
  })

  it('re-arms auto-eat on release', () => {
    const bot = makeBot()
    setWorldPaused(bot, true)
    setWorldPaused(bot, false)
    expect(bot._seiPaused).toBe(false)
    expect(isWorldPaused()).toBe(false)
    expect(bot.autoEat.enableAuto).toHaveBeenCalled()
  })

  it('never throws on a half-connected bot (no pathfinder / no plugins)', () => {
    const bare = new EventEmitter()
    expect(() => setWorldPaused(bare, true)).not.toThrow()
    expect(bare._seiPaused).toBe(true)
  })

  it('applyWorldPause re-freezes a fresh bot after a reconnect', () => {
    const first = makeBot()
    setWorldPaused(first, true)
    // A reconnect builds a brand new mineflayer bot; connect.js re-applies.
    const reconnected = makeBot()
    applyWorldPause(reconnected)
    expect(reconnected._seiPaused).toBe(true)
    expect(reconnected.autoEat.disableAuto).toHaveBeenCalled()
  })
})

describe('paused autonomous loops', () => {
  it('reflex does not flee a fusing creeper while paused', () => {
    const bot = makeBot()
    startReflex(bot, cfg())
    bot.entities[7] = fusingCreeper(3)

    setWorldPaused(bot, true)
    bot.emit('physicsTick')

    expect(bot._seiReflexActive).toBe(false)
    expect(bot.pathfinder.goal).toBe(null)
  })

  it('reflex resumes evading once the player presses play', () => {
    const bot = makeBot()
    startReflex(bot, cfg())
    bot.entities[7] = fusingCreeper(3)

    setWorldPaused(bot, true)
    bot.emit('physicsTick')
    setWorldPaused(bot, false)
    bot.emit('physicsTick')

    expect(bot._seiReflexActive).toBe(true)
    expect(bot.pathfinder.goal).not.toBe(null)
  })

  it('combat neither retaliates nor wakes the brain while paused', () => {
    const bot = makeBot()
    startCombat(bot, cfg({ attack_react_throttle_ms: 0 }))
    const attacked = vi.fn()
    bot.on('sei:attacked', attacked)
    const zombie = { id: 5, name: 'zombie', position: { x: 1, y: 0, z: 0 } }
    bot.entities[5] = zombie

    setWorldPaused(bot, true)
    bot.emit('entityHurt', bot.entity, zombie)

    expect(attacked).not.toHaveBeenCalled()
    expect(bot.attack).not.toHaveBeenCalled()
  })

  it('follow keeps its target but stops re-installing the goal while paused', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    startFollow(bot, cfg({ follow_range: 3 }))
    setFollowTarget({ kind: 'player', username: 'Player' })
    bot.players = { Player: { entity: { id: 2, position: new Vec3(20, 0, 0) } } }

    setWorldPaused(bot, true)
    vi.advanceTimersByTime(3000)
    // Only the freeze's own setGoal(null) — no GoalFollow re-install.
    expect(bot._goalLog.filter(Boolean).length).toBe(0)

    setWorldPaused(bot, false)
    vi.advanceTimersByTime(1100)
    expect(bot._goalLog.filter(Boolean).length).toBeGreaterThan(0)
  })
})
