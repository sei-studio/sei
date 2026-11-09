// src/bot/adapter/minecraft/behaviors/placeSpots.js
//
// 261108 (quality pass 46). Where "put the table down" can go. The old search
// in place.js looked at the four cells touching her feet (then her head), took
// the FIRST one that was air with any non-air neighbour, and gave up after one
// try. In the pass 45 free play that failed about a third of all table and
// furnace placements, in open terrain:
//
//   - A grass tuft, tall grass or water counted as "occupied", so in a meadow
//     or a river no feet cell was open. The head ring then picked the tuft or
//     the water itself as the face to place against. The server replaces a
//     clicked tuft or water cell instead of placing beside it, so the table
//     went INTO the tuft while mineflayer waited for the cell above: 4s
//     timeout, "no open spot in reach", the table gone from her bag.
//   - The cell beside her feet often overlaps her own hitbox (she rarely
//     stands at the centre of her block). The server refuses a block that
//     would sit inside a body: 4s timeout, "no open spot".
//   - A 1x1 pit or a spot ringed by solid blocks had no candidate at all.
//
// This module ranks every cell within reach that a block can really go in:
// empty or holding a plant the block replaces, a full solid floor under it to
// click (the block rests on the ground, as when a player puts a table down),
// no body in it, in reach and in sight of her eyes. Water cells come last.
// place.js tries the best few, and when there is none it steps to the
// nearest open standing spot and tries again.
import { Vec3 } from 'vec3'

const AIR = new Set(['air', 'cave_air', 'void_air'])
// Plants and thin covers a placed block replaces, as it does for a player.
// Clicking one of these places INTO it, so they are never a face to click.
export const PLACE_REPLACEABLE = new Set([
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'vine', 'glow_lichen',
  'short_dry_grass', 'tall_dry_grass', 'leaf_litter', 'crimson_roots', 'warped_roots', 'nether_sprouts',
  'hanging_roots', 'light', 'structure_void',
])
// Water and the plants that only live in it: a block can replace them, but a
// table in the river is a last resort.
const WET = new Set(['water', 'seagrass', 'tall_seagrass', 'bubble_column'])
// Blocks that open a screen or toggle when clicked: clicking one to place
// against it uses it instead (mineflayer does not sneak).
const INTERACTIVE = /(^|_)(crafting_table|furnace|smoker|chest|barrel|shulker_box|anvil|loom|cartography_table|smithing_table|fletching_table|grindstone|stonecutter|bed|door|trapdoor|fence_gate|button|lever|note_block|jukebox|dispenser|dropper|hopper|beacon|brewing_stand|crafter|lectern|bell|sign|command_block|repeater|comparator|respawn_anchor|enchanting_table|cake|composter|beehive|bee_nest|chiseled_bookshelf|decorated_pot|vault|trial_spawner)$/

export const PLACE_REACH = 4.5 // eyes to the clicked face (the 1.21 server allows 4.5 + 1)
const EYE = 1.62
const HALF = 0.3 // player hitbox half-width
const HEIGHT = 1.8

const blockAt = (bot, x, y, z) => {
  try { return bot.blockAt(new Vec3(x, y, z)) } catch { return null }
}

/** 'air' | 'plant' | 'wet' when a placed block can go in this cell, else null. */
export function openKind(blk) {
  if (!blk) return null
  if (AIR.has(blk.name)) return 'air'
  if (PLACE_REPLACEABLE.has(blk.name)) return 'plant'
  if (WET.has(blk.name)) return 'wet'
  return null
}

/** A full solid block that can be clicked to put something on top of it. */
export function isPlaceFloor(blk) {
  if (!blk || AIR.has(blk.name) || PLACE_REPLACEABLE.has(blk.name) || WET.has(blk.name)) return false
  if (blk.boundingBox !== 'block') return false
  return !INTERACTIVE.test(blk.name)
}

function fullBlock(blk) {
  return !!blk && blk.boundingBox === 'block' && !AIR.has(blk.name)
}

/**
 * 261019 (quality pass 19), moved here from build.js 261108. Who stands in a
 * cell: "you" for the bot itself, a player's name, or a mob's name; null when
 * the cell is clear. Item drops, arrows and other non-living entities do not
 * block a place. `self` is where to put her own body (default: where she is;
 * false leaves her out).
 */
export function bodyInCell(bot, c, self = null) {
  const hits = (p, w, h) => {
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return false
    const hw = w / 2
    return p.x + hw > c.x && p.x - hw < c.x + 1 &&
      p.z + hw > c.z && p.z - hw < c.z + 1 &&
      p.y + h > c.y && p.y < c.y + 1
  }
  if (self !== false && hits(self ?? bot.entity?.position, HALF * 2, HEIGHT)) return 'you'
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === bot.entity) continue
    const living = e.type === 'player' || e.type === 'mob' || e.type === 'hostile' || e.type === 'animal' || e.kind === 'Hostile mobs' || !!e.username
    if (!living) continue
    const w = Number.isFinite(e.width) && e.width > 0 ? e.width : 0.6
    const h = Number.isFinite(e.height) && e.height > 0 ? e.height : 1.8
    if (hits(e.position, w, h)) return e.username ?? e.name ?? 'a mob'
  }
  return null
}

