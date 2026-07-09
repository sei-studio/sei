// gaze suppression during world actions (260709). Live bug: the idle branch
// re-aimed at the owner every 250ms BETWEEN dig swings (isMoving() is false
// there), so a gathering bot punched trees while staring at the player —
// fighting faceBlock and mineflayer's own dig look. The adapter's
// executeAction now holds bot._seiActionActive while any world action runs,
// and the gaze tick stands down for it. Follow's persistent trailing runs
// outside executeAction, so follow gaze is unaffected by design.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Vec3 } from 'vec3'
import { startGaze } from './gaze.js'

function makeBot() {
  const owner = { entity: { position: new Vec3(3, 64, 0), eyeHeight: 1.62 } }
  return {
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, eyeHeight: 1.62 },
    players: { Steve: owner },
    pathfinder: { isMoving: () => false },
    lookAt: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  }
}

const CONFIG = { player_username: 'Steve', adapter: { minecraft: {} } }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('gaze vs world actions', () => {
  it('idle gaze aims at the owner when no action is running', async () => {
    const bot = makeBot()
    const dispose = startGaze(bot, CONFIG)
    await vi.advanceTimersByTimeAsync(300)
    expect(bot.lookAt).toHaveBeenCalled()
    dispose()
  })

  it('stands down while a world action is executing (_seiActionActive > 0)', async () => {
    const bot = makeBot()
    bot._seiActionActive = 1
    const dispose = startGaze(bot, CONFIG)
    await vi.advanceTimersByTimeAsync(1000)
    expect(bot.lookAt).not.toHaveBeenCalled()
    // Action settles → gaze resumes on the next tick.
    bot._seiActionActive = 0
    await vi.advanceTimersByTimeAsync(300)
    expect(bot.lookAt).toHaveBeenCalled()
    dispose()
  })
})
