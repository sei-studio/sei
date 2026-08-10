// buildAction far-wall fix (260709). Live bug: a 7×5×7 hollow house build
// placed the two walls near the bot's corner and skipped the other 71 cells —
// out-of-reach cells only ever tried scaffoldUp (which pillars straight up,
// never closing horizontal distance), then burned placeBlock's 4s timeout and
// counted as a bare "skipped". Pins: perimeter-ordered hollow layers, the
// walk-closer step, skip-without-place for unreachable cells, and the honest
// skip-reason result string.

import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'

vi.mock('./place.js', () => ({ placeBlockAction: vi.fn() }))

import { placeBlockAction } from './place.js'
import { buildAction, enumerateBuildCells, FOLLOW_HORIZ, WALK_TIMEOUT_MS } from './build.js'

const REACH = 4.5

// Voxel world on flat ground: solid "sand" at y=67 across the region, walls
// built above it. placeBlock mock enforces real reach from the bot's eyes and
// writes to the world so later cells find reference faces.
function makeWorld() {
  const blocks = new Map()
  for (let x = -50; x <= 0; x++) for (let z = -50; z <= 0; z++) blocks.set(`${x},67,${z}`, 'sand')
  const bot = {
    entity: { position: new Vec3(-38.5, 68, -32.5), eyeHeight: 1.62 },
    inventory: { items: () => [{ name: 'oak_planks', count: 64 }, { name: 'oak_planks', count: 64 }] },
    blockAt(p) {
      const name = blocks.get(`${p.x},${p.y},${p.z}`)
      return name ? { name, position: p } : { name: 'air', position: p }
    },
  }
  return { bot, blocks }
}

function eyeDist(bot, c) {
  const p = bot.entity.position
  return Math.hypot(p.x - (c.x + 0.5), p.y + 1.62 - (c.y + 0.5), p.z - (c.z + 0.5))
}

// placeBlock mock: succeeds only within actual reach of the target cell (the
// cell is the air block on `against` + faceVector), and writes the block.
function wirePlaceMock(bot, blocks) {
  placeBlockAction.mockReset()
  placeBlockAction.mockImplementation(async (args) => {
    const c = {
      x: args.against.x + args.faceVector.x,
      y: args.against.y + args.faceVector.y,
      z: args.against.z + args.faceVector.z,
    }
    if (eyeDist(bot, c) > REACH) return `timeout placing ${args.block}`
    blocks.set(`${c.x},${c.y},${c.z}`, args.block)
    return `placed ${args.block} on sand @${args.against.x},${args.against.y},${args.against.z}`
  })
}

describe('enumerateBuildCells — hollow perimeter order (260709)', () => {
  it('emits the same wall-cell set as before, ordered as a ring walk per layer', () => {
    const cells = enumerateBuildCells({ x: 0, y: 10, z: 0 }, { x: 3, y: 11, z: 3 }, true)
    // 4×4 hollow = 12 perimeter cells per layer × 2 layers.
    expect(cells).toHaveLength(24)
    const layer = cells.filter(c => c.y === 10)
    expect(layer).toHaveLength(12)
    // Every cell is a wall cell, no interior, no duplicates.
    const keys = new Set(layer.map(c => `${c.x},${c.z}`))
    expect(keys.size).toBe(12)
    for (const c of layer) expect(c.x === 0 || c.x === 3 || c.z === 0 || c.z === 3).toBe(true)
    // Ring adjacency: consecutive cells are exactly 1 apart (no criss-cross).
    for (let i = 1; i < layer.length; i++) {
      const d = Math.abs(layer[i].x - layer[i - 1].x) + Math.abs(layer[i].z - layer[i - 1].z)
      expect(d).toBe(1)
    }
  })

  it('degenerate straight wall (minX === maxX) has no duplicate cells', () => {
    const cells = enumerateBuildCells({ x: 5, y: 10, z: 0 }, { x: 5, y: 10, z: 4 }, true)
    expect(cells).toHaveLength(5)
    expect(new Set(cells.map(c => `${c.x},${c.y},${c.z}`)).size).toBe(5)
  })

  it('solid (non-hollow) enumeration is unchanged', () => {
    const cells = enumerateBuildCells({ x: 0, y: 10, z: 0 }, { x: 2, y: 10, z: 2 }, false)
    expect(cells).toHaveLength(9)
  })
})

