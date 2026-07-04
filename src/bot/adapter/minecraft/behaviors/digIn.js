// src/adapter/minecraft/behaviors/digIn.js — fast PANIC shelter (survival).
//
// A much cheaper alternative to shelterAction (which builds a whole 3x3+ hut):
// digIn holes the bot in RIGHT NOW so it survives the next few seconds of a bad
// night or a mob swarm. Two variants, chosen automatically:
//
//   A. HOLE (default): dig 2 blocks straight down, then cap the opening above
//      with a solid block so nothing can reach the bot. Only when the ground
//      below is safe (solid floor under the hole, no liquid in the dig path).
//   B. HUT: a 1x1 cell — place the 4 walls around the bot (feet + head level)
//      and a roof — when the ground is NOT safe to dig into but the bot has
//      solid blocks to place.
//
// Bounded by a wall-clock deadline and honors config.signal, like attack.js /
// shelter.js. Reuses the tested placeBlockAction / digAction primitives.

import { Vec3 } from 'vec3'
import { digAction } from './dig.js'
import { placeBlockAction } from './place.js'

export const DEFAULT_TIMEOUT_MS = 15000

const AIR = new Set(['air', 'cave_air', 'void_air'])
const LIQUID = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column'])

// Gravity-affected blocks make a BAD ceiling cap (they fall on your head) — so we
// prefer any other solid for capping and only use these as a last resort.
const GRAVITY = new Set(['sand', 'red_sand', 'gravel', 'anvil', 'suspicious_sand', 'suspicious_gravel'])

// Non-placeable / non-solid inventory items we must never treat as building
// blocks. This is a denylist over a heuristic (anything else that is a "block"
// item is assumed placeable-solid); keeps us from trying to wall up with torches.
const NOT_A_WALL = new Set([
  'torch', 'redstone_torch', 'soul_torch', 'lever', 'ladder', 'vine', 'rail',
  'sign', 'water_bucket', 'lava_bucket', 'flower_pot', 'carpet',
])

// 6 neighbour offsets in placement priority (floor, horizontals, ceiling) — the
// same order build.js/place.js use to pick a reference face for an empty cell.
const FACE_PRIORITY = [
  { off: [0, -1, 0], face: [0, 1, 0] },
  { off: [0, 0, -1], face: [0, 0, 1] },
  { off: [0, 0, 1], face: [0, 0, -1] },
  { off: [1, 0, 0], face: [-1, 0, 0] },
  { off: [-1, 0, 0], face: [1, 0, 0] },
  { off: [0, 1, 0], face: [0, -1, 0] },
]

function blockName(bot, x, y, z) {
  try { return bot.blockAt(new Vec3(x, y, z))?.name ?? null } catch (_) { return null }
}
function isAir(name) { return name != null && AIR.has(name) }
function isLiquid(name) { return name != null && LIQUID.has(name) }
function isSolid(name) { return name != null && !AIR.has(name) && !LIQUID.has(name) }

// Inventory solids usable as walls/caps, roughly ordered: non-gravity solids
// first, gravity blocks last. Returns an array of item names (most-preferred
// first) with a positive count.
function inventorySolids(bot) {
  const items = bot.inventory?.items?.() ?? []
  const nonGravity = []
  const gravity = []
  for (const it of items) {
    const n = it?.name
    if (!n || NOT_A_WALL.has(n)) continue
    // Heuristic: treat a stack whose name looks like a full block as placeable.
    // Common building blocks + anything ending in _planks/_log/_wood/_stone etc.
    const looksSolid =
      /(_planks|_log|_wood|cobblestone|stone|dirt|deepslate|netherrack|tuff|granite|diorite|andesite|_terracotta|_concrete|bricks?|_wool|blackstone|basalt|sandstone|prismarine|calcite|glass)$/.test(n) ||
      ['dirt', 'cobblestone', 'stone', 'netherrack', 'deepslate', 'grass_block', 'coarse_dirt', 'sand', 'gravel'].includes(n)
    if (!looksSolid) continue
    if (GRAVITY.has(n)) gravity.push(n)
    else nonGravity.push(n)
  }
  return [...nonGravity, ...gravity]
}

// Place a solid block into an (empty) target cell by picking a solid neighbour to
// place against. Reuses placeBlockAction's explicit-face path (tested timeout +
// abort wrapper). Returns the placeBlockAction result string, or a short failure.
async function placeAtCell(bot, config, itemName, cell) {
  for (const { off, face } of FACE_PRIORITY) {
    const rp = { x: cell.x + off[0], y: cell.y + off[1], z: cell.z + off[2] }
    const refName = blockName(bot, rp.x, rp.y, rp.z)
    if (isSolid(refName)) {
      return placeBlockAction(
        { block: itemName, against: { x: rp.x, y: rp.y, z: rp.z }, faceVector: { x: face[0], y: face[1], z: face[2] } },
        bot,
        config,
      )
    }
  }
  return `no ref face for ${itemName}`
}

const placedOk = (r) => typeof r === 'string' && r.startsWith('placed ')

/**
 * digIn — dig a quick hole (or wall up a 1x1 hut) and seal it.
 * @param {{variant?:'auto'|'hole'|'hut'}} args
 */
