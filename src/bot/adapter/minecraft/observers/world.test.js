// src/bot/adapter/minecraft/observers/world.test.js
//
// 260617: describeSurroundings must not label open terrain "underground" just
// because stored skyLight reads 0 — it under-reports on freshly-loaded chunks
// (the first seconds after join) and at the foot of a cliff. A mountainside
// spawn was mislabelled "underground" and the bot dug straight UP out of open
// ground. These pin: clear sky → outside; skyLight 0 but open column → outside;
// roof + daylight a short hop away → sheltered; sealed → underground.
//
// 260721: the roof scan passed plain {x,y,z} to blockAt, which throws in real
// prismarine-world (`pos.floored()` is a Vec3 method), so live play collapsed
// everything non-'outside' to 'unknown' — while these tests passed, because
// the old mock accepted plain objects. The mock is now strict: blockAt rejects
// anything without `.floored()`, mimicking the real library. Also pinned: a
// cavern taller than the old 24-block scan cap is 'underground' not 'outside',
// and sky visible only straight up (shaft/ravine bottom) is 'pit' not
// 'outside'.

import { describe, it, expect } from 'vitest'
import { world } from './world.js'

// Mock bot. `sky` maps "x,y,z" -> skyLight (fallback `sky.default`); `solid` is
// the set of "x,y,z" the column scan sees as full blocks. blockAt insists on a
// real Vec3 (has `.floored()`), exactly like prismarine-world does.
function makeBot({ sky = {}, solid = new Set(), pos = { x: 0, y: 64, z: 0 }, game } = {}) {
  return {
    version: '1.21.1',
    entity: { position: pos },
    time: { isDay: true, timeOfDay: 1000 },
    game,
    world: {
      getBiome: () => undefined,
      getSkyLight: ({ x, y, z }) => {
        const k = `${x},${y},${z}`
        return k in sky ? sky[k] : (sky.default ?? 0)
      },
      getBlockLight: () => 0,
    },
    blockAt: (p) => {
      if (typeof p?.floored !== 'function') {
        throw new TypeError('blockAt requires a Vec3 (real prismarine-world calls pos.floored())')
      }
      return { boundingBox: solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' }
    },
  }
}

describe('describeSurroundings (via world().surroundings)', () => {
  it('clear sky overhead and daylight all around → outside', () => {
    expect(world(makeBot({ sky: { default: 15 } })).surroundings).toBe('outside')
  })

  it('skyLight 0 but an OPEN column above → outside (fresh-chunk / cliff-foot guard)', () => {
    // The 260617 mountainside bug: stored skyLight 0 everywhere, nothing solid
    // overhead. Must NOT read as "underground".
    expect(world(makeBot({ sky: { default: 0 }, solid: new Set() })).surroundings).toBe('outside')
  })

  it('roof overhead with open sky a short hop away → sheltered', () => {
    const solid = new Set(['0,67,0'])        // block in the head column
    const sky = { default: 0, '5,65,0': 14 } // daylight 5 blocks east at head height
    expect(world(makeBot({ sky, solid })).surroundings).toBe('sheltered')
  })

  it('roof overhead and no daylight anywhere near → underground', () => {
    const solid = new Set(['0,67,0'])
    expect(world(makeBot({ sky: { default: 0 }, solid })).surroundings).toBe('underground')
  })

  it('cavern ceiling ABOVE the old 24-block scan cap → still underground', () => {
    // Marv-in-a-cave regression class: a tall cave (roof 56 blocks up) used to
    // exhaust the fixed-24 scan, read "no roof", and report 'outside'.
    const solid = new Set(['0,120,0'])
    expect(world(makeBot({ sky: { default: 0 }, solid })).surroundings).toBe('underground')
  })

  it('sky visible ONLY straight up (shaft / ravine bottom) → pit, not outside', () => {
    const sky = { default: 0, '0,65,0': 15 } // bright in own head column only
    expect(world(makeBot({ sky })).surroundings).toBe('pit')
  })

  it('daylight in the +3 ring row keeps a shallow trench reading outside', () => {
    // 2-deep trench: head column sees sky, ring at head height is inside the
    // trench walls (dark), but 3 above head is open ground.
    const sky = { default: 0, '0,65,0': 15, '5,68,0': 15 }
    expect(world(makeBot({ sky })).surroundings).toBe('outside')
  })

  it('respects the dimension build height from bot.game', () => {
    // Roof above the dimension top must not count: minY 0 + height 80 → scan
    // stops at y=80, the block at y=90 is never seen → open column → outside.
    const solid = new Set(['0,90,0'])
    const bot = makeBot({ sky: { default: 0 }, solid, game: { minY: 0, height: 80 } })
    expect(world(bot).surroundings).toBe('outside')
  })
})

describe('world().light', () => {
  it('reports sky and block light at the head', () => {
    const w = world(makeBot({ sky: { default: 7 } }))
    expect(w.light).toEqual({ sky: 7, block: 0 })
  })

  it('nulls out when light data is unavailable', () => {
    const bot = makeBot({})
    bot.world.getSkyLight = () => { throw new Error('no chunk') }
    bot.world.getBlockLight = undefined
    expect(world(bot).light).toEqual({ sky: null, block: null })
  })
})
