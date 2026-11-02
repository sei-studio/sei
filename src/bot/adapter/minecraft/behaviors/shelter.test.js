// shelter() convenience (MCRAFT-06) — composes build() (hollow walls + roof)
// and dig() (doorway) into a correct enclosed structure. The mocks let us
// assert the COMPOSITION shape (which cuboids, hollow vs solid, doorway carved)
// without standing up a real mineflayer world.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./build.js', async (importOriginal) => ({
  ...(await importOriginal()),
  buildAction: vi.fn(async () => 'built 16 placed, 0 skipped (already solid), of 16 cells'),
}))
vi.mock('./dig.js', () => ({
  digAction: vi.fn(async () => 'dug 2/2'),
}))
vi.mock('./digTool.js', () => ({
  digToolAction: vi.fn(async () => 'dug grass_block'),
}))

import { shelterAction, shelterBaseY } from './shelter.js'
import { buildAction } from './build.js'
import { digAction } from './dig.js'
import { digToolAction } from './digTool.js'

// Flat ground: solid grass at y=63 and below, air from y=64 up. The bot
// stands ON the grass, so its feet (position.y) are at 64.
function makeBot({ groundY = 63, ground = 'grass_block', inv = [{ name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }], extra = {} } = {}) {
  return {
    version: '1.21.1',
    entity: { position: { x: 0.4, y: groundY + 1, z: 0.6 } },
    inventory: { items: () => inv },
    blockAt(p) {
      const key = `${p.x},${p.y},${p.z}`
      if (extra[key]) return { name: extra[key], boundingBox: 'block', position: p }
      return p.y <= groundY ? { name: ground, boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p }
    },
  }
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

  // 261012 (quality eval build_shelter, direct 0/3): the base used to be
  // floor(bot.y) + 1, one layer ABOVE the ground. Every wall cell floated
  // with nothing under or beside it, and all 48 cells of a 5x5 failed.
  it('starts the walls on the ground layer the bot is standing in', async () => {
    await shelterAction({ size: 3 }, makeBot(), {})
    const wallsCall = buildAction.mock.calls.find((c) => c[0].hollow === true)
    // Ground is y=63, the bot's feet are at 64 → the walls start at 64.
    expect(wallsCall[0].from.y).toBe(64)
    // 261102 (pass 36): two layers of wall, the roof right on top.
    expect(wallsCall[0].to.y).toBe(65)
    const roofCall = buildAction.mock.calls.find((c) => !c[0].hollow)
    expect(roofCall[0].from.y).toBe(66)
    // The doorway is cut at ground level too, so it can be walked through.
    expect(digAction.mock.calls[0][0].y).toBe(64)
  })

  it('centers the footprint on the cell the bot stands in', async () => {
    await shelterAction({ size: 5 }, makeBot(), {})
    const w = buildAction.mock.calls.find((c) => c[0].hollow === true)[0]
    // bot x 0.4 → cell 0, z 0.6 → cell 0; a 5-wide footprint is -2..2.
    expect([w.from.x, w.to.x, w.from.z, w.to.z]).toEqual([-2, 2, -2, 2])
  })

  it('lands a model-given center on the ground whether it names the feet or the ground block', async () => {
    const bot = makeBot()
    expect(shelterBaseY(bot, 5, 64, 5)).toBe(64) // feet level (the pos: y)
    expect(shelterBaseY(bot, 5, 63, 5)).toBe(64) // the ground block itself
    expect(shelterBaseY(bot, 5, 66, 5)).toBe(64) // a couple of blocks up in the air
  })

  it('leaves the base alone when the column is not loaded', async () => {
    const bot = { blockAt: () => null }
    expect(shelterBaseY(bot, 0, 70, 0)).toBe(70)
  })

  it('switches the roof to another building block when the material runs short (261012)', async () => {
    // A 5x5 needs 32 wall cells + 25 roof cells = 57, more than 40 planks.
    // The walls use the planks; the roof uses the last 8 and then the
    // cobblestone she also carries.
    let planks = 40
    const inv = [{ name: 'oak_planks', get count() { return planks } }, { name: 'cobblestone', count: 64 }]
    buildAction
      .mockImplementationOnce(async () => { planks -= 32; return 'built 32 placed, 0 skipped (already solid), of 32 cells' })
      .mockImplementationOnce(async () => { planks = 0; return 'built 8 of ~25 needed, then ran out of oak_planks. Get more oak_planks (gather it, or ask the player for it) before finishing this build.' })
      .mockImplementationOnce(async () => 'built 17 placed, 8 skipped (already solid), of 25 cells')
    const res = await shelterAction({ size: 5, material: 'oak_planks' }, makeBot({ inv }), {})
    expect(buildAction.mock.calls.map((c) => c[0].block)).toEqual(['oak_planks', 'oak_planks', 'cobblestone'])
    expect(buildAction.mock.calls.every((c) => c[3]?.partial === true)).toBe(true)
    expect(res).toMatch(/^built shelter 5x5x2/)
    expect(res).toContain('roof in oak_planks and cobblestone')
  })

  // 261019 (pass 19, combat_night eval): 20 planks and plenty of dirt came
  // back "the walls need 21 blocks of one kind ... 1 short", and she retried
  // or crafted the planks away. Any mix of full blocks builds it now.
  it('builds the walls from two kinds when neither covers them alone', async () => {
    let planks = 12
    const inv = [{ name: 'oak_planks', get count() { return planks } }, { name: 'dirt', count: 30 }]
    buildAction
      .mockImplementationOnce(async () => { planks = 0; return 'built 12 of ~16 needed, then ran out of oak_planks. Get more oak_planks (gather it, or ask the player for it) before finishing this build.' })
      .mockImplementationOnce(async () => 'built 4 placed, 12 skipped (already solid), of 16 cells')
      .mockImplementationOnce(async () => 'built 9 placed, 0 skipped (already solid), of 9 cells')
    const res = await shelterAction({ size: 3, material: 'oak_planks' }, makeBot({ inv }), {})
    expect(buildAction.mock.calls.map((c) => [c[0].block, c[0].hollow])).toEqual([['oak_planks', true], ['dirt', true], ['dirt', false]])
    expect(res).toMatch(/^built shelter 3x3x2/)
    expect(res).toContain('walls in oak_planks and dirt')
  })

  // 261019 (pass 19): the shortfall is reported up front, for the whole
  // shelter, without walking or placing anything.
  it('reports the exact shortfall for the whole shelter when the blocks do not cover it', async () => {
    const inv = [{ name: 'oak_planks', count: 10 }, { name: 'dirt', count: 5 }, { name: 'diamond_block', count: 64 }]
    // Stone ground and no pickaxe: nothing she can dig by hand.
    const r = await shelterAction({ size: 3, material: 'oak_planks' }, makeBot({ inv, ground: 'stone' }), {})
    expect(buildAction).not.toHaveBeenCalled()
    expect(digToolAction).not.toHaveBeenCalled()
    // 3x3: 16 wall cells + 9 roof cells.
    expect(r).toMatch(/^no shelter built: it needs 25 full blocks \(16 for the walls, 9 for the roof\) and you have 15 building blocks \(10 oak_planks, 5 dirt\), 10 short\./)
    expect(r).toContain('There is no dirt or grass close by that you can dig for it.')
    expect(r).toContain('Gather at least 10 more')
    expect(r).toContain('3x3 is the smallest shelter')
    expect(r).not.toContain('smaller span')
    expect(r).not.toContain('\u2014')
  })

  it('a bigger shelter that does not fit suggests a smaller size', async () => {
    const inv = [{ name: 'cobblestone', count: 5 }]
    const r = await shelterAction({ size: 5 }, makeBot({ inv, ground: 'stone' }), {})
    expect(r).toContain('ask for a smaller shelter (size 4 or 3)')
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

  it('does not claim a shelter when no wall went up (261011)', async () => {
    buildAction.mockResolvedValueOnce('no cobblestone in inventory')
    const res = await shelterAction({}, makeBot(), {})
    expect(res).toBe('no shelter built: walls: no cobblestone in inventory')
    expect(buildAction).toHaveBeenCalledTimes(1)
    expect(digAction).not.toHaveBeenCalled()
  })

  it('says UNFINISHED when the walls or roof ran out (261011)', async () => {
    buildAction
      .mockResolvedValueOnce('built 10 of ~24 needed, then ran out of cobblestone. Get more cobblestone (gather it, or ask the player for it) before finishing this build.')
      .mockResolvedValueOnce('no cobblestone in inventory')
    const res = await shelterAction({}, makeBot(), {})
    expect(res).toMatch(/^shelter UNFINISHED, it has gaps and is not safe yet/)
  })

  it('reports a finished shelter as built', async () => {
    const res = await shelterAction({}, makeBot(), {})
    expect(res).toMatch(/^built shelter 3x3x2 with a doorway/)
  })
})

describe('shelterAction — interrupted (261012)', () => {
  it('says it stopped partway instead of "no shelter built"', async () => {
    buildAction.mockResolvedValueOnce('aborted after 32 placed of 48 cells')
    const res = await shelterAction({ size: 5 }, makeBot(), {})
    expect(res).toBe('shelter stopped partway while building the walls, it is not finished (walls: aborted after 32 placed of 48 cells)')
    expect(digAction).not.toHaveBeenCalled()
  })
})

describe('shelterAction: bodies in the way (261019)', () => {
  function withPlayer(bot, pos) {
    const alex = { id: 7, type: 'player', username: 'Alex', position: { ...pos } }
    bot.entities = { 7: alex }
    return alex
  }

  it('waits for a player in a wall cell to step away, then builds', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeBot()
      const alex = withPlayer(bot, { x: 1.5, y: 64, z: 0.5 })
      const p = shelterAction({ size: 3 }, bot, {})
      await vi.advanceTimersByTimeAsync(1000)
      expect(buildAction).not.toHaveBeenCalled()
      alex.position = { x: 5.5, y: 64, z: 0.5 }
      await vi.advanceTimersByTimeAsync(500)
      const res = await p
      expect(buildAction).toHaveBeenCalled()
      expect(res).toMatch(/^built shelter/)
    } finally { vi.useRealTimers() }
  })

  it('names the player and the way out when they stay in the ring', async () => {
    vi.useFakeTimers()
    try {
      const bot = makeBot()
      withPlayer(bot, { x: 1.5, y: 64, z: 0.5 })
      const p = shelterAction({ size: 3 }, bot, {})
      await vi.advanceTimersByTimeAsync(5000)
      const res = await p
      expect(buildAction).not.toHaveBeenCalled()
      expect(res).toMatch(/^no shelter built yet: Alex is standing where a wall goes \(1,64,0\)/)
      expect(res).toContain('build size 5 so you both fit inside (that needs 57 blocks, you have 128)')
      expect(res).not.toContain('\u2014')
    } finally { vi.useRealTimers() }
  })

  it('a player inside a 5x5 is not in the way', async () => {
    const bot = makeBot()
    withPlayer(bot, { x: 1.5, y: 64, z: 0.5 })
    const res = await shelterAction({ size: 5 }, bot, {})
    expect(res).toMatch(/^built shelter 5x5x2/)
  })

  it('steps to the middle of her block when she stands near its edge', async () => {
    const bot = makeBot()
    bot.entity.position = { x: 0.05, y: 64, z: 0.5 }
    let target = null
    const controls = {}
    bot.lookAt = vi.fn(async (t) => { target = t })
    bot.setControlState = vi.fn((k, v) => {
      controls[k] = v
      if (k === 'forward' && v && target) {
        const p = bot.entity.position
        const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz)
        const step = Math.min(0.06, d)
        bot.entity.position = { ...p, x: p.x + (dx / d) * step, z: p.z + (dz / d) * step }
      }
    })
    const res = await shelterAction({ size: 3 }, bot, {})
    const p = bot.entity.position
    expect(Math.hypot(p.x - 0.5, p.z - 0.5)).toBeLessThanOrEqual(0.15)
    expect(controls.forward).toBe(false)
    expect(controls.sneak).toBe(false)
    expect(res).toMatch(/^built shelter/)
  })
})

