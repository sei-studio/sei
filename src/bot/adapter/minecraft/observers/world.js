// src/observers/world.js — pure function of bot state
import { getHealedPos } from './posHealer.js'
import mcDataLib from 'minecraft-data'
import { Vec3 } from 'vec3'

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
 *   - 'outside'     — open sky overhead AND daylight around — genuinely in
 *                     the open (or a clear vertical column on unlit chunks)
 *   - 'pit'         — sky visible straight up but enclosed all around: the
 *                     bottom of a shaft, ravine, or walled hole
 *   - 'sheltered'   — solid cover overhead BUT open sky a short hop away
 *                     (overhang, cave mouth, tree edge, doorway) — walk out
 *   - 'underground' — sealed above AND no open sky nearby — genuinely buried
 *   - 'unknown'     — world data unavailable
 *
 * 260617: the old version returned 'underground' on `skyLight === 0` alone.
 * skyLight reads 0 on freshly-loaded chunks (the first seconds after join) and
 * at the foot of a cliff even under open sky — so a mountainside spawn was
 * labelled "underground" and the bot tried to dig straight UP out of open
 * terrain instead of walking downhill. We CONFIRM cover with a column scan (a
 * clear column = outside regardless of stored skyLight) and, when there IS a
 * roof, probe a horizontal ring for a nearby way out so "rock above me" is not
 * read as "I must tunnel up".
 *
 * 260721: two fixes. (1) The column scan passed a plain {x,y,z} to blockAt;
 * prismarine-world needs a Vec3 (`pos.floored()`), so every call threw and the
 * catch collapsed everything non-'outside' to 'unknown' — sheltered and
 * underground were unreachable in live play. (2) The scan capped at 24 blocks,
 * so a cavern taller than that read "no roof" and became 'outside'; it now
 * scans to the world build height (early-exits on the first solid block, so
 * the full-height walk only happens on genuinely open columns). Also added
 * 'pit': sky light directly overhead used to short-circuit to 'outside' even
 * at the bottom of a 1×1 shaft; now open sky must ALSO show up in the ring.
 */
const RING = [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, -4], [4, -4], [-4, 4]]

function describeSurroundings(bot, p) {
  const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z)
  const headY = py + 1
  const skyAt = (x, y, z) => {
    try { const s = bot.world?.getSkyLight?.(new Vec3(x, y, z)); return typeof s === 'number' ? s : null }
    catch { return null }
  }
  // Any daylight in a ring ~5 blocks out, at head height or 3 above (the +3
  // row catches sloped exits and keeps a 2-deep surface trench reading open)?
  const daylightNearby = () => {
    for (const dy of [0, 3]) {
      for (const [dx, dz] of RING) {
        const s = skyAt(px + dx, headY + dy, pz + dz)
        if (s != null && s >= 12) return true
      }
    }
    return false
  }

  // Sky straight overhead (cheap common case) — but that alone does not mean
  // open ground: a shaft or ravine bottom sees sky straight up too.
  const sky = skyAt(px, headY, pz)
  if (sky != null && sky >= 14) return daylightNearby() ? 'outside' : 'pit'

  // Low/zero skyLight is NOT proof of burial (fresh chunks / cliff-foot
  // under-report it). Confirm with a column scan up to the world build height:
  // a clear column above = outside.
  const worldTop = (Number.isFinite(bot.game?.minY) && Number.isFinite(bot.game?.height))
    ? bot.game.minY + bot.game.height
    : py + 320
  let covered = false
  try {
    for (let y = py + 2; y <= worldTop; y++) {
      const blk = bot.blockAt?.(new Vec3(px, y, pz))
      if (blk && blk.boundingBox === 'block') { covered = true; break }
    }
  } catch { return 'unknown' }
  if (!covered) return 'outside'

  // Roofed. With no light data we can only say it is covered; otherwise probe
  // the ring for daylight — an overhang / cave mouth with a way out
  // ('sheltered') vs a sealed or deep space ('underground').
  if (sky == null) return 'sheltered'
  return daylightNearby() ? 'sheltered' : 'underground'
}

/**
 * @param {import('mineflayer').Bot} bot
 * @returns {{ pos:{x:number,y:number,z:number}, biome:string, surroundings:string, light:{sky:number|null,block:number|null}, time:{isDay:boolean,timeOfDay:number} }}
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
    light: lightAtHead(bot, pos),
    time: {
      isDay: Boolean(bot.time?.isDay),
      timeOfDay: bot.time?.timeOfDay ?? 0,
    },
  }
}

/**
 * Light levels at the bot's head, straight from chunk data. `sky` is exposure
 * to the sky (15 = open air; it does NOT drop at night), `block` is torches /
 * lava / glowstone. Either may be null when light data is unavailable.
 * @returns {{ sky: number|null, block: number|null }}
 */
function lightAtHead(bot, pos) {
  const head = new Vec3(pos.x, pos.y + 1, pos.z)
  const read = (fn) => {
    try { const v = fn?.(head); return typeof v === 'number' ? v : null }
    catch { return null }
  }
  return {
    sky: read(bot.world?.getSkyLight?.bind(bot.world)),
    block: read(bot.world?.getBlockLight?.bind(bot.world)),
  }
}
