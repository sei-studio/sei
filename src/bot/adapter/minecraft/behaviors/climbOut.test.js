// 261015 quality pass 10: climbing out of a self-dug 1x1 shaft, and the
// short memory of unreachable targets.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Vec3 } from 'vec3'

const scaffoldUp = vi.fn()
vi.mock('./build.js', () => ({ scaffoldUp: (...a) => scaffoldUp(...a) }))

const { pitInfo, climbOut, junkBlocks, isPassable, escapeUp, findOpenColumn, columnOpening, isNaturalBlock, isFallingBlock } = await import('./climbOut.js')
const { noteUnreachable, isUnreachable, isUnreachableResult, clearUnreachable, UNREACHABLE_TTL_MS } = await import('./unreachable.js')

// Voxel world: solid stone everywhere at or below `ground`, air above, minus
// the cells in `air`, plus extra solid cells in `solid`.
function makeWorld({ ground = 70, air = [], solid = [] } = {}) {
  const airSet = new Set(air.map((c) => c.join(',')))
  const solidSet = new Set(solid.map((c) => c.join(',')))
  return (p) => {
    const k = `${p.x},${p.y},${p.z}`
    const isSolid = solidSet.has(k) || (!airSet.has(k) && p.y <= ground)
    return isSolid
      ? { name: 'stone', boundingBox: 'block', position: p }
      : { name: 'air', boundingBox: 'empty', position: p }
  }
}

// A 1x1 shaft at (0,0) dug from y=70 down to y=70-depth+1; the bot stands
// on its floor.
function shaftBot(depth, { items = [], ground = 70 } = {}) {
  const air = []
  for (let y = ground; y > ground - depth; y--) air.push([0, y, 0])
  const bot = {
    entity: { position: new Vec3(0.5, ground - depth + 1, 0.5), onGround: true },
    blockAt: makeWorld({ ground, air }),
    inventory: { items: () => items },
    setControlState: vi.fn(),
  }
  return bot
}

beforeEach(() => { scaffoldUp.mockReset() })

describe('pitInfo', () => {
  it('finds the rim of a 1x1 shaft the bot stands in', () => {
    const bot = shaftBot(4)
    const pit = pitInfo(bot)
    expect(pit).toMatchObject({ feetY: 67, rimY: 71, depth: 4 })
  })

  it('is null when a side cell is open at feet level (she can walk out)', () => {
    const bot = shaftBot(4)
    const world = bot.blockAt
    bot.blockAt = (p) => (p.x === 1 && p.z === 0 && (p.y === 67 || p.y === 68))
      ? { name: 'air', boundingBox: 'empty' }
      : world(p)
    expect(pitInfo(bot)).toBeNull()
  })

  it('reports a roofed shaft without a rim', () => {
    const bot = shaftBot(4)
    const world = bot.blockAt
    bot.blockAt = (p) => (p.x === 0 && p.z === 0 && p.y === 70) ? { name: 'dirt', boundingBox: 'block' } : world(p)
    expect(pitInfo(bot)).toMatchObject({ rimY: null, ceilingY: 70 })
  })

  it('treats grass and water as passable but not lava', () => {
    expect(isPassable({ name: 'short_grass', boundingBox: 'empty' })).toBe(true)
    expect(isPassable({ name: 'water', boundingBox: 'empty' })).toBe(true)
    expect(isPassable({ name: 'lava', boundingBox: 'empty' })).toBe(false)
    expect(isPassable({ name: 'stone', boundingBox: 'block' })).toBe(false)
  })
})

// 261017 (pass 12), errands eval: a 14-deep shaft with two coal blocks mined
// out of its wall 2 above the bottom. The pocket is the first side opening,
// but it leads nowhere; the way out is the surface.
function pocketShaftBot({ items = [] } = {}) {
  const air = [[1, 59, 0], [1, 60, 0]]
  for (let y = 70; y >= 57; y--) air.push([0, y, 0])
  return {
    entity: { position: new Vec3(0.5, 57, 0.5), onGround: true },
    blockAt: makeWorld({ ground: 70, air }),
    inventory: { items: () => items },
    setControlState: vi.fn(),
  }
}

