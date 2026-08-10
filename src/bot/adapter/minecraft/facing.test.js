// src/bot/adapter/minecraft/facing.test.js
//
// Pins the yaw convention. This is the module every "behind you" / "over
// there" now resolves through, so a sign flip here silently sends the bot the
// wrong way with full confidence — which is the exact failure it was written
// to remove. The convention itself is asserted against the four places that
// already encoded it independently (gaze.js aimAt, survival.js, reflex.js and
// the povRenderer camera): yaw = atan2(-dx, -dz).

import { describe, it, expect } from 'vitest'
import { CARDINALS, cardinalFromYaw, cardinalIndexFromYaw, facingFrame, facingLine, yawToUnit } from './facing.js'

/** The inverse used throughout the adapter — the ground truth for these tests. */
const yawFor = (dx, dz) => Math.atan2(-dx, -dz)

describe('cardinalFromYaw', () => {
  it('maps each cardinal yaw to its axis and compass name', () => {
    expect(cardinalFromYaw(yawFor(0, -1))).toMatchObject({ axis: '-z', compass: 'north' })
    expect(cardinalFromYaw(yawFor(1, 0))).toMatchObject({ axis: '+x', compass: 'east' })
    expect(cardinalFromYaw(yawFor(0, 1))).toMatchObject({ axis: '+z', compass: 'south' })
    expect(cardinalFromYaw(yawFor(-1, 0))).toMatchObject({ axis: '-x', compass: 'west' })
  })

  it('yaw 0 looks down -z (the convention visualize.js and gaze.js both assume)', () => {
    const [dx, dz] = yawToUnit(0)
    expect(dx).toBeCloseTo(0)
    expect(dz).toBeCloseTo(-1)
    expect(cardinalFromYaw(0).axis).toBe('-z')
  })

  it('survives yaw wrapping past a full turn in either direction', () => {
    for (const turns of [-2, -1, 0, 1, 2, 3]) {
      expect(cardinalFromYaw(yawFor(1, 0) + turns * 2 * Math.PI).axis).toBe('+x')
    }
  })

  it('snaps a diagonal to the nearer cardinal', () => {
    // Just east of northeast → east; just north of it → north.
    expect(cardinalFromYaw(yawFor(0.9, -0.4)).axis).toBe('+x')
    expect(cardinalFromYaw(yawFor(0.4, -0.9)).axis).toBe('-z')
  })

  it('breaks an exact 45° tie clockwise', () => {
    // Dead northeast sits equidistant from north and east; documented to round
    // clockwise, i.e. to east.
    expect(cardinalFromYaw(yawFor(Math.SQRT1_2, -Math.SQRT1_2)).axis).toBe('+x')
  })

  it('falls back to a real cardinal when yaw is missing or garbage', () => {
    for (const bad of [undefined, null, NaN, Infinity, 'north']) {
      expect(CARDINALS).toContain(cardinalFromYaw(bad))
    }
  })
})

describe('facingFrame', () => {
  it('turns right by advancing one cardinal clockwise', () => {
    // Facing north: right is east, back is south, left is west.
    const f = facingFrame(yawFor(0, -1))
    expect(f.forward.axis).toBe('-z')
    expect(f.right.axis).toBe('+x')
    expect(f.backward.axis).toBe('+z')
    expect(f.left.axis).toBe('-x')
  })

  it('holds the relative ordering from every starting cardinal', () => {
    for (let i = 0; i < CARDINALS.length; i++) {
      const c = CARDINALS[i]
      const f = facingFrame(yawFor(c.dx, c.dz))
      expect(f.forward).toBe(CARDINALS[i])
      expect(f.right).toBe(CARDINALS[(i + 1) % 4])
      expect(f.backward).toBe(CARDINALS[(i + 2) % 4])
      expect(f.left).toBe(CARDINALS[(i + 3) % 4])
    }
  })

  it('backward is always the exact negation of forward', () => {
    for (const c of CARDINALS) {
      const f = facingFrame(yawFor(c.dx, c.dz))
      // `+ 0` normalizes -0, which toBe() distinguishes from 0 via Object.is.
      expect(f.backward.dx + 0).toBe(-f.forward.dx + 0)
      expect(f.backward.dz + 0).toBe(-f.forward.dz + 0)
    }
  })
})

describe('facingLine', () => {
  it('spells out all four relative directions as signed axes', () => {
    // The player says "build a bridge behind you"; the model reads "back +z"
    // straight off this line rather than deriving it.
    expect(facingLine(facingFrame(yawFor(0, -1))))
      .toBe('north. forward -z, back +z, left -x, right +x')
    expect(facingLine(facingFrame(yawFor(1, 0))))
      .toBe('east. forward +x, back -x, left -z, right +z')
  })

  it('degrades to a word rather than throwing on a missing frame', () => {
    expect(facingLine(null)).toBe('unknown')
    expect(facingLine({})).toBe('unknown')
  })
})
