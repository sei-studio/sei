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
import { buildAction, enumerateBuildCells, WALK_TIMEOUT_MS } from './build.js'

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