describe('pitInfo exit (a pocket in the wall is not the way out)', () => {
  it('reports the pocket as the rim but the surface as the exit', () => {
    expect(pitInfo(pocketShaftBot())).toMatchObject({ feetY: 57, rimY: 59, depth: 2, exitY: 71, exitDepth: 14 })
  })

  it('a clean shaft exits at its rim', () => {
    expect(pitInfo(shaftBot(4))).toMatchObject({ rimY: 71, exitY: 71 })
  })

  it('a side opening onto a tunnel is an exit', () => {
    const bot = pocketShaftBot()
    const world = bot.blockAt
    // A tunnel running east from the pocket.
    bot.blockAt = (p) => (p.z === 0 && p.x >= 1 && p.x <= 9 && (p.y === 59 || p.y === 60)) ? { name: 'air', boundingBox: 'empty' } : world(p)
    expect(pitInfo(bot)).toMatchObject({ rimY: 59, exitY: 59 })
  })

  it('a pocket that reaches the target counts as the way there', () => {
    const bot = pocketShaftBot()
    expect(pitInfo(bot, 24, { x: 2, y: 59, z: 0 })).toMatchObject({ rimY: 59, exitY: 59 })
  })

  it('a pocket under a capped column has no exit', () => {
    const bot = pocketShaftBot()
    const world = bot.blockAt
    bot.blockAt = (p) => (p.x === 0 && p.z === 0 && p.y === 64) ? { name: 'stone', boundingBox: 'block' } : world(p)
    expect(pitInfo(bot)).toMatchObject({ rimY: 59, exitY: null, ceilingY: 64 })
  })
})

describe('columnOpening exit', () => {
  it('skips a dead-end pocket and gives the surface as the rim', () => {
    const bot = pocketShaftBot()
    expect(columnOpening(bot, 0, 57, 0, 80)).toEqual({ toTarget: false, rimY: 71, exit: true })
    expect(columnOpening(bot, 0, 57, 0, 71)).toMatchObject({ toTarget: true })
  })
})

describe('climbOut past a dead-end pocket', () => {
  it('pillars all the way to the surface, not to the pocket', async () => {
    const bot = pocketShaftBot({ items: [{ name: 'cobblestone', count: 16 }] })
    scaffoldUp.mockImplementation(async (b, name, targetY) => { b.entity.position.y = targetY - 1; return 'ok' })
    const r = await climbOut(bot, { x: 5, y: 71, z: 0 })
    expect(r).toEqual({ status: 'climbed', depth: 14, how: 'pillar', exit: true })
    expect(scaffoldUp).toHaveBeenCalledWith(bot, 'cobblestone', 72, expect.anything())
    expect(bot.entity.position.y).toBe(71)
  })

  it('with the column capped, climbs to the pocket and says it is not an exit', async () => {
    const bot = pocketShaftBot({ items: [{ name: 'cobblestone', count: 16 }] })
    const world = bot.blockAt
    bot.blockAt = (p) => (p.x === 0 && p.z === 0 && p.y === 64) ? { name: 'stone', boundingBox: 'block' } : world(p)
    scaffoldUp.mockImplementation(async (b, name, targetY) => { b.entity.position.y = targetY - 1; return 'ok' })
    const r = await climbOut(bot, { x: 5, y: 71, z: 0 })
    expect(r).toEqual({ status: 'climbed', depth: 2, how: 'pillar', exit: false })
  })
})

describe('junkBlocks', () => {
  it('lists cheap scaffold blocks, true junk first and cobblestone last, minus kept items', () => {
    const bot = { inventory: { items: () => [
      { name: 'dirt', count: 3 }, { name: 'andesite', count: 9 }, { name: 'oak_planks', count: 20 },
      { name: 'cobblestone', count: 5 }, { name: 'diamond', count: 2 },
    ] } }
    expect(junkBlocks(bot).map((b) => b.name)).toEqual(['dirt', 'andesite', 'cobblestone'])
    expect(junkBlocks(bot, ['andesite']).map((b) => b.name)).toEqual(['dirt', 'cobblestone'])
  })
})

