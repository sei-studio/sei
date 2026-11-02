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
    // Walk mock: teleport the bot next to the requested column, one block
    // inside the ring so it never stands inside a wall cell (261019: a body
    // in a cell is now reported instead of attempted).
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
    const walkMock = vi.fn(async (b, x, y, z) => {
      b.entity.position = new Vec3(clamp(x, -37, -33) + 0.5, 68, clamp(z, -31, -27) + 0.5)
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
        if (!name) return { name: 'air', position: p, boundingBox: 'empty' }
        return { name, position: p, boundingBox: name === 'water' ? 'empty' : 'block' }
      },
      equip: async () => {},
      look: async () => {},
      setControlState(control, on) {
        if (control !== 'jump' || !on) return
        if (bot._inWater) return // standing on the bottom of a pool, a jump does not lift the feet clear
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

  // 261011: quality eval 2026-10-11 (gather_craft). Standing on the bottom of
  // water, the feet cell (water) counted as already placed and the bot never
  // left the ground, so the loop spun on resolved promises, starved the event
  // loop, and the server timed the bot out. It must come back with a result.
  it('standing in water: does not count the water as a placed block, and returns', async () => {
    const { bot, blocks } = pillarBot()
    bot._inWater = true
    blocks.set('0,64,0', 'water')
    bot.placeBlock = async () => { throw new Error('no block update') }
    const ticks = { n: 0 }
    const iv = setInterval(() => { ticks.n++ }, 10)
    const r = await buildAction({ direction: 'below', count: 2, block: 'dirt' }, bot, {})
    clearInterval(iv)
    expect(r).toBe('could not pillar up, you did not rise and are still at 0,64,0: scaffold place failed: you are in water, where a jump does not clear the cell under you. Get onto dry ground first')
    expect(ticks.n).toBeGreaterThan(0) // timers kept running while it tried
  })

  it('a block that lands but leaves the feet where they were ends the climb instead of looping', async () => {
    const { bot, blocks } = pillarBot()
    blocks.set('0,64,0', 'water')
    bot.setControlState = (control, on) => {
      if (control !== 'jump' || !on) return
      bot.entity.onGround = false
      bot.entity.position = new Vec3(0.5, 64.8, 0.5)
    }
    // The block lands, but the server puts the bot back where it was.
    bot.placeBlock = async () => {
      blocks.set('0,64,0', 'dirt')
      bot.entity.position = new Vec3(0.5, 64, 0.5)
      bot.entity.onGround = true
    }
    const r = await buildAction({ direction: 'below', count: 2, block: 'dirt' }, bot, {})
    expect(r).toBe('could not pillar up, you did not rise and are still at 0,64,0: scaffold place failed: the block went down but you did not rise onto it')
  })

  // 261017 (pass 12), errands eval: she stood on the EDGE of a block with
  // her feet column over her own shaft, and the pillar came back "no solid
  // floor below". It now steps onto the block holding her up and pillars.
  it('standing off-centre over a gap: steps onto the supporting block and pillars from there', async () => {
    const { bot, blocks } = pillarBot()
    blocks.delete('0,63,0') // the shaft under her feet column
    bot.entity.position = new Vec3(0.75, 64, 0.5) // hitbox reaches into x=1
    bot.lookAt = async () => {}
    const moves = []
    bot.setControlState = (control, on) => {
      if (control === 'forward' && on) { moves.push('forward'); bot.entity.position = new Vec3(1.5, 64, 0.5); return }
      if (control !== 'jump' || !on) return
      bot.entity.onGround = false
      const p = bot.entity.position
      bot.entity.position = new Vec3(p.x, Math.floor(p.y) + 1.2, p.z)
    }
    bot.placeBlock = async (ref) => {
      const cellY = ref.position.y + 1
      blocks.set(`${ref.position.x},${cellY},${ref.position.z}`, 'dirt')
      bot.entity.position = new Vec3(ref.position.x + 0.5, cellY + 1, ref.position.z + 0.5)
      bot.entity.onGround = true
    }
    const r = await buildAction({ direction: 'below', count: 2, block: 'dirt' }, bot, {})
    expect(moves.length).toBeGreaterThan(0)
    expect(r).toBe('pillared up 2 blocks (standing at y=66)')
    expect(blocks.get('1,64,1')).toBeUndefined()
    expect(blocks.get('1,64,0')).toBe('dirt')
  })

  it('off-centre with nothing solid under any part of her: still says no floor', async () => {
    const { bot, blocks } = pillarBot()
    for (const k of [...blocks.keys()]) blocks.delete(k)
    bot.entity.position = new Vec3(0.75, 64, 0.5)
    const r = await buildAction({ direction: 'below', count: 1, block: 'dirt' }, bot, {})
    expect(r).toBe('could not pillar up, you did not rise and are still at 0,64,0: scaffold failed: no solid floor below')
  })

  // 261017: a block right above her head. The jump cannot lift her, and the
  // old result was a bare "could not place block under feet".
  it('no head room: says which block is over her head, without jumping', async () => {
    const { bot, blocks } = pillarBot()
    blocks.set('0,66,0', 'dirt')
    let jumps = 0
    const set = bot.setControlState
    bot.setControlState = (c, on) => { if (c === 'jump' && on) jumps++; return set(c, on) }
    const r = await buildAction({ direction: 'below', count: 1, block: 'dirt' }, bot, {})
    expect(r).toBe('could not pillar up, you did not rise and are still at 0,64,0: scaffold failed: no head room. There is dirt at 0,66,0 right above your head, ' +
      'so you cannot jump to put a block under you. Dig that block out first, or move to a spot with open space above')
    expect(jumps).toBe(0)
  })

  it('no head room under a built ceiling: does not tell her to dig it', async () => {
    const { bot, blocks } = pillarBot()
    blocks.set('0,66,0', 'oak_planks')
    const r = await buildAction({ direction: 'below', count: 1, block: 'dirt' }, bot, {})
    expect(r).toMatch(/There is oak_planks at 0,66,0 right above your head/)
    expect(r).toMatch(/you do not dig through builds/)
    expect(r).not.toMatch(/Dig that block out/)
  })

  // Review: the step onto the supporting block stops on abort, and leaves
  // the controls alone when a reflex has taken the body.
  it('the off-centre step stops on abort and does not clear a reflex flee', async () => {
    const { bot, blocks } = pillarBot()
    blocks.delete('0,63,0')
    bot.entity.position = new Vec3(0.75, 64, 0.5)
    bot.lookAt = async () => {}
    const ac = new AbortController()
    const calls = []
    bot.setControlState = (control, on) => {
      calls.push([control, on])
      if (control === 'forward' && on) {
        // The step is under way when a creeper reflex takes over.
        bot._seiReflexActive = true
        ac.abort()
      }
    }
    const t0 = Date.now()
    const r = await buildAction({ direction: 'below', count: 1, block: 'dirt' }, bot, { signal: ac.signal })
    expect(Date.now() - t0).toBeLessThan(600)
    expect(r).toMatch(/^aborted/)
    expect(calls).not.toContainEqual(['forward', false])
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

// 261012 — quality eval build_shelter. Walls one layer above the ground
// float: no cell has a block under or beside it. The old result said "could
// not reach or place them, walk near and call build again", which sent the
// model back to the same floating span. A solid roof built from the middle
// out also failed its inner cells, which have no neighbor until the edge
// cells are down.
describe('buildAction — cells with nothing to place against (261012)', () => {
  it('says the span is floating and names the layer to start on, without walking or placing', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    const walkMock = vi.fn(async () => 'reached')
    // Ground is y=67 and the bot stands at 68; this wall starts at 71, three
    // layers up (more than the two a whole span is moved down by itself).
    const r = await buildAction(
      { from: { x: -40, y: 71, z: -34 }, to: { x: -36, y: 73, z: -30 }, block: 'oak_planks', hollow: true },
      bot, {}, { goTo: walkMock },
    )
    expect(r).toMatch(/^built 0 placed, 48 cells FAILED/)
    expect(r).toContain('48 of them had nothing to place against')
    expect(r).toContain('the ground under them is at y=67, so start the span at y=68')
    expect(placeBlockAction).not.toHaveBeenCalled()
    expect(walkMock).not.toHaveBeenCalled()
  })

  it('a flat floating span gets no ground hint (it may be a walkway over a gap)', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    const r = await buildAction(
      { from: { x: -40, y: 75, z: -34 }, to: { x: -38, y: 75, z: -34 }, block: 'oak_planks' },
      bot, {}, { goTo: vi.fn(async () => 'reached') },
    )
    expect(r).toContain('3 of them had nothing to place against')
    expect(r).not.toContain('ground under them')
    expect(r).toContain('a walkway starts at the block under your own feet')
  })

  it('fills a solid roof from its edges inward instead of failing the middle', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    // 5x5 walls, 3 high, already standing; the bot is inside at the center.
    for (const c of enumerateBuildCells({ x: -38, y: 68, z: -32 }, { x: -34, y: 70, z: -28 }, true)) {
      blocks.set(`${c.x},${c.y},${c.z}`, 'oak_planks')
    }
    bot.entity.position = new Vec3(-35.5, 68, -29.5)
    const r = await buildAction(
      { from: { x: -38, y: 71, z: -32 }, to: { x: -34, y: 71, z: -28 }, block: 'oak_planks' },
      bot, {}, { goTo: vi.fn(async () => 'reached') },
    )
    expect(r).toBe('built 25 placed, 0 skipped (already solid), of 25 cells')
    for (let x = -38; x <= -34; x++) for (let z = -32; z <= -28; z++) expect(blocks.get(`${x},71,${z}`)).toBe('oak_planks')
  })
})

describe('buildAction — grass and snow are built over, not counted as solid (261012)', () => {
  it('places into grass tufts and never uses one as the face to place against', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    blocks.set('-38,68,-32', 'short_grass')
    blocks.set('-37,68,-32', 'tall_grass')
    blocks.set('-36,68,-32', 'snow')
    const r = await buildAction(
      { from: { x: -38, y: 68, z: -32 }, to: { x: -36, y: 68, z: -32 }, block: 'oak_planks' },
      bot, {}, { goTo: vi.fn(async () => 'reached') },
    )
    expect(r).toBe('built 3 placed, 0 skipped (already solid), of 3 cells')
    for (const x of [-38, -37, -36]) expect(blocks.get(`${x},68,-32`)).toBe('oak_planks')
    // Every place went against the sand below, not a plant beside it.
    for (const call of placeBlockAction.mock.calls) expect(call[0].against.y).toBe(67)
  })
})

