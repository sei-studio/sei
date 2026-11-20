/**
 * Furnaces she saw earlier this session, pass 35 (261101).
 *
 * smelt_iron benchmark, 2026-11-01 B#3: her opening gather walked her ~20
 * blocks from the furnace (past the 16-block survey) before the order came,
 * so the furnace she had seen was gone from the snapshot and she set off to
 * build one. The line only shows while she holds something to smelt and no
 * furnace is in view, so ordinary turns carry nothing extra.
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { isSmeltableMetal, noteSeenStations, seenStationLine } from './seenStations.js'
import { composeSnapshot } from './snapshot.js'

const furnaceGroup = (x, y, z) => ({ name: 'furnace', total: 1, nearest: { x, y, z } })

function bot({ at = new Vec3(176.5, 71, 0.5), blocks = {} } = {}) {
  return {
    entity: { position: at },
    game: { dimension: 'overworld' },
    blockAt: (p) => blocks[`${p.x},${p.y},${p.z}`] ?? null,
  }
}

describe('isSmeltableMetal', () => {
  it('is raw metal and ore, not ingots or fuel', () => {
    for (const n of ['raw_iron', 'raw_gold', 'raw_copper', 'iron_ore', 'deepslate_gold_ore']) expect(isSmeltableMetal(n)).toBe(true)
    for (const n of ['iron_ingot', 'coal', 'raw_beef', 'cobblestone', undefined]) expect(isSmeltableMetal(n)).toBe(false)
  })
})

describe('seenStationLine', () => {
  it('names a furnace seen earlier once it has left the survey', () => {
    const b = bot()
    noteSeenStations(b, [furnaceGroup(179, 71, 2)], 1000)
    b.entity.position = new Vec3(160.5, 71, -10.5)
    const line = seenStationLine(b, [], { raw_iron: 3 }, 2000)
    expect(line).toBe('furnace you saw earlier: @179,71,2 (23 blocks away)')
    expect(line).not.toMatch(/—/)
  })

  it('says nothing while a furnace is in view', () => {
    const b = bot()
    noteSeenStations(b, [furnaceGroup(179, 71, 2)], 1000)
    expect(seenStationLine(b, [furnaceGroup(179, 71, 2)], { raw_iron: 3 }, 2000)).toBeNull()
  })

  it('says nothing unless she holds something to smelt', () => {
    const b = bot()
    noteSeenStations(b, [furnaceGroup(179, 71, 2)], 1000)
    b.entity.position = new Vec3(150.5, 71, 0.5)
    expect(seenStationLine(b, [], { oak_log: 8, iron_ingot: 2 }, 2000)).toBeNull()
    expect(seenStationLine(b, [], {}, 2000)).toBeNull()
  })

  it('says nothing when nothing was seen', () => {
    expect(seenStationLine(bot(), [], { raw_iron: 3 }, 2000)).toBeNull()
  })

  it('picks the nearest of several, across furnace and blast furnace', () => {
    const b = bot()
    noteSeenStations(b, [furnaceGroup(200, 71, 0)], 1000)
    noteSeenStations(b, [{ name: 'blast_furnace', total: 1, nearest: { x: 150, y: 71, z: 0 } }], 1100)
    b.entity.position = new Vec3(160.5, 71, 0.5)
    expect(seenStationLine(b, [], { raw_iron: 1 }, 2000)).toMatch(/^blast_furnace you saw earlier: @150,71,0/)
  })

  it('forgets one after 20 minutes, past 96 blocks, or in another dimension', () => {
    const b = bot()
    noteSeenStations(b, [furnaceGroup(179, 71, 2)], 0)
    b.entity.position = new Vec3(150.5, 71, 0.5)
    expect(seenStationLine(b, [], { raw_iron: 1 }, 20 * 60 * 1000 + 1)).toBeNull()
    expect(b._seiSeenStations.furnace).toHaveLength(0)

    noteSeenStations(b, [furnaceGroup(179, 71, 2)], 0)
    b.entity.position = new Vec3(400.5, 71, 0.5)
    expect(seenStationLine(b, [], { raw_iron: 1 }, 1000)).toBeNull()

    b.entity.position = new Vec3(150.5, 71, 0.5)
    b.game.dimension = 'the_nether'
    expect(seenStationLine(b, [], { raw_iron: 1 }, 1000)).toBeNull()
  })

  it('drops one whose loaded block is no longer a furnace, keeps one in an unloaded chunk', () => {
    const b = bot({ blocks: { '179,71,2': { name: 'air' } } })
    noteSeenStations(b, [furnaceGroup(179, 71, 2)], 0)
    noteSeenStations(b, [furnaceGroup(120, 71, 0)], 10)
    b.entity.position = new Vec3(150.5, 71, 0.5)
    const line = seenStationLine(b, [], { raw_iron: 1 }, 1000)
    expect(line).toMatch(/^furnace you saw earlier: @120,71,0/)
    expect(b._seiSeenStations.furnace.map((p) => p.x)).toEqual([120])
  })

  it('keeps a short list per station and moves a re-seen one to the end', () => {
    const b = bot()
    for (let i = 0; i < 8; i++) noteSeenStations(b, [furnaceGroup(100 + i, 71, 0)], i)
    expect(b._seiSeenStations.furnace).toHaveLength(6)
    noteSeenStations(b, [furnaceGroup(103, 71, 0)], 100)
    const list = b._seiSeenStations.furnace
    expect(list).toHaveLength(6)
    expect(list.at(-1)).toMatchObject({ x: 103, t: 100 })
    expect(list.filter((p) => p.x === 103)).toHaveLength(1)
  })

  it('ignores junk input', () => {
    expect(() => noteSeenStations(null, [furnaceGroup(1, 2, 3)])).not.toThrow()
    expect(() => noteSeenStations(bot(), null)).not.toThrow()
    const b = bot()
    noteSeenStations(b, [{ name: 'furnace', nearest: { x: NaN, y: 0, z: 0 } }, { name: 'chest', nearest: { x: 1, y: 2, z: 3 } }])
    expect(b._seiSeenStations).toBeUndefined()
  })
})

describe('snapshot wiring', () => {
  function snapBot(items) {
    let furnaceVisible = true
    const furnacePos = new Vec3(179, 71, 2)
    const b = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(176.5, 71, 0.5), yaw: 0, pitch: 0 },
      username: 'Sei',
      entities: {},
      players: {},
      inventory: { items: () => items, slots: [] },
      findBlocks: () => (furnaceVisible ? [furnacePos] : []),
      findBlock: () => null,
      blockAt: (p) => (furnaceVisible && p.x === 179 && p.y === 71 && p.z === 2
        ? { name: 'furnace', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p }
        : { name: 'air', boundingBox: 'empty', shapes: [], position: p }),
      health: 20,
      food: 20,
      game: { dimension: 'overworld' },
      time: { timeOfDay: 1000 },
    })
    b.hideFurnace = () => { furnaceVisible = false }
    return b
  }

  it('shows the line after the furnace leaves view while she holds raw iron', () => {
    const b = snapBot([{ name: 'raw_iron', count: 3 }])
    const first = composeSnapshot(b, {})
    expect(first).toContain('furnace x1 @179,71,2')
    expect(first).not.toContain('you saw earlier')
    // She walks off and the furnace leaves the survey. blockAt now reads air
    // there too, so make the remembered block look unloaded instead.
    b.hideFurnace()
    b.blockAt = (p) => (p.x === 179 && p.y === 71 && p.z === 2 ? null : { name: 'air', boundingBox: 'empty', shapes: [], position: p })
    b.entity.position = new Vec3(158.5, 71, 0.5)
    expect(composeSnapshot(b, {})).toContain('furnace you saw earlier: @179,71,2 (21 blocks away)')
  })

  it('adds nothing on an ordinary turn', () => {
    const b = snapBot([{ name: 'oak_log', count: 4 }])
    composeSnapshot(b, {})
    b.hideFurnace()
    expect(composeSnapshot(b, {})).not.toContain('you saw earlier')
  })
})
