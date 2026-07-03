// src/bot/adapter/minecraft/observers/ownerDistance.test.js
//
// 260703 — owner-whereabouts NaN guard. Right after combat/teleport/respawn a
// player or the bot's own entity can be partially loaded with NaN position
// components; the old `Math.round(distanceTo(...))` produced NaN, and since
// `NaN != null` the snapshot printed "owner Ouen: @-46,71,-35 (NaN blocks away)".
// ownerDistanceBlocks gates every coord with Number.isFinite and returns null
// (→ the parenthetical is omitted) instead of emitting garbage.

import { describe, it, expect } from 'vitest'
import { ownerDistanceBlocks } from './snapshot.js'

describe('ownerDistanceBlocks — NaN guard (260703)', () => {
  it('rounds a finite straight-line distance (3-4-5 triangle)', () => {
    expect(ownerDistanceBlocks({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 })).toBe(5)
  })

  it('THE BUG: returns null when the self position has a NaN component', () => {
    expect(ownerDistanceBlocks({ x: -46, y: 71, z: -35 }, { x: NaN, y: 71, z: -35 })).toBeNull()
  })

  it('returns null when the owner position has a NaN component', () => {
    expect(ownerDistanceBlocks({ x: NaN, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeNull()
  })

  it('returns null for a non-finite (Infinity) coord', () => {
    expect(ownerDistanceBlocks({ x: Infinity, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeNull()
  })

  it('returns null when either position is missing', () => {
    expect(ownerDistanceBlocks(null, { x: 0, y: 0, z: 0 })).toBeNull()
    expect(ownerDistanceBlocks({ x: 0, y: 0, z: 0 }, undefined)).toBeNull()
  })

  it('never returns NaN', () => {
    for (const d of [
      ownerDistanceBlocks({ x: NaN, y: NaN, z: NaN }, { x: NaN, y: NaN, z: NaN }),
      ownerDistanceBlocks({ x: 1, y: 2, z: 3 }, { x: NaN, y: 2, z: 3 }),
    ]) {
      expect(Number.isNaN(d)).toBe(false)
      expect(d).toBeNull()
    }
  })
})