// 261019 (quality pass 19): she retried the same 1-cell build three times
// with "0 placed, could not reach or place" while a body stood in the cell.
describe('buildAction: a body in the cell (261019)', () => {
  it('names who stands in the cell instead of "could not reach or place"', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    bot.entities = { 7: { id: 7, type: 'player', username: 'Alex', position: new Vec3(-37.5, 68, -31.5), width: 0.6, height: 1.8 } }
    const walkMock = vi.fn(async () => 'reached')
    bot.entity.position = new Vec3(-36.5, 68, -30.5)
    const r = await buildAction(
      { from: { x: -38, y: 68, z: -32 }, to: { x: -38, y: 68, z: -32 }, block: 'oak_planks' },
      bot, {}, { goTo: walkMock, bodyWaitMs: 0 },
    )
    expect(r).toContain('1 cells FAILED')
    expect(r).toContain('had Alex standing in them')
    expect(r).not.toContain('could not reach or place them')
  })

  it('bodyInCell: herself, a player, and not a dropped item', async () => {
    const { bodyInCell } = await import('./build.js')
    const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {} }
    expect(bodyInCell(bot, { x: 0, y: 65, z: 0 })).toBe('you')
    expect(bodyInCell(bot, { x: 0, y: 66, z: 0 })).toBe(null)
    bot.entities = { 2: { type: 'object', name: 'item', position: new Vec3(3.5, 64, 0.5) }, 3: { type: 'player', username: 'Alex', position: new Vec3(5.5, 64, 0.5) } }
    expect(bodyInCell(bot, { x: 3, y: 64, z: 0 })).toBe(null)
    expect(bodyInCell(bot, { x: 5, y: 64, z: 0 })).toBe('Alex')
  })
})

