// src/bot/adapter/minecraft/behaviors/swimOut.js
//
// 261123 (quality pass 62): get out of deep water before a walk.
//
// mineflayer-pathfinder cannot plan upward through water: getMoveUp and the
// jump moves all refuse a node whose feet are in a liquid ("dont go
// underwater", "cant jump from water"). On the bed of a river five blocks
// deep its only moves run along the bed, and while the walk runs the
// executor holds jump in water, so the body floats up off the planned nodes
// and the path resets. In the 2026-11-23 scorecard (gather_craft-02) she
// spent the last three minutes of the session in a river by the beach: goTo
// the shore 4 blocks away came back stuck, cant_reach, aborted, timeout
// (five tries), pillar up "no solid floor below", and between actions she
// sank to the bed again, where the drowning reflex swam her up.
//
// So when a goTo starts with her in deep water (feet in water and either
// water under her feet or her head under too), and it is not going to a spot
// in the same water, she swims to the nearest place she can climb out first,
// steering by hand the way the air search does (air.js): a short search
// through the water for a dry cell with ground under it next to the water,
// then jump held (in water, jump is swim up, so she stays at the top) and
// forward toward it. The physics climbs a one-block bank out of the water on
// its own (outOfLiquidImpulse). The normal walk takes over from the shore.

import { Vec3 } from 'vec3'
import { isWaterBlock } from './air.js'

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air'])
const HURTS = /lava|fire|magma|cactus|berry_bush|powder_snow/

/** How far (each axis) the shore search looks. */
export const SHORE_RADIUS = 16
const SHORE_MAX_NODES = 12000
/** Each block of the shore's distance from where she is going counts this
 * much against it (a shore toward the target beats a nearer one behind her). */
const TOWARD_WEIGHT = 0.5
export const SWIM_BUDGET_MS = 20000
// No getting closer to the shore by this much in this long: look again,
// then give up.
const PROGRESS_M = 0.5
const PROGRESS_MS = 3000
const MAX_REPLANS = 2
const POLL_MS = 50

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

function at(bot, x, y, z) {
  try { return bot.blockAt(new Vec3(x, y, z)) } catch { return null }
}

/** Her body can be in this cell (water or open air, nothing that hurts). */
function passable(b) {
  if (!b || HURTS.test(b.name)) return false
  if (b.boundingBox != null) return b.boundingBox === 'empty'
  return isWaterBlock(b) || AIR_NAMES.has(b.name)
}

/** Something to stand on. */
function solid(b) {
  if (!b || AIR_NAMES.has(b.name) || isWaterBlock(b) || HURTS.test(b.name)) return false
  if (b.boundingBox != null) return b.boundingBox === 'block'
  return true
}

