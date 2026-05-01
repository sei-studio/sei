// src/observers/world.js — pure function of bot state
import { getHealedPos } from './posHealer.js'

/**
 * @param {import('mineflayer').Bot} bot
 * @returns {{ pos:{x:number,y:number,z:number}, biome:string, time:{isDay:boolean,timeOfDay:number} }}
 */
export function world(bot) {
  const p = getHealedPos(bot) ?? bot.entity?.position ?? { x: 0, y: 0, z: 0 }
  const pos = {
    x: Number.isFinite(p.x) ? Math.round(p.x) : 0,
    y: Number.isFinite(p.y) ? Math.round(p.y) : 0,
    z: Number.isFinite(p.z) ? Math.round(p.z) : 0,
  }
  let biome = 'unknown'
  try {
    const b = bot.world?.getBiome?.(p)
    if (b && typeof b === 'object' && 'name' in b) biome = b.name
    else if (typeof b === 'string') biome = b
  } catch {
    biome = 'unknown'
  }
  return {
    pos,
    biome,
    time: {
      isDay: Boolean(bot.time?.isDay),
      timeOfDay: bot.time?.timeOfDay ?? 0,
    },
  }
}