describe('enumerateBuildCells — nearest-to-builder ordering (260803)', () => {
  // The 260731 Nether log, exactly: bot at 40,94,42 asked to bridge "behind
  // you", model wrote from z:30 to z:20. Min-corner order started at z=20, 22
  // blocks away across a lava field, and the walk step went and got it.
  const FROM = { x: 40, y: 94, z: 30 }
  const TO = { x: 40, y: 94, z: 20 }

  it('builds a 1-wide span OUTWARD from the builder, not from the far end', () => {
    const cells = enumerateBuildCells(FROM, TO, false, { x: 40.5, y: 94, z: 42.5 })
    expect(cells).toHaveLength(11)
    expect(cells[0]).toEqual({ x: 40, y: 94, z: 30 })   // nearest to the bot
    expect(cells.at(-1)).toEqual({ x: 40, y: 94, z: 20 }) // far side, built last
    // Strictly receding: every step moves away, so the builder never has to
    // cross the gap to reach its own next cell.
    for (let i = 1; i < cells.length; i++) expect(cells[i].z).toBeLessThan(cells[i - 1].z)
  })

  it('reverses when the builder stands on the other end (sign of the axis is irrelevant)', () => {
    const cells = enumerateBuildCells(FROM, TO, false, { x: 40.5, y: 94, z: 8.5 })
    expect(cells[0]).toEqual({ x: 40, y: 94, z: 20 })
    expect(cells.at(-1)).toEqual({ x: 40, y: 94, z: 30 })
  })

  it('keeps Y ascending — the layer below is finished before the one above it', () => {
    const cells = enumerateBuildCells({ x: 0, y: 10, z: 0 }, { x: 3, y: 12, z: 3 }, false, { x: 3.5, y: 10, z: 3.5 })
    const ys = cells.map(c => c.y)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    // ...and each layer independently starts nearest the builder.
    for (const y of [10, 11, 12]) {
      expect(cells.find(c => c.y === y)).toEqual({ x: 3, y, z: 3 })
    }
  })

  it('emits the same cell SET as the unordered enumeration', () => {
    const key = (c) => `${c.x},${c.y},${c.z}`
    const plain = enumerateBuildCells(FROM, TO, false).map(key).sort()
    const ordered = enumerateBuildCells(FROM, TO, false, { x: 40.5, y: 94, z: 42.5 }).map(key).sort()
    expect(ordered).toEqual(plain)
  })

  it('hollow ROTATES the ring instead of sorting it, so adjacency survives', () => {
    // A full nearest-first sort would alternate between opposite walls at
    // equal radius, which is the criss-cross the 260709 perimeter walk removed.
    const cells = enumerateBuildCells({ x: 0, y: 10, z: 0 }, { x: 3, y: 10, z: 3 }, true, { x: 3.5, y: 10, z: 3.5 })
    expect(cells).toHaveLength(12)
    expect(cells[0]).toEqual({ x: 3, y: 10, z: 3 })  // nearest corner starts it
    for (let i = 1; i < cells.length; i++) {
      const d = Math.abs(cells[i].x - cells[i - 1].x) + Math.abs(cells[i].z - cells[i - 1].z)
      expect(d).toBe(1)
    }
    // Still a closed ring: the last cell wraps back to the first.
    const wrap = Math.abs(cells[0].x - cells.at(-1).x) + Math.abs(cells[0].z - cells.at(-1).z)
    expect(wrap).toBe(1)
  })

  it('falls back to min-corner order when the builder position is unusable', () => {
    const plain = enumerateBuildCells(FROM, TO, false)
    for (const bad of [null, undefined, {}, { x: NaN, z: 4 }]) {
      expect(enumerateBuildCells(FROM, TO, false, bad)).toEqual(plain)
    }
  })
})

