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

const SEE_THROUGH_NAMES = new Set(['air', 'cave_air', 'void_air'])

/**
 * Aggregate every non-air, exposed block within `radius` by block name.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ radius?:number, maxNames?:number, scanCap?:number }} [opts]
 *   - radius: search radius in blocks (default 16)
 *   - maxNames: max unique block names to surface, ranked by nearest-first
 *               (default 24)
 *   - scanCap: max raw block hits findBlocks returns before aggregation
 *              (default 4096). Hit cap is a defense-in-depth bound; normal
 *              16-radius scans return well under this.
 * @returns {{ groups: Array<{name:string, total:number, nearest:{x:number,y:number,z:number}, distance:number}>, more:number }}
 */
export function surveyBlocks(bot, opts = {}) {
  const radius = opts.radius ?? 16
  const maxNames = opts.maxNames ?? 24
  const scanCap = opts.scanCap ?? 4096

  const origin = getHealedPos(bot) ?? bot.entity?.position
  if (!origin || !Number.isFinite(origin.x)) return { groups: [], more: 0 }

  // Function-form matcher: we want "anything not air-ish". A precomputed
  // ID array would cover thousands of IDs — the function form is cheaper
  // here and identical to what findBlocks does under the hood.
  const matching = (b) => b && b.name && !SEE_THROUGH_NAMES.has(b.name)

  const positions = bot.findBlocks({
    matching,
    maxDistance: radius,
    count: scanCap,
    point: origin,
  })
  if (!positions || !positions.length) return { groups: [], more: 0 }

  /** @type {Map<string, { total:number, nearestPos:{x:number,y:number,z:number}, nearestDist:number }>} */
  const byName = new Map()

  for (const p of positions) {
    if (!isExposed(bot, p)) continue
    const blk = bot.blockAt(p)
    if (!blk || SEE_THROUGH_NAMES.has(blk.name)) continue
    const dx = p.x - origin.x, dy = p.y - origin.y, dz = p.z - origin.z
    const d = Math.hypot(dx, dy, dz)
    const cur = byName.get(blk.name)
    if (!cur) {
      byName.set(blk.name, {
        total: 1,
        nearestPos: { x: p.x, y: p.y, z: p.z },
        nearestDist: d,
      })
    } else {
      cur.total++
      if (d < cur.nearestDist) {
        cur.nearestDist = d
        cur.nearestPos = { x: p.x, y: p.y, z: p.z }
      }
    }
  }

  const groups = []
  for (const [name, v] of byName.entries()) {
    groups.push({ name, total: v.total, nearest: v.nearestPos, distance: v.nearestDist })
  }
  groups.sort((a, b) => a.distance - b.distance)
  const head = groups.slice(0, maxNames)
  const more = Math.max(0, groups.length - maxNames)
  return { groups: head, more }
}
