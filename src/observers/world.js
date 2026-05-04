// src/observers/world.js — pure function of bot state
import { getHealedPos } from './posHealer.js'
import mcDataLib from 'minecraft-data'

function resolveBiomeName(bot, p) {
  try {
    const b = bot.world?.getBiome?.(p)
    if (b == null) return 'unknown'
    if (typeof b === 'object' && 'name' in b) return b.name
    if (typeof b === 'string') return b
    if (typeof b === 'number') {
      const md = mcDataLib(bot.version)
      const def = md?.biomes?.[b]
      if (def?.name) return def.name
    }
  } catch {}
  return 'unknown'
}

/**
 * Inside / outside detection. Cheap heuristic from light + sky exposure:
 *   - skyLight 15 with no cover above → outside
 *   - skyLight 0 → enclosed (cave or full roof)
 *   - skyLight in between → covered (under leaves / partial roof)
 * Falls back to a column raycast if light data is unavailable.
 */
function describeSurroundings(bot, p) {
  try {
    const headPos = { x: Math.floor(p.x), y: Math.floor(p.y) + 1, z: Math.floor(p.z) }
    const skyLight = bot.world?.getSkyLight?.(headPos)
    if (typeof skyLight === 'number') {
      if (skyLight >= 14) return 'outside'
      if (skyLight === 0) return 'underground'
      return 'enclosed'
    }
  } catch {}
  // Fallback: scan a small column above the bot for solid blocks.
  try {
    const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z)
    for (let dy = 2; dy <= 16; dy++) {
      const blk = bot.blockAt?.({ x: px, y: py + dy, z: pz })
      if (blk && blk.boundingBox === 'block') return 'enclosed'
    }
    return 'outside'
  } catch {}
  return 'unknown'
}

/**
 * @param {import('mineflayer').Bot} bot
 * @returns {{ pos:{x:number,y:number,z:number}, biome:string, surroundings:string, time:{isDay:boolean,timeOfDay:number} }}
 */
export function world(bot) {
  const p = getHealedPos(bot) ?? bot.entity?.position ?? { x: 0, y: 0, z: 0 }
  const pos = {
    x: Number.isFinite(p.x) ? Math.round(p.x) : 0,
    y: Number.isFinite(p.y) ? Math.round(p.y) : 0,
    z: Number.isFinite(p.z) ? Math.round(p.z) : 0,
  }
  return {
    pos,
    biome: resolveBiomeName(bot, p),
    surroundings: describeSurroundings(bot, p),
    time: {
      isDay: Boolean(bot.time?.isDay),
      timeOfDay: bot.time?.timeOfDay ?? 0,
    },
  }
}