describe('buildAction — walks to out-of-reach cells (260709)', () => {
  it('builds all four walls when the walk step can move the bot', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    // Walk mock: teleport the bot next to the requested column (1.5 blocks
    // south so it never stands inside the wall cell).
    const walkMock = vi.fn(async (b, x, y, z) => {
      b.entity.position = new Vec3(x + 0.5, 68, z + 2)
      return 'reached'
    })
    const r = await buildAction(
      { from: { x: -38, y: 68, z: -32 }, to: { x: -32, y: 70, z: -26 }, block: 'oak_planks', hollow: true },
      bot, {}, { goTo: walkMock },
    )
    // 7×3×7 hollow = 24 perimeter cells × 3 layers = 72, all placed.
    expect(r).toBe('built 72 placed, 0 skipped (already solid), of 72 cells')
    expect(walkMock).toHaveBeenCalled()
  })

  it('skips unreachable cells WITHOUT attempting the place when walking fails', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    const walkMock = vi.fn(async () => 'timeout') // never moves
    // Single-layer ring at the bot's feet level: near cells in reach, far
    // cells not (and not above the bot, so scaffolding never triggers).
    const r = await buildAction(
      { from: { x: -38, y: 68, z: -32 }, to: { x: -32, y: 68, z: -26 }, block: 'oak_planks', hollow: true },
      bot, {}, { goTo: walkMock },
    )
    expect(r).toMatch(/cells FAILED \(could not reach or place them\)/)
    expect(r).toMatch(/The build is incomplete/)
    expect(r).toMatch(/call build again/)
    // The doomed places were never attempted: every placeBlockAction call was
    // for a cell actually in reach when it fired.
    const placedCount = Number(r.match(/built (\d+) placed/)[1])
    expect(placeBlockAction).toHaveBeenCalledTimes(placedCount)
  })

  it('already-solid cells are reported separately from failures', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    // Pre-fill the whole ring so every cell is occupied.
    for (const c of enumerateBuildCells({ x: -38, y: 68, z: -32 }, { x: -36, y: 68, z: -30 }, true)) {
      blocks.set(`${c.x},${c.y},${c.z}`, 'oak_planks')
    }
    const r = await buildAction(
      { from: { x: -38, y: 68, z: -32 }, to: { x: -36, y: 68, z: -30 }, block: 'oak_planks', hollow: true },
      bot, {}, { goTo: vi.fn(async () => 'reached') },
    )
    // All occupied and none failed → the explicit built-NOTHING contract.
    expect(r).toMatch(/built NOTHING/)
  })

  // 260730: both of these used to be discovered only AFTER the builder had
  // walked the span and placed what it could, which spends minutes of the
  // session producing a result the block counts predicted before it started.
  it('refuses up front when there are not enough blocks, naming both numbers', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    bot.inventory.items = () => [{ name: 'oak_planks', count: 4 }]
    const walkMock = vi.fn(async () => 'reached')
    const r = await buildAction(
      { from: { x: -38, y: 68, z: -32 }, to: { x: -32, y: 70, z: -26 }, block: 'oak_planks', hollow: true },
      bot, {}, { goTo: walkMock },
    )
    expect(r).toContain('you only have 4 oak_planks')
    expect(r).toContain('needs 72')
    // Nothing was attempted: no walking, no placing.
    expect(placeBlockAction).not.toHaveBeenCalled()
    expect(walkMock).not.toHaveBeenCalled()
  })

  it('passes the abort signal to the walk step', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    const ac = new AbortController()
    const walkMock = vi.fn(async () => { ac.abort(); return 'aborted' })
    const r = await buildAction(
      { from: { x: -20, y: 68, z: -20 }, to: { x: -16, y: 68, z: -16 }, block: 'oak_planks', hollow: true },
      bot, { signal: ac.signal }, { goTo: walkMock },
    )
    expect(r).toMatch(/^aborted after \d+ placed of \d+ cells$/)
    expect(walkMock.mock.calls[0][6]).toBe(ac.signal)
    expect(walkMock.mock.calls[0][5]).toBe(WALK_TIMEOUT_MS)
  })
})

