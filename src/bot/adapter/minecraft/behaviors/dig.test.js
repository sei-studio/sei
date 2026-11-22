// 261011 quality pass 2: dig reach from the eyes, and a dig the pathfinder
// left running is cancelled instead of answering "busy digging".
import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { digAction, digReachDistance, DIG_REACH } from './dig.js'

function makeBot({ at = { x: 0.5, y: 64, z: 0.5 }, block = { name: 'oak_log', x: 0, y: 68, z: 9 } } = {}) {
  return {
    entity: { position: new Vec3(at.x, at.y, at.z) },
    blockAt: (p) => ({ name: block.name, position: new Vec3(p.x, p.y, p.z) }),
    targetDigBlock: null,
    stopDigging: vi.fn(function () { this.targetDigBlock = null }),
  }
}

describe('digReachDistance (261011)', () => {
  it('measures eyes to block center, so a log four up the trunk is in reach from the ground', () => {
    const bot = makeBot()
    // Standing beside the trunk (one block over), log at y=68: feet-to-corner
    // read 4.1+ and the eye-height top log read 5.0. Eyes to center is ~3.2.
    const d = digReachDistance(bot, { x: 1, y: 68, z: 0 })
    expect(d).toBeLessThan(DIG_REACH)
    expect(d).toBeCloseTo(Math.hypot(1, 68.5 - 65.62, 0), 5)
  })

  it('is Infinity with no position', () => {
    expect(digReachDistance({}, { x: 0, y: 0, z: 0 })).toBe(Infinity)
  })
})

describe('digAction and a leftover pathfinder dig (261011)', () => {
  it('cancels a dig it did not start, then carries on', async () => {
    const bot = makeBot()
    bot.targetDigBlock = { name: 'oak_log', position: { x: 0, y: 66, z: 0 } }
    const r = await digAction({ x: 0, y: 68, z: 9 }, bot, {})
    expect(bot.stopDigging).toHaveBeenCalledTimes(1)
    // Past the busy guard: it reached the reach check (block is 9 away).
    expect(r).toMatch(/^out of range/)
  })

  it('still refuses while its OWN dig is running', async () => {
    const bot = makeBot()
    bot.targetDigBlock = { name: 'stone', position: { x: 1, y: 63, z: 0 } }
    bot._seiDigActive = 1
    const r = await digAction({ x: 0, y: 68, z: 9 }, bot, {})
    expect(bot.stopDigging).not.toHaveBeenCalled()
    expect(r).toBe('busy digging stone @1,63,0')
  })
})




