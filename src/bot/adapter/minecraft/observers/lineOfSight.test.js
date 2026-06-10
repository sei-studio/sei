// src/bot/adapter/minecraft/observers/lineOfSight.test.js
//
// Phase 15 — Plan 15-03 Task 2 (TDD). Behavior gate for the custom
// line-of-sight helper (VIS-05). The whole point of a CUSTOM helper (vs raw
// bot.world.raycast) is that fluids and intervening entity bounding boxes are
// treated as occluders — raycast misses both (RESEARCH Pitfall 3). These tests
// pin every behavior bullet from 15-03-PLAN.md.

import { describe, it, expect } from 'vitest'
import { Vec3 } from 'vec3'
import { hasClearLineOfSight } from './lineOfSight.js'

/**
 * Build a stub mineflayer bot.
 *
 * @param {object} o
 * @param {{x:number,y:number,z:number}} o.eye   bot eye position (pre-offset)
 * @param {number} [o.eyeHeight]
 * @param {(pos: Vec3) => object|null} o.blockAt  block resolver keyed by floored coords
 * @param {Record<string|number, object>} [o.entities]  other-entity table
 */
function makeBot({ eye, eyeHeight = 1.6, blockAt, entities = {} }) {
  const self = { position: new Vec3(eye.x, eye.y, eye.z), eyeHeight }
  return {
    entity: self,
    blockAt: (v) => blockAt(v),
    entities: { self, ...entities },
  }
}

/** A block that fully fills its cell (1×1×1 collision shape). */
function solidBlock(name = 'stone') {
  return { name, shapes: [[0, 0, 0, 1, 1, 1]] }
}

/** Air: no occluding shapes. */
function airBlock() {
  return { name: 'air', shapes: [] }
}

/** A target entity at the given position. */
function target(pos, { height = 1.8, width = 0.6 } = {}) {
  return { position: new Vec3(pos.x, pos.y, pos.z), height, width }
}

describe('hasClearLineOfSight (VIS-05)', () => {
  it('returns false when the target is beyond the 16-block range gate, even through clear air', () => {
    const bot = makeBot({ eye: { x: 0, y: 64, z: 0 }, blockAt: () => airBlock() })
    // 20 blocks away on the X axis — past the 16-block gate.
    const tgt = target({ x: 20, y: 64, z: 0 })
    expect(hasClearLineOfSight(bot, tgt)).toBe(false)
  })

  it('returns true for a clear straight line of air within 16 blocks', () => {
    const bot = makeBot({ eye: { x: 0, y: 64, z: 0 }, blockAt: () => airBlock() })
    const tgt = target({ x: 6, y: 64, z: 0 })
    expect(hasClearLineOfSight(bot, tgt)).toBe(true)
  })

  it('returns false when a fluid block lies on the ray (fluids are occluders — raycast would MISS this)', () => {
    const bot = makeBot({
      eye: { x: 0, y: 64, z: 0 },
      blockAt: (v) => {
        // Put water at x=3 (on the ray to a target at x=6). Fluids have EMPTY
        // collision shapes, so a shapes-only test would pass through — the
        // helper must treat the fluid NAME as an occluder.
        if (Math.floor(v.x) === 3) return { name: 'water', shapes: [] }
        return airBlock()
      },
    })
    const tgt = target({ x: 6, y: 64, z: 0 })
    expect(hasClearLineOfSight(bot, tgt)).toBe(false)
  })

  it('treats flowing_water / lava names as occluders too', () => {
    for (const fluid of ['flowing_water', 'lava', 'flowing_lava']) {
      const bot = makeBot({
        eye: { x: 0, y: 64, z: 0 },
        blockAt: (v) => (Math.floor(v.x) === 3 ? { name: fluid, shapes: [] } : airBlock()),
      })
      const tgt = target({ x: 6, y: 64, z: 0 })
      expect(hasClearLineOfSight(bot, tgt), `${fluid} should occlude`).toBe(false)
    }
  })

  it('returns false when a solid block (non-empty shapes) occludes the ray', () => {
    const bot = makeBot({
      eye: { x: 0, y: 64, z: 0 },
      blockAt: (v) => (Math.floor(v.x) === 3 ? solidBlock() : airBlock()),
    })
    const tgt = target({ x: 6, y: 64, z: 0 })
    expect(hasClearLineOfSight(bot, tgt)).toBe(false)
  })

  it('returns false when an intervening OTHER entity AABB crosses the segment', () => {
    // A horse sitting at x=3 between the bot (x=0) and target (x=6), centered on
    // the ray's y. Its bounding box must block sight.
    const blocker = {
      position: new Vec3(3, 64, 0),
      width: 1.4,
      height: 1.6,
    }
    const bot = makeBot({
      eye: { x: 0, y: 64, z: 0 },
      blockAt: () => airBlock(),
      entities: { 42: blocker },
    })
    const tgt = target({ x: 6, y: 64, z: 0 })
    expect(hasClearLineOfSight(bot, tgt)).toBe(false)
  })

  it('does NOT treat the bot itself or the target entity as occluders', () => {
    // The bot's own entity and the target are in bot.entities; neither should
    // block the ray. (clear air otherwise → LOS true)
    const tgt = target({ x: 6, y: 64, z: 0 })
    const bot = makeBot({
      eye: { x: 0, y: 64, z: 0 },
      blockAt: () => airBlock(),
      entities: { 99: tgt },
    })
    expect(hasClearLineOfSight(bot, tgt)).toBe(true)
  })

  it('returns false when a block on the ray is in an unloaded chunk (blockAt → null)', () => {
    const bot = makeBot({
      eye: { x: 0, y: 64, z: 0 },
      blockAt: (v) => (Math.floor(v.x) === 3 ? null : airBlock()),
    })
    const tgt = target({ x: 6, y: 64, z: 0 })
    expect(hasClearLineOfSight(bot, tgt)).toBe(false)
  })

  it('does not call bot.world.raycast (VIS-05 hard requirement)', () => {
    let raycastCalled = false
    const bot = makeBot({ eye: { x: 0, y: 64, z: 0 }, blockAt: () => airBlock() })
    bot.world = {
      raycast: () => {
        raycastCalled = true
        return null
      },
    }
    const tgt = target({ x: 6, y: 64, z: 0 })
    hasClearLineOfSight(bot, tgt)
    expect(raycastCalled).toBe(false)
  })
})