// 260730 — scaffolding is build's `below` direction: the one build whose cells
// are not knowable in advance, because each block lands wherever the bot is
// standing when the jump clears. Pins the rise, the up-front material check,
// and the partial-progress result.
describe('buildAction — direction:"below" pillars up under the bot', () => {
  // Fake jump: setControlState('jump') leaves the ground, and the place that
  // lands mid-air fills the vacated cell and stands the bot on top of it. The
  // real timing (lead height, refire) is exercised against the live server;
  // here we only pin the loop's contract.
  function pillarBot(stock = 8) {
    const blocks = new Map()
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) blocks.set(`${x},63,${z}`, 'stone')
    const bot = {
      entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, onGround: true, yaw: 0 },
      inventory: { items: () => (stock > 0 ? [{ name: 'dirt', count: stock }] : []) },
      blockAt(p) {
        const name = blocks.get(`${p.x},${p.y},${p.z}`)
        return name ? { name, position: p } : { name: 'air', position: p }
      },
      equip: async () => {},
      look: async () => {},
      setControlState(control, on) {
        if (control !== 'jump' || !on) return
        bot.entity.onGround = false
        bot.entity.position = new Vec3(0.5, Math.floor(bot.entity.position.y) + 1.2, 0.5)
      },
      async placeBlock(ref) {
        if (stock <= 0) throw new Error('out of blocks')
        stock--
        const cellY = ref.position.y + 1
        blocks.set(`0,${cellY},0`, 'dirt')
        bot.entity.position = new Vec3(0.5, cellY + 1, 0.5)
        bot.entity.onGround = true
        return undefined
      },
    }
    return { bot, blocks }
  }

  it('rises exactly `count` blocks and reports where it ended up', async () => {
    const { bot, blocks } = pillarBot()
    const r = await buildAction({ direction: 'below', count: 3, block: 'dirt' }, bot, {})
    expect(r).toBe('pillared up 3 blocks (standing at y=67)')
    expect(blocks.get('0,64,0')).toBe('dirt')
    expect(blocks.get('0,65,0')).toBe('dirt')
    expect(blocks.get('0,66,0')).toBe('dirt')
  })

  it('refuses up front when it cannot reach the requested height', async () => {
    const { bot } = pillarBot(2)
    const r = await buildAction({ direction: 'below', count: 5, block: 'dirt' }, bot, {})
    expect(r).toContain('you only have 2 dirt')
    expect(r).toContain('pillar up 2')
    expect(bot.entity.position.y).toBe(64)
  })

  it('reports how far it got when the climb is aborted partway', async () => {
    const { bot } = pillarBot()
    const ac = new AbortController()
    const place = bot.placeBlock.bind(bot)
    bot.placeBlock = async (ref) => {
      const out = await place(ref)
      if (bot.entity.position.y >= 65) ac.abort() // one block up, then interrupted
      return out
    }
    const r = await buildAction({ direction: 'below', count: 4, block: 'dirt' }, bot, { signal: ac.signal })
    expect(r).toBe('aborted after pillaring up 1 of 4')
  })
})

