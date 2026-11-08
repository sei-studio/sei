// placeSpots + placeBlock's spot search (261108, quality pass 46): tables and
// furnaces in grass, beside her own hitbox, in water, in a pit.
import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { findPlaceSpots, findOpenStandSpot, checkPlaceCell, bodyInCell } from './placeSpots.js'

vi.mock('./pathfind.js', () => ({ goTo: vi.fn(async () => 'reached') }))
import { goTo } from './pathfind.js'
import { placeBlockAction } from './place.js'

const SOLID = new Set(['grass_block', 'dirt', 'stone', 'crafting_table', 'sand'])
const key = (x, y, z) => `${x},${y},${z}`

// A world of named cells; anything unset is air. `ground(y)` fills a floor.
function makeWorld() {
  const cells = new Map()
  const w = {
    set(x, y, z, name) { cells.set(key(x, y, z), name); return w },
    fill(x0, y0, z0, x1, y1, z1, name) {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) w.set(x, y, z, name)
      return w
    },
    blockAt(p) {
      const name = cells.get(key(p.x, p.y, p.z)) ?? 'air'
      return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: SOLID.has(name) ? 'block' : 'empty' }
    },
  }
  return w
}

function makeBot(world, pos = { x: 0.5, y: 64, z: 0.5 }) {
  return {
    entity: { position: new Vec3(pos.x, pos.y, pos.z), eyeHeight: 1.62 },
    entities: {},
    blockAt: (p) => world.blockAt(p),
  }
}

// Ground at y=63 (she stands at y=64) over a 21x21 patch.
const flat = () => makeWorld().fill(-10, 62, -10, 10, 63, 10, 'grass_block')

describe('findPlaceSpots', () => {
  it('finds spots in a meadow where every cell holds a grass tuft', () => {
    const w = flat().fill(-10, 64, -10, 10, 64, 10, 'short_grass')
    const spots = findPlaceSpots(makeBot(w))
    expect(spots.length).toBeGreaterThan(10)
    expect(spots[0].kind).toBe('plant')
    expect(spots[0].cell.y).toBe(64) // on her own level
    expect(spots[0].refBlk.name).toBe('grass_block') // clicks the ground, never the tuft
  })

  it('leaves out a cell her own hitbox pokes into', () => {
    const bot = makeBot(flat(), { x: 0.85, y: 64, z: 0.5 })
    expect(bodyInCell(bot, { x: 1, y: 64, z: 0 })).toBe('you')
    expect(checkPlaceCell(bot, { x: 1, y: 64, z: 0 })).toBe(null)
    expect(findPlaceSpots(bot).some((s) => s.cell.x === 1 && s.cell.y === 64 && s.cell.z === 0)).toBe(false)
  })

  it('leaves out a cell behind a wall and one on a crafting table', () => {
    const w = flat().fill(2, 64, -10, 2, 66, 10, 'stone').set(-1, 64, 0, 'crafting_table')
    const bot = makeBot(w)
    expect(checkPlaceCell(bot, { x: 3, y: 64, z: 0 })).toBe(null) // behind the wall
    expect(checkPlaceCell(bot, { x: -1, y: 65, z: 0 })).toBe(null) // clicking the table opens it
    expect(checkPlaceCell(bot, { x: 1, y: 64, z: 0 })).not.toBe(null)
  })

  it('ranks water last and finds none dry in a pond', () => {
    const w = flat().fill(-5, 63, -5, 5, 63, 5, 'water').fill(-5, 62, -5, 5, 62, 5, 'sand')
    const bot = makeBot(w, { x: 0.5, y: 63, z: 0.5 })
    expect(findPlaceSpots(bot, { dryOnly: true })).toEqual([])
    const all = findPlaceSpots(bot)
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((s) => s.kind === 'wet')).toBe(true)
  })

  it('reaches the rim from a 1x1 pit two deep', () => {
    const w = flat().fill(0, 62, 0, 0, 63, 0, 'air').fill(-10, 60, -10, 10, 61, 10, 'stone')
    const bot = makeBot(w, { x: 0.5, y: 62, z: 0.5 })
    const spots = findPlaceSpots(bot)
    expect(spots.length).toBeGreaterThan(0)
    expect(spots[0].cell.y).toBe(64)
  })
})

