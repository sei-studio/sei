// src/observers/blocks.js — pure function of bot state
import mcDataLib from 'minecraft-data'
import { getHealedPos } from './posHealer.js'

const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const WOODS = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']
const ORES = ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore']

/** Default set of "interesting" block names for snapshot rendering. */
export const INTERESTING_BLOCK_NAMES = new Set([
  ...WOODS.map(w => `${w}_log`),
  ...WOODS.map(w => `${w}_planks`),
  ...ORES,
  ...ORES.map(o => `deepslate_${o}`),
  ...COLORS.map(c => `${c}_bed`),
  'chest', 'ender_chest', 'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil',
  'water', 'lava',
])

/**
 * Find nearby "interesting" blocks, closest-first, capped at `count`.
 * @param {import('mineflayer').Bot} bot
 * @param {{ radius?:number, count?:number, interesting?:Set<string>|((name:string)=>boolean) }} [opts]
 * @returns {{ positions:Array<{x:number,y:number,z:number,name:string}>, more:number }}
 */
export function nearbyBlocks(bot, opts = {}) {
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

  // Render slice
  const found = bot.findBlocks({ matching, maxDistance: radius, count, point })
  // Higher-cap probe to compute "+K more"
  const probe = bot.findBlocks({ matching, maxDistance: radius, count: count + 32, point })
  const more = Math.max(0, probe.length - found.length)
  const positions = found.map(p => {
    const blk = bot.blockAt(p)
    return {
      x: p.x, y: p.y, z: p.z,
      name: blk?.name ?? 'unknown',
      _d: origin ? p.distanceTo(origin) : 0,
    }
  })
  // bot.findBlocks already returns closest-first, but be defensive.
  positions.sort((a, b) => a._d - b._d)
  for (const p of positions) delete p._d
  return { positions, more }
}
