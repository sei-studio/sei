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
 * Inside / outside detection. Returns one of:
 *   - 'outside'     — open sky overhead (or a clear vertical column to it)
 *   - 'sheltered'   — solid cover overhead BUT open sky a short hop away
 *                     (overhang, cave mouth, tree edge, doorway) — walk out
 *   - 'underground' — sealed above AND no open sky nearby — genuinely buried
 *   - 'unknown'     — world data unavailable
 *
 * 260617: the old version returned 'underground' on `skyLight === 0` alone.
 * skyLight reads 0 on freshly-loaded chunks (the first seconds after join) and
 * at the foot of a cliff even under open sky — so a mountainside spawn was
 * labelled "underground" and the bot tried to dig straight UP out of open
 * terrain instead of walking downhill. We now CONFIRM cover with a vertical
 * raycast (a clear column = outside regardless of stored skyLight) and, when
 * there IS a roof, probe a horizontal ring for a nearby way out so "rock above
 * me" is not read as "I must tunnel up".
 */
function describeSurroundings(bot, p) {
  const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z)
  const headY = py + 1
  const skyAt = (x, z) => {
    try { const s = bot.world?.getSkyLight?.({ x, y: headY, z }); return typeof s === 'number' ? s : null }
    catch { return null }
  }

  // Clear vertical shot to the sky → outside (cheap common case).
  const sky = skyAt(px, pz)
  if (sky != null && sky >= 14) return 'outside'

  // Low/zero skyLight is NOT proof of burial (fresh chunks / cliff-foot
  // under-report it). Confirm with a raycast: a clear column above = outside.
  let covered = false
  try {
    for (let dy = 2; dy <= 24; dy++) {
      const blk = bot.blockAt?.({ x: px, y: py + dy, z: pz })
      if (blk && blk.boundingBox === 'block') { covered = true; break }
    }
  } catch { return 'unknown' }
  if (!covered) return 'outside'

  // Roofed. With no light data we can only say it is covered; otherwise probe a
  // ring for daylight — an overhang / cave mouth with a way out ('sheltered')
  // vs a sealed or deep space ('underground').
  if (sky == null) return 'sheltered'
  for (const [dx, dz] of [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, -4], [4, -4], [-4, 4]]) {
    const s = skyAt(px + dx, pz + dz)
    if (s != null && s >= 12) return 'sheltered'
  }
  return 'underground'
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