function feetCell(bot) {
  const p = bot?.entity?.position
  if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return null
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

/**
 * In water too deep to walk out of: her feet are in water, and either there
 * is water under her feet (swimming) or her head is under too (on the bed).
 * Wading in a one-deep puddle is not deep water.
 */
export function inDeepWater(bot) {
  const c = feetCell(bot)
  if (!c) return false
  const below = isWaterBlock(at(bot, c.x, c.y - 1, c.z))
  if (isWaterBlock(at(bot, c.x, c.y, c.z))) return below || isWaterBlock(at(bot, c.x, c.y + 1, c.z))
  // Bobbing at the top with her feet just over the water line, over water
  // at least two deep.
  return bot.entity?.isInWater === true && below && isWaterBlock(at(bot, c.x, c.y - 2, c.z))
}

/** How deep the water is where she is (feet cell down to the bed), or 0. */
export function waterDepth(bot, max = 24) {
  const c = feetCell(bot)
  if (!c) return 0
  const y = isWaterBlock(at(bot, c.x, c.y, c.z)) ? c.y : c.y - 1
  if (!isWaterBlock(at(bot, c.x, y, c.z))) return 0
  let top = y
  while (top - y < max && isWaterBlock(at(bot, c.x, top + 1, c.z))) top++
  let bed = y
  while (y - bed < max && isWaterBlock(at(bot, c.x, bed, c.z))) bed--
  return Math.max(0, top - bed)
}

/** Is the spot she is going to in water (or the block right above it is)? */
export function targetInWater(bot, target) {
  if (!target || ![target.x, target.y, target.z].every(Number.isFinite)) return false
  const x = Math.floor(target.x), y = Math.floor(target.y), z = Math.floor(target.z)
  return isWaterBlock(at(bot, x, y, z)) || isWaterBlock(at(bot, x, y + 1, z))
}

/** A dry cell with ground under it and room for her body. */
function isLanding(bot, x, y, z) {
  const feet = at(bot, x, y, z)
  const head = at(bot, x, y + 1, z)
  if (!passable(feet) || isWaterBlock(feet)) return false
  if (!passable(head) || isWaterBlock(head)) return false
  return solid(at(bot, x, y - 1, z))
}

/**
 * The way to the nearest place she can climb out of the water: a search
 * through water cells (and the open air right over the water), ending on a
 * landing. With a target, a landing toward it wins over a nearer one behind
 * her. Returns { landing, path } (path = the cells to move through, the last
 * one the landing), or null when there is none within reach.
 * @param {object} bot
 * @param {{x:number,y:number,z:number}|null} [target]
 */
export function findShore(bot, target = null, { radius = SHORE_RADIUS, maxNodes = SHORE_MAX_NODES } = {}) {
  const start = feetCell(bot)
  if (!start) return null
  const key = (c) => `${c.x},${c.y},${c.z}`
  const prev = new Map([[key(start), null]])
  const dist = new Map([[key(start), 0]])
  const queue = [start]
  const landings = []
  const DIRS = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]
  for (let qi = 0; qi < queue.length && qi < maxNodes; qi++) {
    const c = queue[qi]
    const d = dist.get(key(c))
    for (const [dx, dy, dz] of DIRS) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
      if (Math.abs(n.x - start.x) > radius || Math.abs(n.z - start.z) > radius || Math.abs(n.y - start.y) > radius) continue
      const k = key(n)
      if (dist.has(k)) continue
      const feet = at(bot, n.x, n.y, n.z)
      if (!passable(feet)) continue
      if (dy === 0 && isLanding(bot, n.x, n.y, n.z)) {
        dist.set(k, d + 1)
        prev.set(k, c)
        landings.push(n)
        continue
      }
      // Move through water, or through the open air right over the water
      // (where she floats with her head out).
      const water = isWaterBlock(feet)
      if (!water && !isWaterBlock(at(bot, n.x, n.y - 1, n.z))) continue
      if (!passable(at(bot, n.x, n.y + 1, n.z))) continue
      dist.set(k, d + 1)
      prev.set(k, c)
      queue.push(n)
    }
  }
  if (!landings.length) return null
  const tx = Number(target?.x), tz = Number(target?.z)
  const toward = Number.isFinite(tx) && Number.isFinite(tz)
  let best = null
  let bestScore = Infinity
  for (const l of landings) {
    const score = dist.get(key(l)) + (toward ? TOWARD_WEIGHT * Math.hypot(l.x + 0.5 - tx, l.z + 0.5 - tz) : 0)
    if (score < bestScore) { bestScore = score; best = l }
  }
  const path = []
  for (let cur = best; cur && key(cur) !== key(start); cur = prev.get(key(cur))) path.unshift(cur)
  return { landing: best, path }
}

/** The next cell to steer for: the one after the path cell nearest her (x,z). */
function nextWaypoint(path, p) {
  let j = 0
  let bestD = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = Math.hypot(path[i].x + 0.5 - p.x, path[i].z + 0.5 - p.z)
    if (d <= bestD + 1e-6) { bestD = d; j = i }
  }
  return path[Math.min(j + 1, path.length - 1)]
}

