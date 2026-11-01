// src/bot/adapter/minecraft/observers/veins.js — pure observer.
//
// surveyBlocks: aggregate every non-air, exposed block within `radius` by block
// NAME. Returns one entry per unique block name with the total count seen and
// the position of the nearest member (used as the #N handle anchor in
// snapshot.js). Replaces the prior connected-component "vein" model — the
// observer no longer needs a hardcoded interesting-block allowlist, and the
// LLM no longer has to call `find` to learn the position of a nearby resource
// (e.g. cactus) that didn't happen to be on the list.
//
// Design rules:
// - All non-air block names are surfaced (cave_air / void_air also excluded).
// - Exposure-gated (no xray) — same predicate as blocks.js isExposed.
// - Cross-chunk neighbors read as null and count as non-exposed (conservative).
// - Pure data; snapshot.js owns string formatting and #N handle minting.
// - NaN-poisoning-safe origin via getHealedPos.

import { getHealedPos } from './posHealer.js'
import { isExposed } from './blocks.js'
import { Vec3 } from 'vec3'

const SEE_THROUGH_NAMES = new Set(['air', 'cave_air', 'void_air'])

// Names that count as "see-through" for the exposure test, the same set and
// rule as blocks.js isExposed (water and lava count, so a shoreline shows).
const EXPOSE_NAMES = new Set(['air', 'cave_air', 'void_air', 'water', 'lava'])

/**
 * Aggregate every non-air, exposed block within `radius` by block name.
 *
 * 261101 (pass 35): reads the loaded chunk columns directly instead of
 * bot.findBlocks. findBlocks walks chunk SECTIONS in an octahedron and stops
 * once it holds `count` hits, and with "anything not air" as the matcher the
 * buried stone under her feet fills that count from the first few sections. The
 * diagonal sections were never read and the nearest-4096 slice cut the rest to
 * about 12 blocks, all before the exposure filter. So a furnace 6 blocks away
 * (one section over on both x and z) or 13 blocks away on open ground was
 * missing from `nearby blocks` (smelt_iron benchmark: she said "i don't see a
 * furnace" standing next to it, then went off to build one). Here every
 * position in the radius is read once by state id into a small grid, and the
 * exposure test reads its neighbours from the same grid.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ radius?:number, maxNames?:number, scanCap?:number }} [opts]
 *   - radius: search radius in blocks (default 16)
 *   - maxNames: max unique block names to surface, ranked by nearest-first
 *               (default 24)
 *   - scanCap: only used by the findBlocks fallback (bots without chunk
 *              columns or a registry, i.e. test mocks)
 * @returns {{ groups: Array<{name:string, total:number, nearest:{x:number,y:number,z:number}, distance:number}>, more:number }}
 */
export function surveyBlocks(bot, opts = {}) {
  const radius = opts.radius ?? 16
  const maxNames = opts.maxNames ?? 24

  const origin = getHealedPos(bot) ?? bot.entity?.position
  if (!origin || !Number.isFinite(origin.x)) return { groups: [], more: 0 }

  const byName = scanColumns(bot, origin, radius) ?? scanFindBlocks(bot, origin, radius, opts.scanCap ?? 4096)
  if (!byName) return { groups: [], more: 0 }

  const groups = []
  for (const [name, v] of byName.entries()) {
    groups.push({ name, total: v.total, nearest: v.nearestPos, distance: v.nearestDist })
  }
  groups.sort((a, b) => a.distance - b.distance)
  const head = groups.slice(0, maxNames)
  const more = Math.max(0, groups.length - maxNames)
  return { groups: head, more }
}

function addHit(byName, name, x, y, z, d) {
  const cur = byName.get(name)
  if (!cur) {
    byName.set(name, { total: 1, nearestPos: { x, y, z }, nearestDist: d })
  } else {
    cur.total++
    if (d < cur.nearestDist) {
      cur.nearestDist = d
      cur.nearestPos = { x, y, z }
    }
  }
}

/**
 * Column scan. Returns null when the bot has no chunk columns or registry to
 * read (the caller then falls back to findBlocks).
 * Exported for tests.
 */