// 261019 (pass 19): shelter builds one part from several block kinds, so a
// short kind places what it has and says it ran out instead of refusing.
describe('buildAction: partial mode (261019)', () => {
  function countedBot(n) {
    const { bot, blocks } = makeWorld()
    let left = n
    bot.inventory = { items: () => (left > 0 ? [{ name: 'oak_planks', count: left }] : []) }
    wirePlaceMock(bot, blocks)
    const inner = placeBlockAction.getMockImplementation()
    placeBlockAction.mockImplementation(async (args) => {
      const r = await inner(args)
      if (r.startsWith('placed')) left--
      return r
    })
    bot.entity.position = new Vec3(-37.5, 68, -31.5)
    return bot
  }
  const span = { from: { x: -40, y: 68, z: -32 }, to: { x: -36, y: 68, z: -32 }, block: 'oak_planks' }

  it('without partial, refuses up front when short', async () => {
    const bot = countedBot(3)
    const r = await buildAction(span, bot, {}, { goTo: vi.fn(async () => 'reached') })
    expect(placeBlockAction).not.toHaveBeenCalled()
    expect(r).toMatch(/oak_planks/)
  })

  it('with partial, places what she has and reports running out', async () => {
    const bot = countedBot(3)
    const r = await buildAction(span, bot, {}, { goTo: vi.fn(async () => 'reached'), partial: true })
    expect(placeBlockAction).toHaveBeenCalledTimes(3)
    expect(r).toMatch(/^built 3 of ~5 needed, then ran out of oak_planks/)
  })
})