function horizTo(p, c) {
  return Math.hypot(c.x + 0.5 - p.x, c.z + 0.5 - p.z)
}

/** On dry ground (not in water, standing on something). */
function ashore(bot) {
  const e = bot?.entity
  if (!e) return false
  if (e.isInWater === true) return false
  const c = feetCell(bot)
  if (c && isWaterBlock(at(bot, c.x, c.y, c.z))) return false
  return e.onGround !== false
}

/**
 * Swim to the nearest shore (toward `target` when given) and climb out.
 * Steers by hand; yields to the drowning reflex while it swims her up.
 * @returns {Promise<{status:'not_needed'|'ashore'|'no_shore'|'stuck'|'timeout'|'aborted', landing?:{x:number,y:number,z:number}, at?:{x:number,y:number,z:number}}>}
 */
export async function swimToShore(bot, target = null, { signal, budgetMs = SWIM_BUDGET_MS, sleep = sleepMs } = {}) {
  if (!bot?.entity) return { status: 'not_needed' }
  if (!inDeepWater(bot)) return { status: 'not_needed' }
  let shore = findShore(bot, target)
  if (!shore) return { status: 'no_shore', at: feetCell(bot) }
  try { bot.pathfinder?.setGoal?.(null) } catch {}
  const deadline = Date.now() + budgetMs
  let replans = 0
  let bestD = horizTo(bot.entity.position, shore.landing)
  let bestAt = Date.now()
  let driving = false
  const release = () => {
    try { bot.setControlState?.('forward', false) } catch {}
    try { bot.setControlState?.('jump', false) } catch {}
  }
  bot._seiGazeHold = (bot._seiGazeHold ?? 0) + 1
  try {
    while (true) {
      if (signal?.aborted) return { status: 'aborted', at: feetCell(bot) }
      if (ashore(bot)) return { status: 'ashore', landing: shore.landing, at: feetCell(bot) }
      if (Date.now() >= deadline) return { status: 'timeout', landing: shore.landing, at: feetCell(bot) }
      if (bot._seiDrowning || bot._seiReflexActive) {
        // The swim up for air (or a creeper flee) has the body: wait.
        if (driving) { release(); driving = false }
        await sleep(POLL_MS)
        bestAt = Date.now()
        continue
      }
      const p = bot.entity.position
      const d = horizTo(p, shore.landing)
      if (d < bestD - PROGRESS_M) { bestD = d; bestAt = Date.now() }
      if (Date.now() - bestAt > PROGRESS_MS) {
        if (replans >= MAX_REPLANS) return { status: 'stuck', landing: shore.landing, at: feetCell(bot) }
        replans++
        const again = findShore(bot, target)
        if (!again) return { status: 'no_shore', at: feetCell(bot) }
        shore = again
        bestD = horizTo(p, shore.landing)
        bestAt = Date.now()
      }
      const wp = shore.path.length ? nextWaypoint(shore.path, p) : shore.landing
      const dx = wp.x + 0.5 - p.x, dz = wp.z + 0.5 - p.z
      if (Math.hypot(dx, dz) > 0.1) { try { bot.look?.(Math.atan2(-dx, -dz), 0, true) } catch {} }
      // Jump is swim up in water, and the climb out over the bank.
      try { bot.setControlState?.('jump', true) } catch {}
      try { bot.setControlState?.('forward', true) } catch {}
      driving = true
      await sleep(POLL_MS)
    }
  } finally {
    if (driving) release()
    bot._seiGazeHold = Math.max(0, (bot._seiGazeHold ?? 1) - 1)
  }
}

/** The snapshot words for deep water, or null when she is not in it. */
export function deepWaterLine(bot) {
  if (!inDeepWater(bot)) return null
  return `in deep water (${waterDepth(bot)} deep): goTo a spot on land swims you to the shore first; you cannot pillar up out of water`
}