describe('climbOut', () => {
  it('pillars to the rim with junk blocks when the target is above', async () => {
    const bot = shaftBot(4, { items: [{ name: 'cobblestone', count: 4 }] })
    scaffoldUp.mockImplementation(async (b, name, targetY) => {
      b.entity.position.y = targetY - 1
      return 'ok'
    })
    const r = await climbOut(bot, { x: 5, y: 71, z: 0 })
    expect(r).toEqual({ status: 'climbed', depth: 4, how: 'pillar', exit: true })
    expect(scaffoldUp).toHaveBeenCalledWith(bot, 'cobblestone', 72, expect.anything())
    expect(bot.entity.position.y).toBe(71)
  })

  it('moves on to the next junk block when one runs out', async () => {
    const bot = shaftBot(4, { items: [{ name: 'dirt', count: 2 }, { name: 'cobblestone', count: 1 }] })
    scaffoldUp
      .mockImplementationOnce(async (b) => { b.entity.position.y += 2; return 'no dirt in inventory' })
      .mockImplementationOnce(async (b, name, targetY) => { b.entity.position.y = targetY - 1; return 'ok' })
    const r = await climbOut(bot, { x: 5, y: 71, z: 0 })
    expect(r.status).toBe('climbed')
    expect(scaffoldUp.mock.calls.map((c) => c[1])).toEqual(['dirt', 'cobblestone'])
  })

  it('does nothing when the bot is not in a shaft, or the target is not above it', async () => {
    const open = { entity: { position: new Vec3(0.5, 71, 0.5), onGround: true }, blockAt: makeWorld(), inventory: { items: () => [] } }
    expect((await climbOut(open, { x: 5, y: 75, z: 0 })).status).toBe('not_in_pit')
    const bot = shaftBot(4)
    expect((await climbOut(bot, { x: 3, y: 67, z: 0 })).status).toBe('not_in_pit')
    expect(scaffoldUp).not.toHaveBeenCalled()
  })

  it('leaves a flooded shaft to the pathfinder (she swims up)', async () => {
    const bot = shaftBot(4, { items: [{ name: 'dirt', count: 4 }] })
    bot.entity.isInWater = true
    expect((await climbOut(bot, { x: 5, y: 71, z: 0 })).status).toBe('not_in_pit')
    expect(scaffoldUp).not.toHaveBeenCalled()
  })

  it('says honestly that she is stuck when there are no blocks and no digging', async () => {
    const bot = shaftBot(6)
    const r = await climbOut(bot, { x: 5, y: 71, z: 0 }, { canDig: false })
    expect(r.status).toBe('failed')
    expect(r.line).toMatch(/^stuck in a hole at 0,65,0: could not climb out of the 6-deep shaft/)
    expect(isUnreachableResult(r.line)).toBe(false)
  })

  it('refuses a staircase it would take minutes to dig', async () => {
    const bot = shaftBot(5)
    bot.canDigBlock = () => true
    bot.digTime = () => 7500 // stone by hand
    bot.dig = vi.fn()
    const r = await climbOut(bot, { x: 5, y: 71, z: 0 })
    expect(r.status).toBe('failed')
    expect(r.line).toMatch(/too slow to dig/)
    expect(bot.dig).not.toHaveBeenCalled()
  })

  it('never cuts into a wall next to water or lava', async () => {
    const bot = shaftBot(3)
    const world = bot.blockAt
    // Lava behind every wall the staircase would open.
    bot.blockAt = (p) => (Math.abs(p.x) === 2 || Math.abs(p.z) === 2) && p.y >= 68 && p.y <= 71
      ? { name: 'lava', boundingBox: 'empty' }
      : world(p)
    bot.canDigBlock = () => true
    bot.digTime = () => 400
    bot.dig = vi.fn()
    const r = await climbOut(bot, { x: 5, y: 71, z: 0 })
    expect(r.status).toBe('failed')
    expect(bot.dig).not.toHaveBeenCalled()
  })

  it('refuses to cut through blocks that are not natural ground (a closed room)', async () => {
    const bot = shaftBot(4)
    const world = bot.blockAt
    bot.blockAt = (p) => {
      const b = world(p)
      return b.name === 'stone' && p.y >= 67 ? { ...b, name: 'oak_planks' } : b
    }
    bot.canDigBlock = () => true
    bot.digTime = () => 300 // planks with an axe
    bot.dig = vi.fn()
    const r = await climbOut(bot, { x: 5, y: 71, z: 0 })
    expect(r.status).toBe('failed')
    expect(r.line).toMatch(/not natural: oak_planks/)
    expect(r.line).toMatch(/looks built, so you did not dig it/)
    expect(bot.dig).not.toHaveBeenCalled()
    expect(isNaturalBlock('glass')).toBe(false)
    expect(isNaturalBlock('chest')).toBe(false)
    expect(isNaturalBlock('cobblestone')).toBe(false)
    expect(isNaturalBlock('deepslate_iron_ore')).toBe(true)
    expect(isNaturalBlock('orange_terracotta')).toBe(true)
    expect(isNaturalBlock('orange_glazed_terracotta')).toBe(false)
  })

  it('will not dig a cell with sand or gravel resting on it', async () => {
    // Pocket under solid rock: every staircase starts by clearing the head
    // room over her, and gravel sits on that cell.
    const bot = pocketBot()
    const world = bot.blockAt
    bot.blockAt = (p) => (p.x === 2 && p.y === 67 && p.z === 0) ? { name: 'gravel', boundingBox: 'block', position: p } : world(p)
    bot.canDigBlock = () => true
    bot.digTime = () => 400
    bot.dig = vi.fn()
    const r = await escapeUp(bot, { x: 8, y: 71, z: 0 })
    expect(r.status).toBe('failed')
    expect(r.line).toMatch(/gravel above 2,66,0 would fall in/)
    expect(bot.dig).not.toHaveBeenCalled()
    expect(isFallingBlock('red_concrete_powder')).toBe(true)
  })

  it('gives the body back when the player pauses or a reflex takes over', async () => {
    for (const [flag, why] of [['_seiPaused', 'paused'], ['_seiReflexActive', 'yielded']]) {
      const bot = shaftBot(4, { items: [{ name: 'dirt', count: 4 }] })
      scaffoldUp.mockImplementationOnce(async (b, name, targetY, cfg) => {
        b[flag] = true
        while (!cfg.signal.aborted) await new Promise((r) => setTimeout(r, 20))
        return 'aborted'
      })
      expect(await climbOut(bot, { x: 5, y: 71, z: 0 })).toEqual({ status: 'aborted', why })
    }
  })

  it('returns aborted when the signal fires', async () => {
    const bot = shaftBot(4, { items: [{ name: 'dirt', count: 4 }] })
    const ctl = new AbortController()
    scaffoldUp.mockImplementation(async () => { ctl.abort(); return 'aborted' })
    expect((await climbOut(bot, { x: 5, y: 71, z: 0 }, { signal: ctl.signal })).status).toBe('aborted')
  })
})