// 261102 (pass 36): the build failures left in free play after pass 19.
describe('buildAction: where the model meant it (261102)', () => {
  it('a wall that floats one layer above the ground is built on the ground', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    bot.entity.position = new Vec3(-37.5, 68, -31.5)
    const r = await buildAction(
      { from: { x: -40, y: 69, z: -34 }, to: { x: -40, y: 70, z: -30 }, block: 'oak_planks' },
      bot, {}, { goTo: vi.fn(async () => 'reached') },
    )
    expect(r).toBe('that span floated 1 above the ground, so it was built 1 lower, at y=68..69: built 10 placed, 0 skipped (already solid), of 10 cells')
    for (let z = -34; z <= -30; z++) {
      expect(blocks.get(`-40,68,${z}`)).toBe('oak_planks')
      expect(blocks.get(`-40,69,${z}`)).toBe('oak_planks')
      expect(blocks.get(`-40,70,${z}`)).toBeUndefined()
    }
  })

  it('one block aimed at the ground goes on top of it', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    bot.entity.position = new Vec3(-37.5, 68, -31.5)
    const r = await buildAction(
      { from: { x: -39, y: 67, z: -31 }, to: { x: -39, y: 67, z: -31 }, block: 'oak_planks' },
      bot, {}, { goTo: vi.fn(async () => 'reached') },
    )
    expect(r).toBe('-39,67,-31 is already sand, so it went on top of it at y=68: built 1 placed, 0 skipped (already solid), of 1 cells')
    expect(blocks.get('-39,68,-31')).toBe('oak_planks')
  })

  it('a span of terrain wider than one block is still refused', async () => {
    const { bot, blocks } = makeWorld()
    wirePlaceMock(bot, blocks)
    const r = await buildAction(
      { from: { x: -39, y: 67, z: -31 }, to: { x: -38, y: 67, z: -31 }, block: 'oak_planks' },
      bot, {}, { goTo: vi.fn(async () => 'reached') },
    )
    expect(r).toMatch(/^built NOTHING: all 2 cells of that span are ALREADY solid/)
  })
})

describe('buildAction: bodies in the cell, again (261102)', () => {
  function solidWorld() {
    const w = makeWorld()
    const inner = w.bot.blockAt
    w.bot.blockAt = (p) => { const b = inner(p); return b.name === 'air' ? { ...b, boundingBox: 'empty' } : { ...b, boundingBox: 'block' } }
    return w
  }

  it('she steps out of the cell she stands in and places it', async () => {
    const { bot, blocks } = solidWorld()
    wirePlaceMock(bot, blocks)
    bot.entity.position = new Vec3(-37.5, 68, -31.5)
    bot.entity.onGround = true
    const walk = vi.fn(async (b, x, y, z) => { b.entity.position = new Vec3(x + 0.5, y, z + 0.5); return 'reached' })
    const r = await buildAction(
      { from: { x: -38, y: 68, z: -32 }, to: { x: -38, y: 69, z: -32 }, block: 'oak_planks' },
      bot, {}, { goTo: walk },
    )
    expect(r).toBe('built 2 placed, 0 skipped (already solid), of 2 cells')
    expect(walk).toHaveBeenCalledTimes(1)
    const [, x, , z] = walk.mock.calls[0]
    expect(x === -38 && z === -32).toBe(false)
  })

  it('waits for a player to walk out of the cell, then places it', async () => {
    const { bot, blocks } = solidWorld()
    wirePlaceMock(bot, blocks)
    const alex = { id: 7, type: 'player', username: 'Alex', position: new Vec3(-37.5, 68, -31.5), width: 0.6, height: 1.8 }
    bot.entities = { 7: alex }
    bot.entity.position = new Vec3(-35.5, 68, -31.5)
    setTimeout(() => { alex.position = new Vec3(-30.5, 68, -31.5) }, 600)
    const r = await buildAction(
      { from: { x: -38, y: 68, z: -32 }, to: { x: -38, y: 68, z: -32 }, block: 'oak_planks' },
      bot, {}, { goTo: vi.fn(async () => 'reached') },
    )
    expect(r).toBe('built 1 placed, 0 skipped (already solid), of 1 cells')
  })

  it('a player who stays put still fails the cell, after a bounded wait', async () => {
    const { bot, blocks } = solidWorld()
    wirePlaceMock(bot, blocks)
    bot.entities = { 7: { id: 7, type: 'player', username: 'Alex', position: new Vec3(-37.5, 68, -31.5), width: 0.6, height: 1.8 } }
    bot.entity.position = new Vec3(-35.5, 68, -31.5)
    const t0 = Date.now()
    const r = await buildAction(
      { from: { x: -38, y: 68, z: -32 }, to: { x: -38, y: 68, z: -32 }, block: 'oak_planks' },
      bot, {}, { goTo: vi.fn(async () => 'reached'), bodyWaitMs: 500 },
    )
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(r).toContain('had Alex standing in them')
  })
})
