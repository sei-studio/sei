// src/observers/blocks.js — pure function of bot state
import mcDataLib from 'minecraft-data'
import { Vec3 } from 'vec3'
import { getHealedPos } from './posHealer.js'

const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const WOODS = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']
const ORES = ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore']

// Terrain block names added per D-1sk-05 — surfaces "what am I standing on"
// info to the personality/movement LLMs (sand, dirt, grass_block, …).
// Exported for snapshot tier-aware ranking (260505-twx) — non-terrain
// "interesting" blocks (logs, ores, chests, …) sort BEFORE terrain
// regardless of distance so 8 nearby grass_blocks don't crowd out a
// single oak_log 14m away.
export const TERRAIN = [
  'sand', 'red_sand', 'sandstone', 'red_sandstone',
  'gravel', 'clay', 'dirt', 'coarse_dirt',
  'grass_block', 'podzol', 'mycelium',
  'snow', 'snow_block', 'ice', 'packed_ice', 'blue_ice',
  'obsidian', 'glass', 'terracotta',
  'cobblestone', 'mossy_cobblestone', 'stone',
]

/** Default set of "interesting" block names for snapshot rendering. */
export const INTERESTING_BLOCK_NAMES = new Set([
  ...WOODS.map(w => `${w}_log`),
  ...WOODS.map(w => `${w}_planks`),
  ...ORES,
  ...ORES.map(o => `deepslate_${o}`),
  ...COLORS.map(c => `${c}_bed`),
  ...TERRAIN,
  'chest', 'ender_chest', 'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil',
  'water', 'lava',
])

// Names that count as "see-through" for the exposure predicate. Water and lava
// are treated as see-through because a player on shore can plainly see blocks
// bordering water/lava — filtering them out would hide the entire shoreline.
// (D-1sk-01)
const SEE_THROUGH_NAMES = new Set(['air', 'cave_air', 'void_air', 'water', 'lava'])

const NEIGHBOR_OFFSETS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
]

/**
 * A block is "exposed" iff at least one of its 6 axis-neighbors is see-through.
 * Conservative on unloaded chunks (treats null neighbor as opaque) so we don't
 * surface buried ores at chunk boundaries. (D-1sk-01)
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{x:number,y:number,z:number}} pos
 * @returns {boolean}
 */
export function isExposed(bot, pos) {
  for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
    const nb = bot.blockAt?.(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz))
    if (!nb) continue // unloaded chunk: don't claim exposed (conservative)
    if (nb.boundingBox === 'empty') return true
    if (SEE_THROUGH_NAMES.has(nb.name)) return true
  }
  return false
}

/**
 * Find nearby "interesting" blocks, closest-first, capped at `count`.
 * Filters out blocks fully encased in opaque material (no xray). If the
 * exposure-filtered result is sparse and the caller did not override the
 * radius, retries once at 2× radius before giving up. (D-1sk-04, D-1sk-08)
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ radius?:number, count?:number, interesting?:Set<string>|((name:string)=>boolean) }} [opts]
 * @returns {{ positions:Array<{x:number,y:number,z:number,name:string}>, more:number }}
 */
