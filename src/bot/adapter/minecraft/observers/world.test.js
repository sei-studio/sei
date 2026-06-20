// src/bot/adapter/minecraft/observers/world.test.js
//
// 260617: describeSurroundings must not label open terrain "underground" just
// because stored skyLight reads 0 — it under-reports on freshly-loaded chunks
// (the first seconds after join) and at the foot of a cliff. A mountainside
// spawn was mislabelled "underground" and the bot dug straight UP out of open
// ground. These pin: clear sky → outside; skyLight 0 but open column → outside;
// roof + daylight a short hop away → sheltered; sealed → underground.

import { describe, it, expect } from 'vitest'
import { world } from './world.js'

// Mock bot. `sky` maps "x,y,z" -> skyLight (fallback `sky.default`); `solid` is
// the set of "x,y,z" the column raycast sees as full blocks.
function makeBot({ sky = {}, solid = new Set(), pos = { x: 0, y: 64, z: 0 } } = {}) {
  return {
    version: '1.21.1',
    entity: { position: pos },
    time: { isDay: true, timeOfDay: 1000 },
    world: {
      getBiome: () => undefined,
      getSkyLight: ({ x, y, z }) => {
        const k = `${x},${y},${z}`
        return k in sky ? sky[k] : (sky.default ?? 0)
      },
    },
    blockAt: ({ x, y, z }) => ({ boundingBox: solid.has(`${x},${y},${z}`) ? 'block' : 'empty' }),
  }
}

describe('describeSurroundings (via world().surroundings)', () => {
  it('clear sky overhead → outside', () => {
    expect(world(makeBot({ sky: { default: 15 } })).surroundings).toBe('outside')
  })

  it('skyLight 0 but an OPEN column above → outside (fresh-chunk / cliff-foot guard)', () => {
    // The 260617 mountainside bug: stored skyLight 0 everywhere, nothing solid
    // overhead. Must NOT read as "underground".
    expect(world(makeBot({ sky: { default: 0 }, solid: new Set() })).surroundings).toBe('outside')
  })

  it('roof overhead with open sky a short hop away → sheltered', () => {
    const solid = new Set(['0,67,0'])        // block in the head column (y=65..88 scanned)
    const sky = { default: 0, '5,65,0': 14 } // daylight 5 blocks east at head height
    expect(world(makeBot({ sky, solid })).surroundings).toBe('sheltered')
  })

  it('roof overhead and no daylight anywhere near → underground', () => {
    const solid = new Set(['0,67,0'])
    expect(world(makeBot({ sky: { default: 0 }, solid })).surroundings).toBe('underground')
  })
})