describe('unreachable target memory', () => {
  it('covers the noted block, the trunk above it and its neighbours, and expires', () => {
    const bot = {}
    noteUnreachable(bot, { x: 10, y: 77, z: 6 }, 'cant_reach', 1000)
    expect(isUnreachable(bot, { x: 10, y: 77, z: 6 }, 2000)).toBe(true)
    expect(isUnreachable(bot, { x: 10, y: 81, z: 6 }, 2000)).toBe(true) // top of the trunk
    expect(isUnreachable(bot, { x: 11, y: 77, z: 5 }, 2000)).toBe(true) // touching ore
    expect(isUnreachable(bot, { x: 13, y: 77, z: 6 }, 2000)).toBe(false) // another tree
    expect(isUnreachable(bot, { x: 10, y: 71, z: 6 }, 2000)).toBe(false) // the ground below the cliff
    expect(isUnreachable(bot, { x: 10, y: 77, z: 6 }, 1000 + UNREACHABLE_TTL_MS + 1)).toBe(false)
    clearUnreachable(bot)
    expect(isUnreachable(bot, { x: 10, y: 77, z: 6 }, 2000)).toBe(false)
  })

  it('counts only results that blame the target', () => {
    expect(isUnreachableResult('cant_reach (closest=6.5m to target 1,2,3)')).toBe(true)
    expect(isUnreachableResult('timeout â€” unreachable â€” try build to Y=77')).toBe(true)
    expect(isUnreachableResult('stuck at 1,2,3, 4.0m from 5,6,7: the path kept failing')).toBe(true)
    expect(isUnreachableResult('out of range (5.7m, need â‰¤4.5) for oak_log @1,2,3')).toBe(true)
    expect(isUnreachableResult('reached')).toBe(false)
    expect(isUnreachableResult('aborted')).toBe(false)
    expect(isUnreachableResult('stuck in a hole at 0,65,0: could not climb out')).toBe(false)
  })
})