describe('buildAction — the builder FOLLOWS its own work (260803)', () => {
  // Live symptom: bridging out over a drop, the character stayed on the spot
  // it started from while blocks appeared several cells away. A player cannot
  // do that. The old walk step only fired once a cell fell out of TOTAL reach
  // (eye-anchored, 4.5), which for a horizontal run is four or five cells.

  // Cliff at z >= -32 (solid ground); open air beyond it. The bot starts on
  // the lip and bridges out into the void at feet level minus one.
  function makeCliff() {
    const blocks = new Map()
    for (let x = -50; x <= 0; x++) for (let z = -32; z <= 0; z++) blocks.set(`${x},67,${z}`, 'sand')
    const bot = {
      entity: { position: new Vec3(-38.5, 68, -31.5), eyeHeight: 1.62 },
      inventory: { items: () => [{ name: 'oak_planks', count: 64 }] },
      blockAt(p) {
        const name = blocks.get(`${p.x},${p.y},${p.z}`)
        return name ? { name, position: p } : { name: 'air', position: p }
      },
    }
    return { bot, blocks }
  }

  // Walk mock standing in for the pathfinder's GoalNear(..., range 2): it can
  // only stop on a block that actually exists, so it lands on the built part
  // of the bridge rather than teleporting into the air ahead of it.
  function makeBridgeWalk(bot, blocks) {
    return vi.fn(async (b, x, y, z) => {
      for (let back = 0; back <= 2; back++) {
        const tz = z + back // walking out along -z, so "short of" the goal is +z
        if (blocks.has(`${x},67,${tz}`)) {
          b.entity.position = new Vec3(x + 0.5, 68, tz + 0.5)
          return 'reached'
        }
      }
      return 'cant_reach'
    })
  }

  it('never places a cell it is standing more than FOLLOW_HORIZ away from', async () => {
    const { bot, blocks } = makeCliff()
    wirePlaceMock(bot, blocks)
    const distances = []
    placeBlockAction.mockImplementation((() => {
      const inner = placeBlockAction.getMockImplementation()
      return async (args, ...rest) => {
        const c = {
          x: args.against.x + args.faceVector.x,
          y: args.against.y + args.faceVector.y,
          z: args.against.z + args.faceVector.z,
        }
        const p = bot.entity.position
        distances.push(Math.hypot(p.x - (c.x + 0.5), p.z - (c.z + 0.5)))
        return inner(args, ...rest)
      }
    })())

    // 12-long, 1-wide bridge at feet-1, starting under the bot's own column.
    const r = await buildAction(
      { from: { x: -38, y: 67, z: -31 }, to: { x: -38, y: 67, z: -42 }, block: 'oak_planks' },
      bot, {}, { goTo: makeBridgeWalk(bot, blocks) },
    )

    // Under the old rule the walk only fired past REACH - 1 (3.5), so cells at
    // ~3.2 horizontal were placed from a standstill. This is the pin.
    expect(distances.length).toBeGreaterThan(0)
    for (const d of distances) expect(d).toBeLessThanOrEqual(FOLLOW_HORIZ)
    // 12-cell span, the 2 cells still on the cliff lip are already solid.
    expect(r).toContain('10 placed')
  })

  it('actually travels the length of the bridge instead of building it from one spot', async () => {
    const { bot, blocks } = makeCliff()
    wirePlaceMock(bot, blocks)
    const startZ = bot.entity.position.z

    await buildAction(
      { from: { x: -38, y: 67, z: -31 }, to: { x: -38, y: 67, z: -42 }, block: 'oak_planks' },
      bot, {}, { goTo: makeBridgeWalk(bot, blocks) },
    )

    // It ends near the far tip, not on the lip it started from. (The walk
    // stops up to 2 short of its goal, so it trails the tip by a couple of
    // blocks, which is exactly how a player bridges.)
    expect(startZ - bot.entity.position.z).toBeGreaterThanOrEqual(8)
    expect(Math.abs(bot.entity.position.z - (-42))).toBeLessThan(4)
    // And the far end really got built, out over the void.
    expect(blocks.get('-38,67,-42')).toBe('oak_planks')
  })

  it('degrades to placing from range rather than stalling when the walk fails', async () => {
    // The goal column is thin air until the bridge reaches it, so a walk that
    // cannot find footing must not be able to wedge the build.
    const { bot, blocks } = makeCliff()
    wirePlaceMock(bot, blocks)
    const deadWalk = vi.fn(async () => 'cant_reach')

    const r = await buildAction(
      { from: { x: -38, y: 67, z: -31 }, to: { x: -38, y: 67, z: -36 }, block: 'oak_planks' },
      bot, {}, { goTo: deadWalk },
    )

    // Whatever is within real reach still gets placed (old behavior), and the
    // result names the rest honestly rather than reporting a clean finish.
    expect(deadWalk).toHaveBeenCalled()
    expect(r).toMatch(/placed/)
    // -32 is still cliff; -33 is the first cell out over the void.
    expect(blocks.get('-38,67,-33')).toBe('oak_planks')
  })

  it('still places a tall column from the ground without walking (vertical reach is untouched)', async () => {
    // The 260709 eye-anchored reach exists so a wall is buildable standing
    // beside it. Tightening HORIZONTAL following must not cost that.
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    const walk = vi.fn(async () => 'reached')

    const r = await buildAction(
      { from: { x: -37, y: 68, z: -32 }, to: { x: -37, y: 71, z: -32 }, block: 'oak_planks' },
      bot, {}, { goTo: walk },
    )

    expect(walk).not.toHaveBeenCalled()
    expect(r).toContain('4 placed')
  })
})