export function nearbyBlocks(bot, opts = {}) {
  const radiusOverridden = opts.radius != null
  const radius = opts.radius ?? 16
  const count = opts.count ?? 8
  const interesting = opts.interesting ?? INTERESTING_BLOCK_NAMES

  const isInteresting = typeof interesting === 'function'
    ? interesting
    : (name) => interesting.has(name)

  let mcData
  try { mcData = mcDataLib(bot.version) } catch { mcData = null }

  // Build matching id list (or fall back to function form).
  let matching
  if (mcData?.blocksByName) {
    const ids = []
    for (const name of (typeof interesting === 'function' ? [] : interesting)) {
      const b = mcData.blocksByName[name]
      if (b) ids.push(b.id)
    }
    matching = ids.length ? ids : ((b) => isInteresting(b.name))
  } else {
    matching = (b) => isInteresting(b.name)
  }

  // Use healed position as scan origin so a transient NaN in bot.entity.position
  // (knockback poisoning, see posHealer.js) doesn't blank out the snapshot.
  const origin = getHealedPos(bot) ?? bot.entity?.position
  const point = origin && Number.isFinite(origin.x) ? origin : undefined

  // Single attempt: render slice (count) + probe (count + 32 for "+K more"),
  // both filtered through isExposed so the LLM never sees buried blocks.
  const scan = (r) => {
    const found = bot.findBlocks({ matching, maxDistance: r, count, point })
    const probe = bot.findBlocks({ matching, maxDistance: r, count: count + 32, point })
    const exposedFound = found.filter(p => isExposed(bot, p))
    const exposedProbe = probe.filter(p => isExposed(bot, p))
    const more = Math.max(0, exposedProbe.length - exposedFound.length)
    return { exposedFound, more }
  }

  let { exposedFound, more } = scan(radius)

  // Sparse-expand fallback — one retry only at 2× radius if initial scan was
  // thin and the caller used the default radius. (D-1sk-04)
  if (
    !radiusOverridden &&
    exposedFound.length < Math.min(count, 3)
  ) {
    const retry = scan(radius * 2)
    if (retry.exposedFound.length > exposedFound.length) {
      exposedFound = retry.exposedFound
      more = retry.more
    }
  }

  const positions = exposedFound.map(p => {
    const blk = bot.blockAt(p)
    return {
      x: p.x, y: p.y, z: p.z,
      name: blk?.name ?? 'unknown',
      _d: origin && typeof p.distanceTo === 'function' ? p.distanceTo(origin) : 0,
    }
  })
  // bot.findBlocks already returns closest-first, but be defensive.
  positions.sort((a, b) => a._d - b._d)
  // Tier-aware secondary sort (260505-twx): non-terrain "interesting"
  // blocks (logs, ores, chests, crafting_table, beds, …) come BEFORE
  // terrain (grass_block, dirt, sand, stone, …) regardless of distance.
  // Within each tier, the prior distance-sort order is preserved
  // (Array.prototype.sort is stable in V8). Without this, 8 nearby
  // grass_blocks crowd out the oak_log 14 blocks away.
  const TERRAIN_SET = new Set(TERRAIN)
  positions.sort((a, b) => {
    const aTer = TERRAIN_SET.has(a.name) ? 1 : 0
    const bTer = TERRAIN_SET.has(b.name) ? 1 : 0
    if (aTer !== bTer) return aTer - bTer  // 0 (non-terrain) before 1 (terrain)
    return 0
  })
  for (const p of positions) delete p._d
  return { positions, more }
}

// Skip air variants when grouping the around-feet cube. Water and lava ARE
// counted (they're interesting terrain context — "I'm in water").
const AROUND_FEET_SKIP = new Set(['air', 'cave_air', 'void_air'])

/**
 * Summarize every non-air block in a 5×4×5 cube centered on the bot's feet,
 * grouped by name with counts and sorted by count desc, then name asc.
 * Cap at 8 distinct names; surplus is reported via `more`.
 *
 * Cube spans dx=-2..+2, dy=-1..+2, dz=-2..+2 around floor(bot pos) — covers
 * ground (y-1, y0), torso (y+1), and head (y+2). 100 blockAt calls per call.
 * (D-1sk-02, D-1sk-03)
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {{ groups: Array<{name:string,count:number}>, total:number, more:number }}
 */
export function aroundFeet(bot) {
  const origin = getHealedPos(bot) ?? bot.entity?.position
  if (!origin || !Number.isFinite(origin.x)) return { groups: [], total: 0, more: 0 }

  const cx = Math.floor(origin.x)
  const cy = Math.floor(origin.y)
  const cz = Math.floor(origin.z)

  const counts = new Map()
  let total = 0
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const blk = bot.blockAt?.(new Vec3(cx + dx, cy + dy, cz + dz))
        if (!blk) continue
        if (AROUND_FEET_SKIP.has(blk.name)) continue
        counts.set(blk.name, (counts.get(blk.name) ?? 0) + 1)
        total++
      }
    }
  }

  const allGroups = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const cap = 8
  const groups = allGroups.slice(0, cap)
  const more = Math.max(0, allGroups.length - cap)
  return { groups, total, more }
}