// 261102 (pass 36): 65 of 82 free-play shelter calls since 10-20 came back
// "no shelter built" for want of blocks (combat_night gives her none), and
// the gather('dirt') she ran next dug the pit she then built in.
describe('shelterAction: digs its own blocks when short (261102)', () => {
  function diggableBot(inv) {
    const holes = new Set()
    const bot = makeBot({ inv })
    const base = bot.blockAt.bind(bot)
    bot.blockAt = (p) => (holes.has(`${p.x},${p.y},${p.z}`) ? { name: 'air', boundingBox: 'empty', position: p } : base(p))
    return { bot, holes }
  }
  function dirtStack(inv) {
    let n = 0
    inv.push({ name: 'dirt', get count() { return n } })
    return { add: (k) => { n += k }, get n() { return n } }
  }

  it('digs dirt from outside the footprint, then builds with it', async () => {
    const inv = []
    const { bot, holes } = diggableBot(inv)
    const dirt = dirtStack(inv)
    const dig = vi.fn(async ({ x, y, z }) => { holes.add(`${x},${y},${z}`); dirt.add(1); return 'dug grass_block; 1 dirt reached your inventory' })
    const res = await shelterAction({ size: 3, center: { x: 0, y: 64, z: 0 } }, bot, {}, { digBlock: dig })
    expect(dig).toHaveBeenCalledTimes(25)
    for (const [a] of dig.mock.calls) {
      // Not under the walls or the ring of ground around them.
      expect(Math.max(Math.abs(a.x), Math.abs(a.z))).toBeGreaterThanOrEqual(3)
      // Not on the way to the doorway (x=0, south of the front wall).
      expect(a.x === 0 && a.z < 0 && a.z >= -4).toBe(false)
      expect(a.y).toBe(63)
    }
    expect(buildAction.mock.calls[0][0].block).toBe('dirt')
    expect(res).toMatch(/^built shelter 3x3x2/)
    expect(res).toContain('dug 25 dirt nearby first')
  })

  it('goes back in the middle after digging around it', async () => {
    const inv = []
    const { bot, holes } = diggableBot(inv)
    const dirt = dirtStack(inv)
    const dig = vi.fn(async ({ x, y, z }) => {
      holes.add(`${x},${y},${z}`); dirt.add(1)
      bot.entity.position = { x: x + 0.5, y: 64, z: z + 1.5 }
      return 'dug'
    })
    const walk = vi.fn(async (b, x, y, z) => { b.entity.position = { x: x + 0.5, y, z: z + 0.5 }; return 'reached' })
    const res = await shelterAction({ size: 3 }, bot, {}, { digBlock: dig, goTo: walk })
    expect(walk).toHaveBeenCalledWith(bot, 0, 64, 0, 0, expect.any(Number), undefined)
    expect(walk.mock.invocationCallOrder[0]).toBeLessThan(buildAction.mock.invocationCallOrder[0])
    expect(res).toMatch(/^built shelter/)
  })

  it('digs only what is missing', async () => {
    const inv = [{ name: 'cobblestone', count: 20 }]
    const { bot, holes } = diggableBot(inv)
    const dirt = dirtStack(inv)
    const dig = vi.fn(async ({ x, y, z }) => { holes.add(`${x},${y},${z}`); dirt.add(1); return 'dug' })
    await shelterAction({ size: 3 }, bot, {}, { digBlock: dig })
    expect(dig).toHaveBeenCalledTimes(5)
  })

  it('says how far it got when the digs stop bringing blocks in', async () => {
    const inv = []
    const { bot, holes } = diggableBot(inv)
    const dirt = dirtStack(inv)
    const dig = vi.fn(async ({ x, y, z }) => {
      holes.add(`${x},${y},${z}`)
      if (dirt.n < 10) dirt.add(1)
      return 'dug'
    })
    const res = await shelterAction({ size: 3 }, bot, {}, { digBlock: dig })
    expect(buildAction).not.toHaveBeenCalled()
    expect(dig).toHaveBeenCalledTimes(14)
    expect(res).toMatch(/^no shelter built: it needs 25 full blocks .* you have 10 building blocks \(10 dirt\), 15 short\./)
    expect(res).toContain('You dug 10 dirt nearby first, then stopped: the last few digs brought nothing in.')
  })

  it('stops when interrupted while digging and says nothing is built', async () => {
    const inv = []
    const { bot, holes } = diggableBot(inv)
    const dirt = dirtStack(inv)
    const ctl = new AbortController()
    const dig = vi.fn(async ({ x, y, z }) => {
      holes.add(`${x},${y},${z}`); dirt.add(1)
      if (dirt.n === 3) { ctl.abort(); return 'aborted' }
      return 'dug'
    })
    const res = await shelterAction({ size: 3 }, bot, { signal: ctl.signal }, { digBlock: dig })
    expect(res).toBe('shelter stopped while digging blocks for it, nothing is built yet (dug 3 dirt so far)')
    expect(buildAction).not.toHaveBeenCalled()
  })

  it('never digs the block someone stands on', async () => {
    const inv = []
    const { bot, holes } = diggableBot(inv)
    const dirt = dirtStack(inv)
    bot.entities = { 7: { id: 7, type: 'player', username: 'Alex', position: { x: 3.5, y: 64, z: 0.5 } } }
    const dig = vi.fn(async ({ x, y, z }) => { holes.add(`${x},${y},${z}`); dirt.add(1); return 'dug' })
    await shelterAction({ size: 3 }, bot, {}, { digBlock: dig })
    expect(dig.mock.calls.some(([a]) => a.x === 3 && a.z === 0)).toBe(false)
  })
})

