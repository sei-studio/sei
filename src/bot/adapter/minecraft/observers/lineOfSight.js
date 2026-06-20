// src/bot/adapter/minecraft/observers/lineOfSight.js
//
// Phase 15 — Custom line-of-sight helper (VIS-05). This is DELIBERATELY NOT
// bot.world.raycast. Raw raycast iterates `block.shapes` only, so it MISSES
// fluids (water/lava have EMPTY collision shapes — the ray sails through a lake
// as if it were air) and never tests entity bounding boxes at all (the owner
// could be hidden behind a horse and raycast wouldn't know). For the idle
// auto-render gate (VIS-04) that drives a bot to "look at the owner", treating
// water/lava as opaque and treating intervening mobs as occluders is the safe,
// product-correct reading (RESEARCH §"Custom LOS helper (VIS-05)" + Pitfall 3,
// assumption A6: fluids-as-occluders matches product intent).
//
// The idle gate FAILS CLOSED: any ambiguity (unloaded chunk → null block,
// target out of range) returns false so the bot does NOT auto-render when it
// might be looking at the owner through cover (player-monitor privacy leak,
// Pitfall 9 / T-15-03-02).
//
// Module shape + bot-access idioms mirror observers/targeting.js (Vec3 import,
// bot.blockAt(new Vec3(...)) ray-stepping, defensive null guards).

import { Vec3 } from 'vec3'

/**
 * Fluid block names treated as sight occluders. Vanilla fluids carry these
 * names; the `flowing_*` variants cover moving water/lava. Fluids have empty
 * collision shapes, so the shapes test below never catches them — this name
 * set is the reason a CUSTOM helper exists (VIS-05 / Pitfall 3).
 */
export const FLUID_NAMES = new Set(['water', 'lava', 'flowing_water', 'flowing_lava'])

/** Default range gate (VIS-04 idle auto-render). Callers may widen it via
 *  `opts.maxRange` — the snapshot entity filter uses the full entity radius. */
const MAX_RANGE_BLOCKS = 16

/**
 * Test whether a world point lies inside any of a block's collision shapes.
 *
 * `block.shapes` (prismarine-block) is an array of AABBs expressed RELATIVE to
 * the block's origin (the floored coordinate), each `[x0,y0,z0,x1,y1,z1]` in
 * the 0..1 unit cube (partial blocks like slabs/fences/panes use sub-unit
 * extents). We convert the absolute ray point to block-local space by
 * subtracting the floored origin, then test inclusion against each AABB.
 *
 * @param {{x:number,y:number,z:number}} p  absolute world point on the ray
 * @param {{shapes?: number[][]}} block
 * @returns {boolean}
 */
export function pointInAnyShape(p, block) {
  const shapes = block?.shapes
  if (!Array.isArray(shapes) || shapes.length === 0) return false
  const ox = Math.floor(p.x)
  const oy = Math.floor(p.y)
  const oz = Math.floor(p.z)
  const lx = p.x - ox
  const ly = p.y - oy
  const lz = p.z - oz
  for (const s of shapes) {
    if (!Array.isArray(s) || s.length < 6) continue
    const [x0, y0, z0, x1, y1, z1] = s
    if (lx >= x0 && lx <= x1 && ly >= y0 && ly <= y1 && lz >= z0 && lz <= z1) {
      return true
    }
  }
  return false
}

/**
 * Slab-method segment/AABB intersection. The entity's bounding box is centered
 * on its position in X/Z (`width` wide) and rises `height` from its feet.
 * Returns true when the segment from `from` to `to` crosses that box.
 *
 * @param {{x:number,y:number,z:number}} from  ray start (eye)
 * @param {{x:number,y:number,z:number}} to    ray end (target head)
 * @param {{position:{x:number,y:number,z:number}, width?:number, height?:number}} e
 * @returns {boolean}
 */
export function segmentIntersectsEntityAABB(from, to, e) {
  const pos = e?.position
  if (!pos) return false
  const w = (typeof e.width === 'number' ? e.width : 0.6) / 2
  const h = typeof e.height === 'number' ? e.height : 1.8
  const min = { x: pos.x - w, y: pos.y, z: pos.z - w }
  const max = { x: pos.x + w, y: pos.y + h, z: pos.z + w }

  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z

  let tmin = 0
  let tmax = 1
  const axes = [
    [from.x, dx, min.x, max.x],
    [from.y, dy, min.y, max.y],
    [from.z, dz, min.z, max.z],
  ]
  for (const [start, dir, lo, hi] of axes) {
    if (Math.abs(dir) < 1e-9) {
      // Ray parallel to this slab — no intersection if the origin is outside.
      if (start < lo || start > hi) return false
    } else {
      let t1 = (lo - start) / dir
      let t2 = (hi - start) / dir
      if (t1 > t2) {
        const tmp = t1
        t1 = t2
        t2 = tmp
      }
      if (t1 > tmin) tmin = t1
      if (t2 < tmax) tmax = t2
      if (tmin > tmax) return false
    }
  }
  return true
}

/**
 * Returns true iff the bot has an unobstructed line of sight to `targetEntity`
 * within the 16-block range gate, treating fluids and intervening entity
 * bounding boxes as occluders. Ray-marches blocks directly — see the
 * file header for why the built-in world-ray API is unsuitable (VIS-05).
 *
 * Fail-closed: out of range, an unloaded block (blockAt → null), a fluid on the
 * ray, a solid/partial block on the ray, or an intervening entity AABB all
 * return false. Only a fully clear ray within 16 blocks returns true.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-entity').Entity} targetEntity
 * @param {{ stepsPerBlock?: number, maxRange?: number }} [opts]
 * @returns {boolean}
 */
export function hasClearLineOfSight(bot, targetEntity, { stepsPerBlock = 4, maxRange = MAX_RANGE_BLOCKS } = {}) {
  const me = bot?.entity
  if (!me?.position || !targetEntity?.position) return false

  const eyeHeight = typeof me.eyeHeight === 'number' ? me.eyeHeight : 1.62
  const from = me.position.offset(0, eyeHeight, 0)
  // Aim near the target's head (0.85 of its height) rather than its feet, so a
  // half-height wall doesn't read as clear LOS to a standing player.
  const targetHeight = typeof targetEntity.height === 'number' ? targetEntity.height : 1.8
  const to = targetEntity.position.offset(0, targetHeight * 0.85, 0)

  const dir = to.minus(from)
  const dist = dir.norm()
  if (dist > maxRange) return false // range gate (default 16; snapshot widens it)
  if (dist === 0) return true

  const unit = dir.scaled(1 / dist)
  const steps = Math.max(1, Math.ceil(dist * stepsPerBlock))

  // (a)/(b): walk the ray block-by-block. A fluid NAME or a non-empty collision
  // shape the ray point falls inside occludes sight; a null block (unloaded
  // chunk) fails closed.
  for (let i = 1; i < steps; i++) {
    const p = from.plus(unit.scaled(dist * (i / steps)))
    const block = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
    if (!block) return false
    if (FLUID_NAMES.has(block.name)) return false
    if (Array.isArray(block.shapes) && block.shapes.length > 0 && pointInAnyShape(p, block)) {
      return false
    }
  }

  // (c): any OTHER entity whose AABB the ray crosses blocks sight. Skip the bot
  // itself, the target, and any null/positionless entry.
  const entities = bot.entities ?? {}
  for (const id in entities) {
    const e = entities[id]
    if (!e || e === me || e === targetEntity || !e.position) continue
    if (segmentIntersectsEntityAABB(from, to, e)) return false
  }

  return true
}
