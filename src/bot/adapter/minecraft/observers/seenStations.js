// 261101 (pass 35): furnaces she has seen this session, for when she is
// holding something to smelt and none is in `nearby blocks` any more.
//
// smelt_iron benchmark: her opening gather walked her ~20 blocks from the
// furnace, past the 16-block survey, before the player asked "can you smelt
// this raw iron". The furnace she had named two turns earlier was gone from
// the snapshot, so she said "no furnace in sight" and set off to build one.
// The line only shows while she holds raw metal or ore and no furnace is in
// view, so ordinary turns carry nothing extra.
import { Vec3 } from 'vec3'

const STATIONS = ['furnace', 'blast_furnace']
const MAX_PER_STATION = 6
const SEEN_TTL_MS = 20 * 60 * 1000
const SEEN_MAX_DIST = 96

/** Raw metal or ore: what a furnace or blast furnace is for. */
export function isSmeltableMetal(name) {
  return typeof name === 'string' && (/^raw_(iron|gold|copper)$/.test(name) || /_ore$/.test(name))
}

function dimOf(bot) {
  return String(bot?.game?.dimension ?? '')
}

/**
 * Remember the furnaces in this snapshot's survey groups (the nearest of each
 * name). `groups` = surveyBlocks(...).groups.
 */
export function noteSeenStations(bot, groups, now = Date.now()) {
  if (!bot || typeof bot !== 'object' || !Array.isArray(groups)) return
  for (const g of groups) {
    if (!STATIONS.includes(g?.name) || !g.nearest) continue
    const p = g.nearest
    if (![p.x, p.y, p.z].every(Number.isFinite)) continue
    const all = bot._seiSeenStations ?? (bot._seiSeenStations = {})
    const list = (all[g.name] ?? []).filter((q) => q.x !== p.x || q.y !== p.y || q.z !== p.z)
    list.push({ x: p.x, y: p.y, z: p.z, t: now, dim: dimOf(bot) })
    all[g.name] = list.slice(-MAX_PER_STATION)
  }
}

/**
 * `furnace you saw earlier: @x,y,z (N blocks away)` or null. Shown only when
 * she holds raw metal or ore, no furnace or blast furnace is in `groups`, and
 * one she saw in the last 20 minutes is in this dimension within 96 blocks.
 * A remembered one whose chunk is loaded and no longer holds it is dropped.
 */
export function seenStationLine(bot, groups, inv, now = Date.now()) {
  if (!bot?._seiSeenStations) return null
  if (!inv || !Object.keys(inv).some(isSmeltableMetal)) return null
  if ((groups ?? []).some((g) => STATIONS.includes(g?.name))) return null
  const here = bot.entity?.position
  if (!here || ![here.x, here.y, here.z].every(Number.isFinite)) return null
  const dim = dimOf(bot)
  let best = null
  for (const name of STATIONS) {
    const list = bot._seiSeenStations[name]
    if (!Array.isArray(list)) continue
    bot._seiSeenStations[name] = list.filter((p) => {
      if (now - p.t > SEEN_TTL_MS) return false
      if (p.dim !== dim) return true
      let blk = null
      try { blk = typeof bot.blockAt === 'function' ? bot.blockAt(new Vec3(p.x, p.y, p.z)) : null } catch { blk = null }
      if (blk && blk.name !== name) return false // chunk loaded, block gone
      const d = Math.hypot(p.x + 0.5 - here.x, p.y - here.y, p.z + 0.5 - here.z)
      if (d <= SEEN_MAX_DIST && (!best || d < best.d)) best = { name, p, d }
      return true
    })
  }
  if (!best) return null
  return `${best.name} you saw earlier: @${best.p.x},${best.p.y},${best.p.z} (${Math.round(best.d)} blocks away)`
}