describe('shelterAction: her own body and walls already there (261102)', () => {
  it('walks to the middle before building when she stands where a wall goes', async () => {
    const bot = makeBot()
    // The model passed a center one block east of her: she is in the west wall.
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 }
    const walk = vi.fn(async (b, x, y, z) => { b.entity.position = { x: x + 0.5, y, z: z + 0.5 }; return 'reached' })
    const res = await shelterAction({ size: 3, center: { x: 1, y: 64, z: 0 } }, bot, {}, { goTo: walk })
    expect(walk).toHaveBeenCalledWith(bot, 1, 64, 0, 0, expect.any(Number), undefined)
    expect(buildAction.mock.invocationCallOrder[0]).toBeGreaterThan(walk.mock.invocationCallOrder[0])
    expect(res).toMatch(/^built shelter/)
  })

  it('steps back in to the middle when the doorway dig left her in the doorway', async () => {
    const bot = makeBot()
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 }
    // A dirt doorway drops an item and the dig walks onto it.
    digAction.mockImplementationOnce(async () => { bot.entity.position = { x: 0.5, y: 64, z: -0.5 }; return 'dug 1/2 (1 skipped air)' })
    const walk = vi.fn(async (b, x, y, z) => { b.entity.position = { x: x + 0.5, y, z: z + 0.5 }; return 'reached' })
    const res = await shelterAction({ size: 3 }, bot, {}, { goTo: walk })
    expect(walk).toHaveBeenCalledTimes(1)
    expect(walk).toHaveBeenCalledWith(bot, 0, 64, 0, 0, expect.any(Number), undefined)
    expect(walk.mock.invocationCallOrder[0]).toBeGreaterThan(digAction.mock.invocationCallOrder[0])
    expect(bot.entity.position).toEqual({ x: 0.5, y: 64, z: 0.5 })
    expect(res).toMatch(/^built shelter/)
  })

  it('does not walk when she is already clear of the walls', async () => {
    const walk = vi.fn(async () => 'reached')
    await shelterAction({ size: 3, center: { x: 0, y: 64, z: 0 } }, makeBot(), {}, { goTo: walk })
    expect(walk).not.toHaveBeenCalled()
  })

  it('in a pit whose sides are the walls, only the roof is built', async () => {
    // Every wall cell is dirt already: she stands at the bottom of a 2-deep hole.
    const extra = {}
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
      if (x === 0 && z === 0) continue
      for (const y of [64, 65]) extra[`${x},${y},${z}`] = 'dirt'
    }
    const res = await shelterAction({ size: 3 }, makeBot({ extra }), {})
    expect(buildAction).toHaveBeenCalledTimes(1)
    expect(buildAction.mock.calls[0][0].hollow).toBe(false)
    expect(res).toMatch(/^built shelter 3x3x2/)
  })
})