export function scanColumns(bot, origin, radius) {
  const getColumn = bot?.world?.getColumn
  const byState = bot?.registry?.blocksByStateId
  if (typeof getColumn !== 'function' || !byState) return null

  const ox = Math.floor(origin.x), oy = Math.floor(origin.y), oz = Math.floor(origin.z)
  const R = Math.max(0, Math.ceil(radius))
  const r2 = radius * radius
  const minY = Number.isFinite(bot.game?.minY) ? bot.game.minY : -64
  const maxY = minY + (Number.isFinite(bot.game?.height) ? bot.game.height : 384) // exclusive

  // Grid of state ids over the radius cube plus a 1-block margin so every
  // listed block's 6 neighbours are in it. -1 = unloaded (opaque, as in
  // isExposed), -2 = above the build limit (open air).
  const side = 2 * R + 3
  const half = R + 1
  const grid = new Int32Array(side * side * side)
  // A Vec3, not a plain object: the 1.8 chunk calls pos.modulus().
  const local = new Vec3(0, 0, 0)
  const cols = new Map()
  let anyColumn = false
  let anyRead = false
  for (let ix = 0; ix < side; ix++) {
    const wx = ox - half + ix
    for (let iz = 0; iz < side; iz++) {
      const wz = oz - half + iz
      const cx = wx >> 4, cz = wz >> 4
      const key = cx * 65536 + cz
      let col = cols.get(key)
      if (col === undefined) {
        try { col = getColumn.call(bot.world, cx, cz) ?? null } catch { col = null }
        cols.set(key, col)
      }
      const base = (ix * side + iz) * side
      if (!col) {
        grid.fill(-1, base, base + side)
        continue
      }
      anyColumn = true
      local.x = wx & 15
      local.z = wz & 15
      for (let iy = 0; iy < side; iy++) {
        const wy = oy - half + iy
        if (wy >= maxY) { grid[base + iy] = -2; continue }
        if (wy < minY) { grid[base + iy] = -1; continue }
        local.y = wy
        let id
        try { id = col.getBlockStateId(local) } catch { id = undefined }
        if (Number.isInteger(id)) { grid[base + iy] = id; anyRead = true } else grid[base + iy] = -1
      }
    }
  }
  if (!anyColumn) return new Map()
  // Columns loaded but no state id could be read (a chunk format this scan
  // does not understand): let the caller use the findBlocks path.
  if (!anyRead) return null

  // Per-state classification, cached for the scan.
  const info = new Map()
  const classify = (id) => {
    let c = info.get(id)
    if (c) return c
    const def = byState[id]
    const name = def?.name ?? null
    c = {
      name,
      listed: !!name && !SEE_THROUGH_NAMES.has(name),
      open: !def || def.boundingBox === 'empty' || EXPOSE_NAMES.has(name),
    }
    info.set(id, c)
    return c
  }
  const at = (ix, iy, iz) => grid[(ix * side + iz) * side + iy]
  const isOpen = (id) => id === -2 || (id >= 0 && classify(id).open)

  const byName = new Map()
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      const h2 = dx * dx + dz * dz
      if (h2 > r2) continue
      const ix = dx + half, iz = dz + half
      for (let dy = -R; dy <= R; dy++) {
        const d2 = h2 + dy * dy
        if (d2 > r2) continue
        const iy = dy + half
        const id = at(ix, iy, iz)
        if (id < 0) continue
        const c = classify(id)
        if (!c.listed) continue
        if (!(isOpen(at(ix + 1, iy, iz)) || isOpen(at(ix - 1, iy, iz)) ||
              isOpen(at(ix, iy + 1, iz)) || isOpen(at(ix, iy - 1, iz)) ||
              isOpen(at(ix, iy, iz + 1)) || isOpen(at(ix, iy, iz - 1)))) continue
        addHit(byName, c.name, ox + dx, oy + dy, oz + dz, Math.sqrt(d2))
      }
    }
  }
  return byName
}

// The pre-261101 path, kept for bots without chunk columns (test mocks).
function scanFindBlocks(bot, origin, radius, scanCap) {
  if (typeof bot?.findBlocks !== 'function') return null
  const matching = (b) => b && b.name && !SEE_THROUGH_NAMES.has(b.name)
  const positions = bot.findBlocks({ matching, maxDistance: radius, count: scanCap, point: origin })
  const byName = new Map()
  if (!positions || !positions.length) return byName
  for (const p of positions) {
    if (!isExposed(bot, p)) continue
    const blk = bot.blockAt(p)
    if (!blk || SEE_THROUGH_NAMES.has(blk.name)) continue
    addHit(byName, blk.name, p.x, p.y, p.z, Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z))
  }
  return byName
}
