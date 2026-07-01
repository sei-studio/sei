// shelter() convenience (MCRAFT-06) — composes build() (hollow walls + roof)
// and dig() (doorway) into a correct enclosed structure. The mocks let us
// assert the COMPOSITION shape (which cuboids, hollow vs solid, doorway carved)
// without standing up a real mineflayer world.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./build.js', () => ({
  buildAction: vi.fn(async () => 'built 16 placed, 0 skipped, of 16 cells'),
}))
vi.mock('./dig.js', () => ({
  digAction: vi.fn(async () => 'dug 2/2'),
}))

import { shelterAction } from './shelter.js'
import { buildAction } from './build.js'
import { digAction } from './dig.js'

function makeBot() {
  return { version: '1.21.1', entity: { position: { x: 0.4, y: 64, z: 0.6 } } }
}

beforeEach(() => { vi.clearAllMocks() })

describe('shelterAction', () => {
  it('builds hollow walls + a roof layer and carves a doorway', async () => {
    const res = await shelterAction({ size: 5, material: 'cobblestone' }, makeBot(), {})

    // Walls: a hollow:true cuboid of the requested material.
    const wallsCall = buildAction.mock.calls.find((c) => c[0].hollow === true)
    expect(wallsCall).toBeTruthy()
    expect(wallsCall[0].block).toBe('cobblestone')

    // Roof: a single-Y solid cuboid (from.y === to.y, not hollow) above the walls.
    const roofCall = buildAction.mock.calls.find((c) => c[0].from.y === c[0].to.y && !c[0].hollow)
    expect(roofCall).toBeTruthy()
    expect(roofCall[0].from.y).toBeGreaterThan(wallsCall[0].from.y)

    // Doorway carved open: one dig cuboid, two cells tall (head + feet).
    expect(digAction).toHaveBeenCalledTimes(1)
    const doorArgs = digAction.mock.calls[0][0]
    expect(doorArgs.to).toBeTruthy()
    expect(Math.abs(doorArgs.to.y - doorArgs.y)).toBe(1)

    expect(res).toMatch(/doorway/i)
  })

  it('places the structure base one block above the bot (build sits on terrain)', async () => {
    await shelterAction({ size: 3 }, makeBot(), {})
    const wallsCall = buildAction.mock.calls.find((c) => c[0].hollow === true)
    // bot.y floor is 64 → base is 65.
    expect(wallsCall[0].from.y).toBe(65)
  })

  it('defaults material to cobblestone and size to 3', async () => {
    await shelterAction({}, makeBot(), {})
    const wallsCall = buildAction.mock.calls.find((c) => c[0].hollow === true)
    expect(wallsCall[0].block).toBe('cobblestone')
    const span = Math.abs(wallsCall[0].to.x - wallsCall[0].from.x) + 1
    expect(span).toBe(3)
  })

  it('returns "aborted" without building when the signal is already aborted', async () => {
    const c = new AbortController()
    c.abort()
    const res = await shelterAction({}, makeBot(), { signal: c.signal })
    expect(res).toBe('aborted')
    expect(buildAction).not.toHaveBeenCalled()
    expect(digAction).not.toHaveBeenCalled()
  })
})
