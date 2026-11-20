// src/bot/adapter/minecraft/behaviors/survival.test.js
//
// 261011: the drowning swim-up flaps at the surface (head bobs out, dips back
// in with oxygen still low) and used to emit sei:survival on every re-engage,
// about every 2s. The narration event is now rate-limited per kind; the
// physical swim-up still re-engages every time.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('mineflayer-pathfinder', () => ({
  default: { goals: { GoalInvert: class {}, GoalFollow: class {} } },
}))

const { startSurvival, resolveSurvivalThresholds } = await import('./survival.js')

function makeBot() {
  const bot = new EventEmitter()
  bot.entity = { id: 1, position: { x: 0.5, y: 60, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0 }
  bot.health = 20
  bot.entities = { 1: bot.entity }
  bot.oxygenLevel = 5
  bot._headWet = true
  bot.blockAt = () => ({ name: bot._headWet ? 'water' : 'air' })
  bot.setControlState = () => {}
  bot.look = () => {}
  bot.pathfinder = { setGoal() {} }
  return bot
}

const cfg = (mc = {}) => ({ adapter: { kind: 'minecraft', minecraft: mc } })

afterEach(() => { vi.useRealTimers() })

describe('survival drowning narration rate limit', () => {
  it('defaults the cooldown to 30s', () => {
    expect(resolveSurvivalThresholds({}).survival_emit_cooldown_ms).toBe(30_000)
  })

  it('emits once when the swim-up flaps at the surface, and again after the cooldown', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-11T00:00:00Z') })
    const bot = makeBot()
    const emits = []
    bot.on('sei:survival', (p) => emits.push(p))
    const dispose = startSurvival(bot, cfg())

    // Six bob cycles 2s apart: head in water (engage), head out (disengage).
    for (let i = 0; i < 6; i++) {
      bot._headWet = true
      bot.emit('physicsTick')
      expect(bot._seiSurvivalActive).toBe(true) // the swim-up itself engages every time
      bot._headWet = false
      bot.emit('physicsTick')
      vi.setSystemTime(Date.now() + 2_000)
    }
    expect(emits).toHaveLength(1)
    expect(emits[0].kind).toBe('drowning')
    expect(emits[0].air).toBe(5) // 261109 (pass 48): the air left rides along

    vi.setSystemTime(Date.now() + 30_000)
    bot._headWet = true
    bot.emit('physicsTick')
    expect(emits).toHaveLength(2)
    dispose()
  })
})
