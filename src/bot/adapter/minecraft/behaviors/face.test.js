// face.js (260708) — the avatar visibly turns to what it acts on. Pins:
// faceBlock aims at the BLOCK CENTER, is bounded (a stalled look promise
// cannot wedge the action), and never rejects; installFaceOnDig turns before
// every dig (including the pathfinder's forceLook=true path-clearing digs,
// the reason this wrapper exists), hands mineflayer force=true afterward so
// its internal lookAt can't stall the swing, passes 'ignore' through
// untouched, and wraps only once across respawns.

import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { faceBlock, installFaceOnDig, FACE_TIMEOUT_MS } from './face.js'

function makeBot({ lookAt = vi.fn(async () => {}), dig = vi.fn(async () => 'dug') } = {}) {
  return { lookAt, dig }
}

describe('faceBlock', () => {
  it('looks smoothly (force=false) at the block center', async () => {
    const bot = makeBot()
    await faceBlock(bot, new Vec3(10, 64, -5))
    expect(bot.lookAt).toHaveBeenCalledTimes(1)
    const [point, force] = bot.lookAt.mock.calls[0]
    expect({ x: point.x, y: point.y, z: point.z }).toEqual({ x: 10.5, y: 64.5, z: -4.5 })
    expect(force).toBe(false)
  })

  it('accepts a plain {x,y,z} position', async () => {
    const bot = makeBot()
    await faceBlock(bot, { x: 1, y: 2, z: 3 })
    const [point] = bot.lookAt.mock.calls[0]
    expect({ x: point.x, y: point.y, z: point.z }).toEqual({ x: 1.5, y: 2.5, z: 3.5 })
  })

  it('is bounded: a look promise that never settles cannot wedge the caller', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeBot({ lookAt: vi.fn(() => new Promise(() => {})) })
      let done = false
      const p = faceBlock(bot, new Vec3(0, 0, 0)).then(() => { done = true })
      await vi.advanceTimersByTimeAsync(FACE_TIMEOUT_MS - 1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never rejects (a lookAt failure must not fail the action)', async () => {
    const bot = makeBot({ lookAt: vi.fn(() => Promise.reject(new Error('boom'))) })
    await expect(faceBlock(bot, new Vec3(0, 0, 0))).resolves.toBeUndefined()
  })

  it('no-ops on a missing position', async () => {
    const bot = makeBot()
    await faceBlock(bot, null)
    expect(bot.lookAt).not.toHaveBeenCalled()
  })
})

describe('installFaceOnDig', () => {
  const BLOCK = { name: 'stone', position: new Vec3(4, 60, 4) }

  it('faces the block BEFORE the dig starts, then digs with force=true', async () => {
    const order = []
    const bot = makeBot({
      lookAt: vi.fn(async () => { order.push('look') }),
      dig: vi.fn(async () => { order.push('dig'); return 'dug' }),
    })
    const rawDig = bot.dig
    installFaceOnDig(bot)

    // The pathfinder's path-clearing call shape: dig(block, true).
    await bot.dig(BLOCK, true)

    expect(order).toEqual(['look', 'dig'])
    const [point, force] = bot.lookAt.mock.calls[0]
    expect({ x: point.x, y: point.y, z: point.z }).toEqual({ x: 4.5, y: 60.5, z: 4.5 })
    expect(force).toBe(false) // the visible smooth turn, not the old instant snap
    // Inner dig gets force=true: already aimed → no-op; interrupted turn → snap
    // the remainder rather than stall the swing on an unconverged look.
    expect(rawDig.mock.calls[0][1]).toBe(true)
  })

  it("passes forceLook 'ignore' through without looking", async () => {
    const bot = makeBot()
    const rawDig = bot.dig
    installFaceOnDig(bot)
    await bot.dig(BLOCK, 'ignore')
    expect(bot.lookAt).not.toHaveBeenCalled()
    expect(rawDig.mock.calls[0][1]).toBe('ignore')
  })

  it('wraps only once (respawn re-runs spawn behaviors)', async () => {
    const bot = makeBot()
    installFaceOnDig(bot)
    installFaceOnDig(bot)
    await bot.dig(BLOCK)
    expect(bot.lookAt).toHaveBeenCalledTimes(1) // a double wrap would look twice
  })

  it('still digs when the block has no position (defensive)', async () => {
    const bot = makeBot()
    const rawDig = bot.dig
    installFaceOnDig(bot)
    await bot.dig({ name: 'stone' })
    expect(bot.lookAt).not.toHaveBeenCalled()
    expect(rawDig).toHaveBeenCalledTimes(1)
  })
})
