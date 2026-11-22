import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { followMovements, followSprintFor, FOLLOW_SPRINT_ON_DIST, FOLLOW_SPRINT_OFF_DIST } from './follow.js'

const require = createRequire(import.meta.url)
const mcData = require('minecraft-data')('1.21.1')

describe('follow movements (261011)', () => {
  it('trails at a walk by default, keeping the default dig cost', () => {
    const m = followMovements({ registry: mcData })
    expect(m.allowSprinting).toBe(false)
    expect(m.digCost).toBe(1)
  })

  it('sprints to catch up when far behind and walks again once close', () => {
    expect(followSprintFor(FOLLOW_SPRINT_ON_DIST + 1, false)).toBe(true)
    // Between the two thresholds it keeps what it was doing (no flapping).
    expect(followSprintFor(8, true)).toBe(true)
    expect(followSprintFor(8, false)).toBe(false)
    expect(followSprintFor(FOLLOW_SPRINT_OFF_DIST - 1, true)).toBe(false)
  })
})

// 261019 (quality pass 19): a mob hit paused the trail with stopFollow(),
// which forgot the target for good. pauseFollow keeps it.
import { pauseFollow, stopFollow, setFollowTarget, getFollowTargetLabel, startFollow } from './follow.js'
import { EventEmitter } from 'node:events'

describe('pauseFollow (261019)', () => {
  it('keeps the follow target; stopFollow clears it', () => {
    setFollowTarget({ kind: 'player', username: 'Alex' })
    pauseFollow()
    expect(getFollowTargetLabel()).toBe('Alex')
    stopFollow()
    expect(getFollowTargetLabel()).toBe(null)
  })

  it('startFollow with keepMovements leaves the current movements alone', () => {
    const bot = new EventEmitter()
    bot.registry = mcData
    bot.hasPlugin = () => true
    bot.pathfinder = { setMovements: (m) => { bot._mv = m }, isMoving: () => false, setGoal() {} }
    startFollow(bot, {}, { keepMovements: true })
    expect(bot._mv).toBeUndefined()
    startFollow(bot, {})
    expect(bot._mv).toBeTruthy()
    stopFollow()
  })
})




