// 261015 quality pass 10: the follow trail climbs out of a 1x1 shaft before
// it re-installs GoalFollow (errands eval: 30s of follow, still underground).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Vec3 } from 'vec3'

const climbOut = vi.fn()
const pitInfo = vi.fn()
const escapeUp = vi.fn(async () => ({ status: 'not_in_pit' }))
vi.mock('./climbOut.js', () => ({
  climbOut: (...a) => climbOut(...a),
  escapeUp: (...a) => escapeUp(...a),
  pitInfo: (...a) => pitInfo(...a),
  MIN_PIT_DEPTH: 2,
}))
vi.mock('./pathfind.js', () => ({ goTo: vi.fn(async () => 'reached'), protectBuiltBlocks: (b, m) => m }))
vi.mock('mineflayer-pathfinder', () => {
  class GoalFollow { constructor(entity, range) { this.entity = entity; this.range = range } }
  class Movements { constructor() { this.allowSprinting = true } }
  return { default: { pathfinder: {}, Movements, goals: { GoalFollow } } }
})

const { startFollow, stopFollow, setFollowTarget, isFollowClimbing } = await import('./follow.js')

function makeBot(botY, playerY) {
  const player = { position: new Vec3(4, playerY, 0) }
  return {
    entity: { position: new Vec3(0.5, botY, 0.5), onGround: true },
    players: { Alex: { entity: player } },
    hasPlugin: () => true,
    pathfinder: { setMovements: vi.fn(), setGoal: vi.fn(), isMoving: () => false, goal: null, movements: null },
  }
}

afterEach(() => { stopFollow(); vi.useRealTimers(); climbOut.mockReset(); pitInfo.mockReset() })

describe('follow climbs out of a shaft (261015)', () => {
  it('climbs instead of re-installing GoalFollow, and a new target cancels the climb', async () => {
    vi.useFakeTimers()
    const bot = makeBot(63, 71)
    pitInfo.mockReturnValue({ feetY: 63, rimY: 71, depth: 8 })
    let signal = null
    climbOut.mockImplementation((b, target, opts) => { signal = opts.signal; return new Promise(() => {}) })
    startFollow(bot, {})
    setFollowTarget({ kind: 'player', username: 'Alex' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(climbOut).toHaveBeenCalledTimes(1)
    expect(isFollowClimbing()).toBe(true)
    expect(bot.pathfinder.setGoal).toHaveBeenCalledWith(null)
    await vi.advanceTimersByTimeAsync(3000)
    expect(climbOut).toHaveBeenCalledTimes(1) // one climb at a time
    expect(bot.pathfinder.setGoal.mock.calls.some(([g]) => g && g.entity)).toBe(false)
    setFollowTarget(null)
    expect(signal.aborted).toBe(true)
    expect(isFollowClimbing()).toBe(false)
  })

  it('trails normally when the player is not above, and backs off after a failed climb', async () => {
    vi.useFakeTimers()
    const level = makeBot(71, 71)
    pitInfo.mockReturnValue({ feetY: 71, rimY: 75, depth: 4 })
    startFollow(level, {})
    setFollowTarget({ kind: 'player', username: 'Alex' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(climbOut).not.toHaveBeenCalled()
    expect(level.pathfinder.setGoal.mock.calls.some(([g]) => g && g.entity)).toBe(true)
    stopFollow()

    const deep = makeBot(63, 71)
    pitInfo.mockReturnValue({ feetY: 63, rimY: 71, depth: 8 })
    climbOut.mockResolvedValueOnce({ status: 'not_in_pit' })
    startFollow(deep, {})
    setFollowTarget({ kind: 'player', username: 'Alex' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(climbOut).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(climbOut).toHaveBeenCalledTimes(1) // no retry storm
    expect(deep.pathfinder.setGoal.mock.calls.some(([g]) => g && g.entity)).toBe(true)
  })

  it('pausing stops a climb in progress, and no new one starts while paused', async () => {
    vi.useFakeTimers()
    const bot = makeBot(63, 71)
    pitInfo.mockReturnValue({ feetY: 63, rimY: 71, depth: 8 })
    let signal = null
    climbOut.mockImplementation((b, target, opts) => { signal = opts.signal; return new Promise(() => {}) })
    startFollow(bot, {})
    setFollowTarget({ kind: 'player', username: 'Alex' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(isFollowClimbing()).toBe(true)
    bot._seiPaused = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(signal.aborted).toBe(true)
    expect(isFollowClimbing()).toBe(false)
    await vi.advanceTimersByTimeAsync(3000)
    expect(climbOut).toHaveBeenCalledTimes(1)
  })

  it('puts the trail movements back after a climb (escapeUp walked with no-dig goTo movements)', async () => {
    vi.useFakeTimers()
    const bot = makeBot(63, 71)
    pitInfo.mockReturnValue({ feetY: 63, rimY: 71, depth: 8 })
    climbOut.mockResolvedValue({ status: 'climbed', depth: 8, how: 'stairs' })
    startFollow(bot, {})
    setFollowTarget({ kind: 'player', username: 'Alex' })
    bot.pathfinder.setMovements.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(bot.pathfinder.setMovements).toHaveBeenCalledTimes(1)
    expect(bot.pathfinder.setMovements.mock.calls[0][0].allowSprinting).toBe(false)
  })

  it('backs off after a climb that failed too', async () => {
    vi.useFakeTimers()
    const deep = makeBot(63, 71)
    pitInfo.mockReturnValue({ feetY: 63, rimY: 71, depth: 8 })
    climbOut.mockResolvedValue({ status: 'failed', line: 'stuck in a hole' })
    startFollow(deep, {})
    setFollowTarget({ kind: 'player', username: 'Alex' })
    await vi.advanceTimersByTimeAsync(6000)
    expect(climbOut).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30000)
    expect(climbOut).toHaveBeenCalledTimes(2) // tries again after the back-off
  })
})




