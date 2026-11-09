// 261107 (quality pass 45): a walk aimed at dig reach can stop up to ~0.7m
// farther than its goal (the goal is checked on the feet's cell center, and
// the pathfinder stops within 0.35 of the last node on each axis). Free play:
// "out of range (4.5m, need ≤4.5) ... (the walk toward it ended: reached)" on
// every gather_craft run. The dig now swings to DIG_MAX_REACH (mineflayer
// allows 5.1), and a dig a step short gets one short close-in walk.
import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'

const goToMock = vi.fn(async () => 'reached')
vi.mock('./pathfind.js', async (orig) => ({ ...(await orig()), goTo: (...a) => goToMock(...a) }))
vi.mock('./toolSelect.js', async (orig) => ({
  ...(await orig()),
  equipBestTool: vi.fn(async () => ({ ms: 500, harvest: true })),
}))

const { digAction, digReachDistance, closeInForDig, DIG_REACH, DIG_MAX_REACH, CLOSE_IN_MAX_M } = await import('./dig.js')
const { digToolAction } = await import('./digTool.js')

function makeBot(at) {
  return {
    entity: { position: new Vec3(at.x, at.y, at.z) },
    entities: {},
    blockAt: (p) => ({ name: p.y <= 64 ? 'stone' : 'air', position: new Vec3(p.x, p.y, p.z) }),
    targetDigBlock: null,
    stopDigging: vi.fn(),
    dig: vi.fn(async () => {}),
    canDigBlock: () => true,
    inventory: { items: () => [] },
  }
}

// The 02-B layout: feet on the grass at y=66, stone at y=62 under it. Eyes at
// 67.62, so the stone center is 5.12 below them: a dig needs her standing in
// a hole or off to the side, and the walk's last cell decides the dig.
describe('dig reach at the edge of a walk (261107)', () => {
  it('digs a block 4.8m from the eyes, which used to answer out of range', async () => {
    goToMock.mockClear()
    // Block at (3,62,0); feet at (0.5,64.4,0.5): eyes 66.02.
    const bot = makeBot({ x: 0.5, y: 64.4, z: 0.5 })
    const pos = { x: 3, y: 62, z: 0 }
    const d = digReachDistance(bot, pos)
    expect(d).toBeGreaterThan(DIG_REACH)
    expect(d).toBeLessThanOrEqual(DIG_MAX_REACH)
    const r = await digAction(pos, bot, {})
    expect(r).toMatch(/^dug stone/)
    expect(bot.dig).toHaveBeenCalledTimes(1)
  })

  it('still refuses past DIG_MAX_REACH, naming the limit', async () => {
    const bot = makeBot({ x: 0.5, y: 66, z: 0.5 })
    const r = await digAction({ x: 4, y: 62, z: 0 }, bot, {})
    expect(r).toMatch(/^out of range \(6\.\dm, need ≤5\.0\) for stone @4,62,0/)
    expect(bot.dig).not.toHaveBeenCalled()
  })

  it('closeInForDig walks once, well inside reach, only when a step would help', async () => {
    goToMock.mockClear()
    const near = makeBot({ x: 0.5, y: 66, z: 0.5 })
    // 5.1 below the eyes, 3 over: ~5.9m, inside CLOSE_IN_MAX_M.
    const pos = { x: 3, y: 62, z: 0 }
    expect(digReachDistance(near, pos)).toBeLessThanOrEqual(CLOSE_IN_MAX_M)
    const r = await closeInForDig(near, pos, goToMock, undefined, { keepItems: ['cobblestone'] })
    expect(r).toBe('reached')
    expect(goToMock).toHaveBeenCalledTimes(1)
    expect(goToMock.mock.calls[0][5]).toBeLessThanOrEqual(4000)
    expect(goToMock.mock.calls[0][7]).toMatchObject({ reach: 3.5, keepItems: ['cobblestone'] })

    goToMock.mockClear()
    // In reach already: no walk.
    expect(await closeInForDig(makeBot({ x: 2.5, y: 64.4, z: 0.5 }), pos, goToMock)).toBeNull()
    // Far off: the walk before already failed, a step does not help.
    expect(await closeInForDig(makeBot({ x: 12.5, y: 66, z: 0.5 }), pos, goToMock)).toBeNull()
    expect(goToMock).not.toHaveBeenCalled()
  })

  it('the dig tool closes in after a walk that stopped a step short, then digs', async () => {
    const bot = makeBot({ x: 6.5, y: 66, z: 0.5 })
    bot.findBlocks = undefined
    const pos = { x: 3, y: 62, z: 0 }
    const goTo = vi.fn(async (_b, _x, _y, _z, _r, _t, _s, opts) => {
      // First walk: "reached", but ends with the eyes too far (feet cell
      // center was in the goal; 5.8m). The close-in walk ends in the hole beside it.
      bot.entity.position = opts.reach < 4 ? new Vec3(3.5, 63, 1.5) : new Vec3(6, 66, 1.5)
      return 'reached'
    })
    const dig = vi.fn(async (a, b) => (digReachDistance(b, a) > DIG_MAX_REACH ? 'out of range (5.3m, need ≤5.0) for stone @3,62,0' : 'dug stone'))
    const r = await digToolAction(pos, bot, {}, { goTo, digAction: dig, sleep: async () => {} })
    expect(goTo).toHaveBeenCalledTimes(2)
    expect(goTo.mock.calls[1][7]).toMatchObject({ reach: 3.5 })
    expect(dig).toHaveBeenCalledTimes(2)
    expect(r).toMatch(/^dug stone/)
  })

  it('no close-in walk after a walk that failed (timeout or cant_reach)', async () => {
    for (const result of ['timeout', 'cant_reach']) {
      const bot = makeBot({ x: 6.5, y: 66, z: 0.5 })
      const goTo = vi.fn(async () => {
        bot.entity.position = new Vec3(6, 66, 1.5)
        return result
      })
      const dig = vi.fn(async () => 'out of range (5.8m, need ≤5.0) for stone @3,62,0')
      const r = await digToolAction({ x: 3, y: 62, z: 0 }, bot, {}, { goTo, digAction: dig, sleep: async () => {} })
      expect(goTo).toHaveBeenCalledTimes(1)
      expect(dig).toHaveBeenCalledTimes(1)
      expect(r).toContain(`(the walk toward it ended: ${result}`)
    }
  })
})