// Nothing solid between her eyes and the face she clicks. The server does not
// check this, but placing through a wall looks like cheating, and a spot
// behind a wall is not "beside her".
function inSight(bot, eye, target, cell) {
  const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const steps = Math.ceil(len / 0.2)
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const x = Math.floor(eye.x + dx * t), y = Math.floor(eye.y + dy * t), z = Math.floor(eye.z + dz * t)
    if (x === cell.x && z === cell.z && (y === cell.y || y === cell.y - 1)) continue
    if (fullBlock(blockAt(bot, x, y, z))) return false
  }
  return true
}

/**
 * The spot check for one cell, from `origin` (her feet, default where she
 * is). Returns { cell, refBlk, face, kind, cost } or null.
 */
export function checkPlaceCell(bot, cell, origin = null) {
  const o = origin ?? bot.entity?.position
  if (!o || ![o.x, o.y, o.z].every(Number.isFinite)) return null
  const kind = openKind(blockAt(bot, cell.x, cell.y, cell.z))
  if (!kind) return null
  const refBlk = blockAt(bot, cell.x, cell.y - 1, cell.z)
  if (!isPlaceFloor(refBlk)) return null
  const eye = { x: o.x, y: o.y + EYE, z: o.z }
  const target = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }
  const reach = Math.hypot(target.x - eye.x, target.y - eye.y, target.z - eye.z)
  if (reach > PLACE_REACH) return null
  if (bodyInCell(bot, cell, origin)) return null
  if (!inSight(bot, eye, target, cell)) return null
  const horiz = Math.hypot(target.x - o.x, target.z - o.z)
  const dy = cell.y - Math.floor(o.y + 0.01)
  // Beside her on her own level reads as "put it down here"; a step up or
  // down is fine; the rim of a pit she stands in is a last dry resort.
  const cost = Math.abs(horiz - 1.8) * 0.5 + Math.abs(dy) + (kind === 'plant' ? 0.2 : 0) + (kind === 'wet' ? 10 : 0)
  return { cell, refBlk, face: new Vec3(0, 1, 0), kind, cost }
}

/** Every cell around `origin` a block can be placed in, best first. */
export function findPlaceSpots(bot, { origin = null, radius = 3, dryOnly = false, limit = Infinity, unsorted = false } = {}) {
  const o = origin ?? bot.entity?.position
  if (!o || ![o.x, o.y, o.z].every(Number.isFinite)) return []
  const fx = Math.floor(o.x), fy = Math.floor(o.y + 0.01), fz = Math.floor(o.z)
  const out = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx === 0 && dz === 0) continue // her own column: under her feet or on her head
      for (const dy of [0, -1, 1, 2]) {
        const s = checkPlaceCell(bot, { x: fx + dx, y: fy + dy, z: fz + dz }, origin)
        if (!s || (dryOnly && s.kind === 'wet')) continue
        out.push(s)
        if (unsorted && out.length >= limit) return out
      }
    }
  }
  out.sort((a, b) => a.cost - b.cost)
  return out.slice(0, limit)
}

/** Room to stand at feet cell x,y,z: a solid floor and two dry open cells. */
function standable(bot, x, y, z) {
  if (!fullBlock(blockAt(bot, x, y - 1, z))) return false
  const k1 = openKind(blockAt(bot, x, y, z)), k2 = openKind(blockAt(bot, x, y + 1, z))
  return (k1 === 'air' || k1 === 'plant') && (k2 === 'air' || k2 === 'plant')
}

/**
 * The nearest spot she can stand on, other than where she is, with a dry
 * place spot beside it. Null when there is none within `radius`.
 */
export function findOpenStandSpot(bot, { radius = 8, minSpots = 2 } = {}) {
  const p = bot.entity?.position
  if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return null
  const fx = Math.floor(p.x), fy = Math.floor(p.y + 0.01), fz = Math.floor(p.z)
  const cands = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue // a step that changes nothing
      for (let dy = -3; dy <= 4; dy++) { // up to 4: from a river bed to its bank
        const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.75
        if (d > radius) continue
        cands.push({ x: fx + dx, y: fy + dy, z: fz + dz, d })
      }
    }
  }
  cands.sort((a, b) => a.d - b.d)
  for (const c of cands) {
    if (!standable(bot, c.x, c.y, c.z)) continue
    if (bodyInCell(bot, c, false)) continue // someone else stands there
    const origin = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }
    if (findPlaceSpots(bot, { origin, dryOnly: true, limit: minSpots, unsorted: true }).length >= minSpots) return { x: c.x, y: c.y, z: c.z }
  }
  return null
}