export async function digInAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  const deadline = Date.now() + (config?.digin_timeout_ms ?? DEFAULT_TIMEOUT_MS)
  const overBudget = () => Date.now() > deadline

  const p = bot.entity?.position
  if (!p || !Number.isFinite(p.x)) return 'no_bot'
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z)

  const variant = args?.variant ?? 'auto'

  // Ground-safety check for the HOLE variant: the two cells we dig (fy-1, fy-2)
  // must be diggable solids (not liquid), and the cell 3 below (fy-3) must be
  // solid so the bot lands on floor instead of dropping into a cave / lava.
  const below1 = blockName(bot, fx, fy - 1, fz)
  const below2 = blockName(bot, fx, fy - 2, fz)
  const below3 = blockName(bot, fx, fy - 3, fz)
  const groundSafe =
    isSolid(below1) && !isLiquid(below1) &&
    isSolid(below2) && !isLiquid(below2) &&
    isSolid(below3)

  const wantHut = variant === 'hut' || (variant === 'auto' && !groundSafe)

  if (wantHut) {
    return buildHut(bot, config, { fx, fy, fz }, overBudget, signal)
  }

  // ── Variant A: dig straight down 2, then cap ─────────────────────────────
  if (!groundSafe) {
    // Explicit 'hole' request but unsafe ground — refuse rather than dig into a
    // cave/liquid. Fall back to a hut if we have blocks.
    const solids = inventorySolids(bot)
    if (solids.length) return buildHut(bot, config, { fx, fy, fz }, overBudget, signal)
    return `couldn't dig in — ground below is unsafe (${below1 ?? '?'} / ${below2 ?? '?'} / ${below3 ?? '?'}) and no blocks to wall up with`
  }

  let dug = 0
  // Dig the block beneath, twice. After each dig the bot falls one block, so we
  // re-read its (new) feet cell before the next dig.
  for (let i = 0; i < 2; i++) {
    if (signal?.aborted) return `aborted after digging ${dug}`
    if (overBudget()) break
    const cur = bot.entity?.position
    const cy = Math.floor(cur.y)
    // Re-guard: the block below must still be a non-liquid solid.
    const target = blockName(bot, fx, cy - 1, fz)
    if (!isSolid(target) || isLiquid(target)) break
    const r = await digAction({ x: fx, y: cy - 1, z: fz }, bot, config)
    if (r === 'aborted') return `aborted after digging ${dug}`
    if (typeof r === 'string' && r.startsWith('dug ')) dug++
    else break // couldn't break it — stop before we get stuck half-dug
  }

  if (dug === 0) {
    return 'couldn\'t dig in — the floor under me wouldn\'t break'
  }

  // Cap the opening. After digging `dug` blocks the bot is `dug` blocks lower;
  // the opening to the surface sits at the ORIGINAL feet level, fy.
  const capCell = { x: fx, y: fy, z: fz }
  // Prefer inventory solids; if none, re-scan (the dug blocks — dirt/cobble —
  // were just picked up and are now placeable).
  const solids = inventorySolids(bot)
  const holeDepthNote = dug === 1 ? 'holed up 1 deep' : 'holed up 2 deep'

  if (!solids.length) {
    return `${holeDepthNote} — no blocks to cap, still exposed above`
  }
  if (signal?.aborted) return `${holeDepthNote} (aborted before capping)`
  if (overBudget()) return `${holeDepthNote} — ran out of time before capping`

  // Look up so the placement raycast favors the ceiling opening.
  try { await bot.look(bot.entity.yaw, -Math.PI / 2, false) } catch (_) {}
  const cap = solids[0]
  const capRes = await placeAtCell(bot, config, cap, capCell)
  if (placedOk(capRes)) {
    return `${holeDepthNote}, capped with ${cap}`
  }
  return `${holeDepthNote} — tried to cap with ${cap} but ${capRes}; may still be exposed`
}

// Variant B: 1x1 hut — walls at feet + head level on all 4 sides, plus a roof.
async function buildHut(bot, config, { fx, fy, fz }, overBudget, signal) {
  const solids = inventorySolids(bot)
  if (!solids.length) {
    return 'couldn\'t dig in — no solid blocks in inventory to wall up with'
  }
  const mat = solids[0]
  const ring = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  let placed = 0
  let attempts = 0
  // Walls: feet level (fy) then head level (fy+1); then the roof at fy+2.
  const cells = []
  for (const dy of [0, 1]) {
    for (const [dx, , dz] of ring) cells.push({ x: fx + dx, y: fy + dy, z: fz + dz })
  }
  cells.push({ x: fx, y: fy + 2, z: fz }) // roof

  for (const cell of cells) {
    if (signal?.aborted) return placed ? `walled up ${placed} sides then aborted` : 'aborted'
    if (overBudget()) break
    // Skip cells that are already solid (existing wall / terrain).
    const existing = blockName(bot, cell.x, cell.y, cell.z)
    if (existing != null && !isAir(existing)) continue
    attempts++
    const r = await placeAtCell(bot, config, mat, cell)
    if (placedOk(r)) placed++
  }

  if (placed === 0 && attempts > 0) {
    return `couldn't wall up (no reachable faces for ${mat})`
  }
  const gaps = attempts - placed
  return gaps > 0
    ? `walled myself in with ${mat} (${placed} blocks, ${gaps} gaps left)`
    : `walled myself in with ${mat} (${placed} blocks)`
}
