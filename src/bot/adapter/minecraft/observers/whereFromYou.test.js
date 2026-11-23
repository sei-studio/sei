// 261114 (quality pass 55): where listed blocks and entities are, in words,
// next to their coordinates. With only the numbers she read them out in chat
// ("already got one down at 174,70,-2 lol").

import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { composeSnapshot } from './snapshot.js'
import { whereFromYou } from './whereFromYou.js'

describe('whereFromYou', () => {
  const me = { x: 0, y: 64, z: 0 }
  it('names distance and an 8-way compass direction (north = -z, east = +x)', () => {
    expect(whereFromYou({ x: 0, y: 64, z: -9 }, me)).toBe('9 blocks north')
    expect(whereFromYou({ x: 8, y: 64, z: 0 }, me)).toBe('8 blocks east')
    expect(whereFromYou({ x: -5, y: 64, z: 5 }, me)).toBe('7 blocks southwest')
  })
  it('adds the height difference from 4 blocks', () => {
    expect(whereFromYou({ x: -10, y: 58, z: 8 }, me)).toBe('14 blocks southwest, 6 down')
    expect(whereFromYou({ x: 10, y: 67, z: 0 }, me)).toBe('10 blocks east')
    expect(whereFromYou({ x: 10, y: 70, z: 0 }, me)).toBe('12 blocks east, 6 up')
  })
  it('says right by you up close, above or below when straight up or down', () => {
    expect(whereFromYou({ x: 1, y: 63, z: 1 }, me)).toBe('right by you')
    expect(whereFromYou({ x: 0, y: 50, z: 1 }, me)).toBe('14 blocks below you')
  })
  it('says by the player when it is near them, not when it is right by her', () => {
    const owner = { pos: { x: 6, y: 64, z: 2 }, name: 'Alex' }
    expect(whereFromYou({ x: 5, y: 64, z: 4 }, me, owner)).toBe('6 blocks southeast, by Alex')
    expect(whereFromYou({ x: -8, y: 64, z: 0 }, me, owner)).toBe('8 blocks west')
    expect(whereFromYou({ x: 1, y: 64, z: 0 }, me, { pos: { x: 2, y: 64, z: 0 }, name: 'Alex' })).toBe('right by you')
  })
  it('is null without positions', () => {
    expect(whereFromYou(null, me)).toBeNull()
    expect(whereFromYou({ x: 1, y: 2, z: 3 }, null)).toBeNull()
    expect(whereFromYou({ x: NaN, y: 2, z: 3 }, me)).toBeNull()
  })
})

// Grass at y 63, a crafting table by Alex, iron ore down in a pit west.
function campBot() {
  const alex = { id: 2, username: 'Alex', type: 'player', position: new Vec3(6, 64, 2), height: 1.8 }
  const sheep = { id: 8, name: 'sheep', type: 'animal', position: new Vec3(0, 64, -9), height: 1.3 }
  const TABLE = new Vec3(5, 64, 4)
  const IRON = new Vec3(-10, 58, 8)
  const blocks = [TABLE, IRON]
  const nameAt = (p) => {
    if (p.equals(TABLE)) return 'crafting_table'
    if (p.equals(IRON)) return 'iron_ore'
    return 'air'
  }
  return Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, eyeHeight: 1.6 },
    username: 'Sui',
    entities: { 2: alex, 8: sheep },
    players: { Alex: { username: 'Alex', entity: alex } },
    _seiOwnerNames: ['alex'],
    inventory: { items: () => [], slots: [] },
    findBlocks: ({ point, maxDistance = 16 } = {}) => blocks.filter((b) => !point || b.distanceTo(point) <= maxDistance),
    findBlock: () => null,
    blockAt: (p) => {
      const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const name = nameAt(q)
      return { name, shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], boundingBox: name === 'air' ? 'empty' : 'block', position: q }
    },
    health: 20,
    food: 20,
    game: { dimension: 'overworld' },
    time: { timeOfDay: 1000 },
  })
}

describe('snapshot nearby lists say where things are (261114)', () => {
  it('keeps the coordinates for the tools and adds where in words', () => {
    const snap = composeSnapshot(campBot(), { pinUsername: 'Alex' })
    expect(snap).toMatch(/ crafting_table x1 @5,64,4 \(6 blocks southeast, by Alex\)$/m)
    expect(snap).toMatch(/ iron_ore x1 @-10,58,8 \(14 blocks southwest, 6 down\)$/m)
    expect(snap).toMatch(/ sheep @0,64,-9 \(10 blocks north\)$/m)
    // The player's own line takes no "by Alex".
    expect(snap).toMatch(/ Alex @6,64,2 \(6 blocks east\)$/m)
  })
})