// The errands hole: a 7-deep shaft at (0,0) with an ore pocket mined out of
// its bottom wall, the bot standing in the pocket under solid rock.
function pocketBot({ items = [] } = {}) {
  const air = [[1, 64, 0], [1, 65, 0], [2, 64, 0], [2, 65, 0]]
  for (let y = 70; y >= 64; y--) air.push([0, y, 0])
  return {
    entity: { position: new Vec3(2.5, 64, 0.5), onGround: true },
    blockAt: makeWorld({ ground: 70, air }),
    inventory: { items: () => items },
    setControlState: vi.fn(),
  }
}

describe('escapeUp (any hole, after a failed walk)', () => {
  it('finds the open shaft next to the pocket, walks into it and pillars up', async () => {
    const bot = pocketBot({ items: [{ name: 'dirt', count: 8 }] })
    expect(pitInfo(bot)).toBeNull() // not a clean 1x1 shaft
    const found = findOpenColumn(bot, 71)
    expect(found.open).toBe(false)
    expect(found.column).toMatchObject({ x: 0, y: 64, z: 0, toTarget: true })
    const goTo = vi.fn(async (b, x, y, z) => { b.entity.position = new Vec3(x + 0.5, y, z + 0.5); return 'reached' })
    scaffoldUp.mockImplementation(async (b, name, targetY) => { b.entity.position.y = targetY - 1; return 'ok' })
    const r = await escapeUp(bot, { x: -6, y: 71, z: 0 }, { goTo })
    expect(r).toMatchObject({ status: 'climbed', how: 'pillar' })
    expect(goTo).toHaveBeenCalledWith(bot, 0, 64, 0, 0, expect.any(Number), expect.any(AbortSignal), { canDig: false, canPlace: false })
    expect(scaffoldUp).toHaveBeenCalledWith(bot, 'dirt', 72, expect.anything())
  })

  // Review (261017): the target on a hill above the ground. Once the pillar
  // reaches the shaft's rim she is out; a staircase toward targetY from
  // there would cut into the hillside.
  it('stops at the shaft rim when the target is higher than the ground, without digging', async () => {
    const bot = pocketBot({ items: [{ name: 'dirt', count: 12 }] })
    // A hill west of the shaft, the target on top of it.
    const world = bot.blockAt
    bot.blockAt = (p) => (p.x <= -1 && p.x >= -9 && p.y >= 71 && p.y <= 79) ? { name: 'stone', boundingBox: 'block', position: p } : world(p)
    Object.assign(bot, { canDigBlock: () => true, digTime: () => 300, dig: vi.fn(), equip: vi.fn(), lookAt: vi.fn() })
    const goTo = vi.fn(async (b, x, y, z) => { b.entity.position = new Vec3(x + 0.5, y, z + 0.5); return 'reached' })
    scaffoldUp.mockImplementation(async (b, name, targetY) => { b.entity.position.y = targetY - 1; return 'ok' })
    const r = await escapeUp(bot, { x: -6, y: 80, z: 0 }, { goTo, budgetMs: 2000 })
    expect(r).toMatchObject({ status: 'climbed', how: 'pillar', depth: 7 })
    expect(scaffoldUp).toHaveBeenCalledWith(bot, 'dirt', 72, expect.anything())
    expect(bot.entity.position.y).toBe(71)
    expect(bot.dig).not.toHaveBeenCalled()
  })

  it('climbOut to the rim, then escapeUp from the surface: no staircase into the hill', async () => {
    const bot = shaftBot(6, { items: [{ name: 'cobblestone', count: 8 }] })
    const world = bot.blockAt
    bot.blockAt = (p) => (p.x >= 2 && p.x <= 9 && p.y >= 71 && p.y <= 79) ? { name: 'stone', boundingBox: 'block', position: p } : world(p)
    Object.assign(bot, { canDigBlock: () => true, digTime: () => 300, dig: vi.fn(), equip: vi.fn(), lookAt: vi.fn() })
    scaffoldUp.mockImplementation(async (b, name, targetY) => { b.entity.position.y = targetY - 1; return 'ok' })
    const target = { x: 5, y: 80, z: 0 }
    expect(await climbOut(bot, target)).toMatchObject({ status: 'climbed', exit: true })
    expect(bot.entity.position.y).toBe(71)
    // The walk to the hilltop failed; the goTo handler runs escapeUp next.
    expect((await escapeUp(bot, target)).status).toBe('not_in_pit')
    expect(scaffoldUp).toHaveBeenCalledTimes(1)
    expect(bot.dig).not.toHaveBeenCalled()
  })

  it('leaves open ground and cliff feet alone', async () => {
    const bot = { entity: { position: new Vec3(0.5, 71, 0.5), onGround: true }, blockAt: makeWorld(), inventory: { items: () => [{ name: 'dirt', count: 9 }] } }
    expect(findOpenColumn(bot, 77).open).toBe(true)
    expect((await escapeUp(bot, { x: 3, y: 77, z: 0 })).status).toBe('not_in_pit')
    expect(scaffoldUp).not.toHaveBeenCalled()
  })

  it('inside a closed room says it is a built roof, not a hole to dig out of', async () => {
    // A 3x3x3 hollow under a plank roof at y=67, planks all around.
    const air = []
    for (let x = -1; x <= 1; x++) for (let y = 64; y <= 66; y++) for (let z = -1; z <= 1; z++) air.push([x, y, z])
    const world = makeWorld({ ground: 70, air })
    const bot = {
      entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
      blockAt: (p) => {
        const b = world(p)
        return b.name === 'stone' && p.y >= 64 && Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2 ? { ...b, name: 'oak_planks' } : b
      },
      inventory: { items: () => [] },
      setControlState: vi.fn(),
      canDigBlock: () => true,
      digTime: () => 300,
      dig: vi.fn(),
    }
    const r = await escapeUp(bot, { x: 0, y: 71, z: 0 })
    expect(r.status).toBe('failed')
    expect(r.line).toMatch(/^stuck under a built roof at 0,64,0 \(oak_planks at 0,67,0\)/)
    expect(r.line).toMatch(/do not dig through builds/)
    expect(isUnreachableResult(r.line)).toBe(false)
    expect(bot.dig).not.toHaveBeenCalled()
  })

  it('says she is stuck when there is nothing to pillar with and digging is off', async () => {
    const bot = pocketBot()
    const r = await escapeUp(bot, { x: -6, y: 71, z: 0 }, { canDig: false })
    expect(r.status).toBe('failed')
    expect(r.line).toMatch(/^stuck in a hole at 2,64,0: 7 blocks below where you are going/)
  })
})