describe('findOpenStandSpot', () => {
  it('finds the bank from the middle of a pond', () => {
    const w = flat().fill(-5, 63, -5, 5, 63, 5, 'water').fill(-5, 62, -5, 5, 62, 5, 'sand')
    const s = findOpenStandSpot(makeBot(w, { x: 0.5, y: 63, z: 0.5 }))
    expect(s).not.toBe(null)
    expect(Math.max(Math.abs(s.x), Math.abs(s.z))).toBeGreaterThanOrEqual(6)
    expect(s.y).toBe(64)
  })
})

describe('placeBlockAction spot search', () => {
  function placingBot(world, pos, item = 'crafting_table') {
    const bot = makeBot(world, pos)
    bot.inventory = { items: () => [{ name: item, count: 1 }] }
    bot.equip = vi.fn(async () => {})
    bot.placeBlock = vi.fn(async (ref, face) => {
      const d = ref.position.plus(face)
      if (bodyInCell(bot, d)) throw new Error('No block has been placed : the block is still air')
      world.set(d.x, d.y, d.z, item)
    })
    return bot
  }

  it('puts a table down in a meadow and says so', async () => {
    const w = flat().fill(-10, 64, -10, 10, 64, 10, 'short_grass')
    const bot = placingBot(w)
    const r = await placeBlockAction({ block: 'crafting_table' }, bot, {})
    expect(r).toMatch(/^placed crafting_table on grass_block @/)
    expect(bot.placeBlock).toHaveBeenCalledTimes(1)
  })

  it('tries the next spot when the first is refused', async () => {
    const w = flat()
    const bot = placingBot(w)
    let n = 0
    const inner = bot.placeBlock
    bot.placeBlock = vi.fn(async (ref, face) => { if (n++ === 0) throw new Error('refused'); return inner(ref, face) })
    const r = await placeBlockAction({ block: 'crafting_table' }, bot, {})
    expect(r).toMatch(/^placed crafting_table/)
    expect(bot.placeBlock).toHaveBeenCalledTimes(2)
  })

  it('steps out of a pond to the bank before putting it in the water', async () => {
    goTo.mockClear()
    const w = flat().fill(-5, 63, -5, 5, 63, 5, 'water').fill(-5, 62, -5, 5, 62, 5, 'sand')
    const bot = placingBot(w, { x: 0.5, y: 63, z: 0.5 })
    goTo.mockImplementationOnce(async (b, x, y, z) => { b.entity.position = new Vec3(x + 0.5, y, z + 0.5); return 'reached' })
    const r = await placeBlockAction({ block: 'crafting_table' }, bot, {})
    expect(goTo).toHaveBeenCalledTimes(1)
    expect(r).toMatch(/^placed crafting_table on grass_block @.* \(stepped to .* first: no open spot right beside you\)$/)
  })

  it('uses her own aim when it names an open cell, even a tuft', async () => {
    const w = flat().fill(-10, 64, -10, 10, 64, 10, 'short_grass')
    const bot = placingBot(w)
    const r = await placeBlockAction({ block: 'crafting_table', against: { x: -2, y: 64, z: 1 } }, bot, {})
    expect(r).toBe('placed crafting_table on grass_block @-2,63,1')
  })

  it('fails honestly when there is nowhere at all', async () => {
    const w = makeWorld().fill(-10, 62, -10, 10, 70, 10, 'stone').fill(0, 64, 0, 0, 65, 0, 'air')
    const bot = placingBot(w)
    const r = await placeBlockAction({ block: 'crafting_table' }, bot, {})
    expect(r).toMatch(/^couldn't place crafting_table: no open spot in reach\. Walk a few blocks/)
    expect(bot.placeBlock).not.toHaveBeenCalled()
  })
})
