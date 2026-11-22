// src/bot/adapter/minecraft/behaviors/climbOut.js
//
// 261015 quality pass 10: get out of a 1x1 shaft before walking somewhere
// above it.
//
// The companion digs straight down a lot (a dig column under her feet, a
// pathfinder route to buried ore), and the 1x1 shaft that leaves is a trap
// for mineflayer-pathfinder. It plans the tower out at once (28ms), but each
// tower step holds jump and awaits bot.placeBlock, which on this server
// version only settles through its ~5s block-update timeout: every step logs
// `path_reset place_error` and the block shows up right after. So the tower
// climbs one block per ~5s, and a goTo's 12s budget buys two blocks. In the
// 261015 errands eval she rose y57 to y65 over three goTos (~36s), and follow
// trailed underground for 30s. Direct-mode repro on the eval arena, shaft then
// goTo the player 4 blocks away on the surface: 0/2 from a 4-deep shaft (she
// rose 1-2 blocks), 0/2 from 8-deep, with or without blocks to place.
//
// climbOut handles the shaft itself, before the walk:
//   1. pillar up with junk blocks she carries (dirt, cobblestone, ...), using
//      build.js's jump+place scaffold, which climbs about a block a second;
//   2. otherwise cut a staircase into the shaft wall toward the target.
// Then the caller's normal walk takes over from the rim. When neither works it
// returns an honest "could not climb out" line instead of a bare timeout.

import { Vec3 } from 'vec3'
import { scaffoldUp } from './build.js'
import { JUNK_SCAFFOLD } from './pathfind.js'
import { isNaturalBlock } from './naturalBlocks.js'

export { JUNK_SCAFFOLD }


const MAX_PIT_DEPTH = 24
// A rim this close is one jump; the pathfinder handles it.
export const MIN_PIT_DEPTH = 2
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const MAX_STEP_DIG_MS = 2500

export { isNaturalBlock }

/** Blocks that fall when the block under them is dug out. */
export function isFallingBlock(name) {
  if (!name) return false
  return name === 'sand' || name === 'red_sand' || name === 'gravel' ||
    name === 'suspicious_sand' || name === 'suspicious_gravel' ||
    name.endsWith('_concrete_powder') || name.endsWith('anvil') ||
    name === 'dragon_egg' || name === 'pointed_dripstone' || name === 'scaffolding'
}

// The climb gives the body back the moment something else needs it: the
// player pressed pause (pause.js), or a reflex (creeper flee) or a survival
// takeover (drowning, critical HP) started. Checked on a short poll and folded
// into the climb's own abort signal, so scaffoldUp and a running dig stop too.
const GUARD_MS = 100

function guardSignal(bot, outer) {
  const ctl = new AbortController()
  let reason = null
  const stop = (why) => { if (!ctl.signal.aborted) { reason = why; ctl.abort() } }
  const onOuter = () => stop('aborted')
  const check = () => {
    if (bot._seiPaused) stop('paused')
    else if (bot._seiReflexActive || bot._seiSurvivalActive || bot._seiCriticalRetreat) stop('yielded')
  }
  if (outer?.aborted) stop('aborted')
  else outer?.addEventListener?.('abort', onOuter, { once: true })
  check()
  const timer = setInterval(check, GUARD_MS)
  return {
    signal: ctl.signal,
    reason: () => reason,
    dispose() { clearInterval(timer); outer?.removeEventListener?.('abort', onOuter) },
  }
}

function abortedResult(guard) {
  const why = guard.reason()
  return why && why !== 'aborted' ? { status: 'aborted', why } : { status: 'aborted' }
}

function isAirName(name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

/** The body can stand in this cell (no collision box, not lava). */
export function isPassable(blk) {
  if (!blk) return false
  if (blk.name === 'lava') return false
  return isAirName(blk.name) || blk.boundingBox === 'empty'
}

function isLiquid(blk) {
  return !!blk && (blk.name === 'water' || blk.name === 'lava' || blk.name === 'bubble_column')
}

function isSolid(blk) {
  return !!blk && !isAirName(blk.name) && blk.boundingBox === 'block'
}

const at = (bot, x, y, z) => bot.blockAt(new Vec3(x, y, z))

/**
 * Is the bot at the bottom of a 1x1 shaft, and where is its rim?
 *
 * Enclosed means no side cell at feet level has room to step into (feet and
 * head both passable). Walking up the bot's own column, the rim is the first
 * level with such a side cell. Returns null when the bot is not enclosed (the
 * pathfinder can walk out on its own).
 *
 * 261017 (pass 12): the rim is not always the way out. In the 261016 errands
 * eval she mined two coal blocks out of the shaft wall two blocks above the
 * bottom, so the first side opening was a dead-end pocket. climbOut pillared
 * two blocks to it, called that "out of the hole", and the walk from there
 * timed out 13 blocks underground. `exitY` is the first open side level that
 * actually leads somewhere (see sideLeadsOut); climbOut pillars to it. It is
 * null when the open column ends (or runs past maxDepth) before any such level.
 *
 * @param {object} bot
 * @param {number} [maxDepth]
 * @param {{x:number,y:number,z:number}|null} [target] where she is headed; a
 *   side opening that leads toward it counts as an exit
 * @returns {null | { feetY:number, rimY:number|null, depth:number|null, exitY?:number|null, exitDepth?:number|null, ceilingY?:number, dir?:[number,number] }}
 */
export function pitInfo(bot, maxDepth = MAX_PIT_DEPTH, target = null) {
  const p = bot?.entity?.position
  if (!p || typeof bot.blockAt !== 'function') return null
  const x = Math.floor(p.x), z = Math.floor(p.z)
  const feetY = Math.floor(p.y + 0.01)
  const openSides = (y) => {
    const out = []
    for (const [dx, dz] of DIRS) {
      if (isPassable(at(bot, x + dx, y, z + dz)) && isPassable(at(bot, x + dx, y + 1, z + dz))) out.push([dx, dz])
    }
    return out
  }
  if (openSides(feetY).length) return null
  let rim = null
  for (let y = feetY + 1; y <= feetY + maxDepth; y++) {
    // The column above must be open for the body to rise through it.
    if (!isPassable(at(bot, x, y + 1, z))) {
      return rim
        ? { ...rim, exitY: null, exitDepth: null, ceilingY: y + 1 }
        : { feetY, rimY: null, depth: null, ceilingY: y + 1 }
    }
    const sides = openSides(y)
    if (!sides.length) continue
    if (!rim) rim = { feetY, rimY: y, depth: y - feetY, dir: sides[0] }
    if (sides.some(([dx, dz]) => sideLeadsOut(bot, x, z, x + dx, y, z + dz, target))) {
      return { ...rim, exitY: y, exitDepth: y - feetY }
    }
  }
  return rim ? { ...rim, exitY: null, exitDepth: null } : { feetY, rimY: null, depth: null }
}

const EXIT_SEARCH_NODES = 40
const EXIT_SEARCH_RADIUS = 5

/**
 * Does the side cell (sx, y, sz) off her shaft lead anywhere? Floods the cells
 * she could walk to from it (same level, one up or down; her own column left
 * out) and says yes when the flood runs past a few dozen cells or a few blocks
 * out (open ground, a cave, a tunnel), or reaches the target's height near the
 * target. A pocket a couple of mined ores big floods out at once: no.
 */
export function sideLeadsOut(bot, shaftX, shaftZ, sx, y, sz, target = null) {
  const tx = Number(target?.x), ty = Number(target?.y), tz = Number(target?.z)
  const hasTarget = [tx, ty, tz].every(Number.isFinite)
  const seen = new Set()
  const queue = [{ x: sx, y, z: sz }]
  seen.add(`${sx},${y},${sz}`)
  while (queue.length) {
    const c = queue.shift()
    if (hasTarget && c.y >= Math.floor(ty) - 1 && Math.hypot(c.x - tx, c.z - tz) <= 3) return true
    for (const [dx, dz] of DIRS) {
      const nx = c.x + dx, nz = c.z + dz
      if (nx === shaftX && nz === shaftZ) continue
      if (Math.abs(nx - sx) > EXIT_SEARCH_RADIUS || Math.abs(nz - sz) > EXIT_SEARCH_RADIUS) return true
      for (const dy of [0, 1, -1]) {
        const ny = c.y + dy
        if (dy === 1 && !isPassable(at(bot, c.x, c.y + 2, c.z))) continue
        // Walkable: feet and head free. A missing floor is fine (she drops
        // onto whatever is below, which the next step's own test covers).
        if (!(isPassable(at(bot, nx, ny, nz)) && isPassable(at(bot, nx, ny + 1, nz)))) continue
        const k = `${nx},${ny},${nz}`
        if (seen.has(k)) break
        if (seen.size >= EXIT_SEARCH_NODES) return true
        seen.add(k)
        queue.push({ x: nx, y: ny, z: nz })
        break
      }
    }
  }
  return false
}

/** Junk scaffold blocks in the inventory, in JUNK_SCAFFOLD's spending order. */
export function junkBlocks(bot, keepItems = []) {
  const keep = new Set(keepItems)
  const counts = new Map()
  for (const it of bot?.inventory?.items?.() ?? []) {
    if (!JUNK_SCAFFOLD.includes(it.name) || keep.has(it.name)) continue
    counts.set(it.name, (counts.get(it.name) ?? 0) + it.count)
  }
  return [...counts.entries()]
    .sort((a, b) => JUNK_SCAFFOLD.indexOf(a[0]) - JUNK_SCAFFOLD.indexOf(b[0]))
    .map(([name, count]) => ({ name, count }))
}

async function waitOnGround(bot, maxMs = 1500) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    if (bot.entity?.onGround) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !!bot.entity?.onGround
}

/** Pillar to `rimY` with whatever junk blocks are on hand. */
async function pillarTo(bot, rimY, signal, keepItems) {
  for (const { name } of junkBlocks(bot, keepItems)) {
    if (Math.floor(bot.entity.position.y + 0.01) >= rimY) return 'ok'
    const r = await scaffoldUp(bot, name, rimY + 1, { signal })
    if (r === 'ok' || r === 'aborted') return r
    if (!String(r).startsWith(`no ${name}`)) return r
  }
  return Math.floor(bot.entity.position.y + 0.01) >= rimY ? 'ok' : 'ran out of blocks'
}

async function digCell(bot, x, y, z, signal) {
  const blk = at(bot, x, y, z)
  if (isPassable(blk)) return 'ok'
  if (!blk || isLiquid(blk)) return 'liquid'
  if (!isNaturalBlock(blk.name)) return `not natural: ${blk.name} at ${x},${y},${z}`
  // Sand, gravel or concrete powder resting on this cell would drop into it,
  // and for the head room cell that is her own cell: she suffocates.
  const above = at(bot, x, y + 1, z)
  if (above && isFallingBlock(above.name)) return `${above.name} above ${x},${y},${z} would fall in`
  // Never open a wall onto water or lava.
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
    if (isLiquid(at(bot, x + dx, y + dy, z + dz))) return 'liquid'
  }
  if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(blk)) return 'cannot dig'
  try {
    const tool = bot.pathfinder?.bestHarvestTool?.(blk)
    if (tool) await bot.equip(tool, 'hand')
  } catch {}
  // Stone by hand is 7.5s a block and a staircase needs three per step; say
  // so instead of standing there for a minute.
  try {
    if (typeof bot.digTime === 'function' && bot.digTime(blk) > MAX_STEP_DIG_MS) return `${blk.name} is too slow to dig with what you hold`
  } catch {}
  if (signal?.aborted) return 'aborted'
  bot._seiDigActive = (bot._seiDigActive ?? 0) + 1
  const onAbort = () => { try { bot.stopDigging?.() } catch {} }
  signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    await bot.dig(blk, true)
  } catch (e) {
    return signal?.aborted ? 'aborted' : 'dig failed'
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
    bot._seiDigActive = Math.max(0, (bot._seiDigActive ?? 1) - 1)
  }
  // Sand or gravel may have dropped into the cell.
  return isPassable(at(bot, x, y, z)) ? 'ok' : 'refilled'
}

/** Step onto the block at (x, y-1, z) from the cell beside and below it. */
async function stepUpTo(bot, x, y, z, signal) {
  const target = new Vec3(x + 0.5, y, z + 0.5)
  const t0 = Date.now()
  try {
    await bot.lookAt(target.offset(0, 1.2, 0), true)
  } catch {}
  bot.setControlState('forward', true)
  bot.setControlState('jump', true)
  try {
    while (Date.now() - t0 < 2000) {
      if (signal?.aborted) return false
      const p = bot.entity.position
      if (Math.floor(p.y + 0.01) >= y && Math.abs(p.x - target.x) < 0.4 && Math.abs(p.z - target.z) < 0.4) break
      if (Math.floor(p.y + 0.01) >= y) bot.setControlState('jump', false)
      try { await bot.lookAt(target.offset(0, 1.2, 0), true) } catch {}
      await new Promise((r) => setTimeout(r, 50))
    }
  } finally {
    // A reflex or survival takeover that cut the step short drives the body
    // now; clearing its controls would stall a creeper flee.
    if (!bot._seiReflexActive && !bot._seiSurvivalActive && !bot._seiCriticalRetreat) {
      bot.setControlState('forward', false)
      bot.setControlState('jump', false)
    }
  }
  await waitOnGround(bot, 800)
  const p = bot.entity.position
  return Math.floor(p.y + 0.01) >= y && Math.floor(p.x) === x && Math.floor(p.z) === z
}

/**
 * Cut a straight staircase out of the shaft, rising one block per step. Each
 * step clears the head room above the current cell and the two cells of the
 * next one, then jumps onto it. Tries the direction toward the target first.
 */
async function stairTo(bot, rimY, toward, signal, deadline) {
  const p0 = bot.entity.position
  const order = [...DIRS].sort((a, b) => {
    const da = toward ? -(a[0] * (toward.x - p0.x) + a[1] * (toward.z - p0.z)) : 0
    const db = toward ? -(b[0] * (toward.x - p0.x) + b[1] * (toward.z - p0.z)) : 0
    return da - db
  })
  let lastWhy = 'no direction to dig'
  const startY = Math.floor(p0.y + 0.01)
  for (const [dx, dz] of order) {
    // Only the first step may try another wall. Once she has climbed out of
    // the shaft's own wall, turning to cut a new direction would tunnel into
    // whatever is beside the hole (261016 review).
    if (Math.floor(bot.entity.position.y + 0.01) > startY) break
    let ok = true
    while (Math.floor(bot.entity.position.y + 0.01) < rimY) {
      if (signal?.aborted) return 'aborted'
      if (Date.now() > deadline) return 'out of time'
      const p = bot.entity.position
      const x = Math.floor(p.x), y = Math.floor(p.y + 0.01), z = Math.floor(p.z)
      const nx = x + dx, nz = z + dz
      const step = at(bot, nx, y, nz)
      if (!isSolid(step)) {
        // Keep a more telling reason from another wall (a refusal) over this one.
        if (lastWhy === 'no direction to dig') lastWhy = 'no wall to step on'
        ok = false
        break
      }
      // Head room to jump from here, then the two cells of the next step.
      for (const [cx, cy, cz] of [[x, y + 2, z], [nx, y + 1, nz], [nx, y + 2, nz]]) {
        let r = await digCell(bot, cx, cy, cz, signal)
        if (r === 'refilled') r = await digCell(bot, cx, cy, cz, signal)
        if (r !== 'ok') { lastWhy = r; ok = false; break }
      }
      if (!ok) break
      if (!(await stepUpTo(bot, nx, y + 1, nz, signal))) {
        if (signal?.aborted) return 'aborted'
        lastWhy = 'could not step up'
        ok = false
        break
      }
    }
    if (Math.floor(bot.entity.position.y + 0.01) >= rimY) return 'ok'
    // A failed first step leaves the bot where it was; try the next wall.
    // Any natural-ground refusal ends the staircase: the next wall is likely
    // part of the same build.
    if (String(lastWhy).startsWith('not natural')) break
  }
  return lastWhy
}

/**
 * Climb out of the 1x1 shaft the bot is standing in, if it is in one and the
 * destination is above it.
 *
 * @param {object} bot
 * @param {{x:number,y:number,z:number}|null} target where the caller is headed
 * @param {{ signal?: AbortSignal, budgetMs?: number, keepItems?: string[], canDig?: boolean }} [opts]
 * @returns {Promise<{ status: 'not_in_pit'|'climbed'|'aborted'|'failed', depth?: number, how?: 'pillar'|'stairs', exit?: boolean, line?: string }>}
 *   `exit` (on 'climbed') is false when she only reached a side pocket, not
 *   an opening that leads out. `line` (on 'failed') is an honest result line that starts with
 *   "stuck in a hole", so callers can return it as is.
 */
export async function climbOut(bot, target, opts = {}) {
  return guarded(bot, opts, (signal) => climbOutInner(bot, target, { ...opts, signal }))
}

async function guarded(bot, opts, run) {
  if (!bot?.entity?.position) return { status: 'not_in_pit' }
  const guard = guardSignal(bot, opts?.signal)
  try {
    const r = await run(guard.signal)
    return r?.status === 'aborted' ? abortedResult(guard) : r
  } finally {
    guard.dispose()
  }
}

/** The closing advice of a failed climb, matched to why it failed. */
function failAdvice(why) {
  const m = String(why).match(/not natural: ([a-z_]+)/)
  if (m) return `The wall is ${m[1]}, which looks built, so you did not dig it. Leave by a door or stairs, or ask the player`
  if (/would fall in/.test(String(why))) return 'Sand or gravel above would fall on you if you dug. Get dirt or cobblestone to pillar up with'
  return 'Get dirt or cobblestone to pillar up with, or dig a staircase up the wall'
}

async function climbOutInner(bot, target, opts = {}) {
  const { signal, budgetMs = 20000, keepItems = [], canDig = true } = opts
  if (!bot?.entity?.position) return { status: 'not_in_pit' }
  if (signal?.aborted) return { status: 'aborted' }
  // A flooded shaft is swum up, not climbed; the pathfinder handles water.
  if (bot.entity.isInWater) return { status: 'not_in_pit' }
  await waitOnGround(bot, 1000)
  const pit = pitInfo(bot, MAX_PIT_DEPTH, target)
  // No open rim (roofed over, or deeper than we look) is left to the
  // pathfinder's own digging, like a pit that is not a pit.
  if (!pit || pit.rimY == null || pit.depth < MIN_PIT_DEPTH) return { status: 'not_in_pit' }
  const ty = Number(target?.y)
  if (Number.isFinite(ty) && ty < pit.feetY + MIN_PIT_DEPTH) return { status: 'not_in_pit' }
  const here = `${Math.floor(bot.entity.position.x)},${pit.feetY},${Math.floor(bot.entity.position.z)}`
  // 261017: climb to the first opening that leads out, not to the first
  // pocket in the wall. With no such opening in reach (the column closes over
  // a pocket), fall back to the rim and say so in `exit`, so the caller does
  // not report her out of the hole on the strength of it.
  const exit = pit.exitY != null
  const topY = exit ? pit.exitY : pit.rimY
  const depth = topY - pit.feetY

  const deadline = Date.now() + budgetMs
  let why = ''
  if (junkBlocks(bot, keepItems).length) {
    const r = await pillarTo(bot, topY, signal, keepItems)
    if (r === 'aborted') return { status: 'aborted' }
    if (r === 'ok') return { status: 'climbed', depth, how: 'pillar', exit }
    why = `pillar: ${r}`
  }
  if (canDig && Math.floor(bot.entity.position.y + 0.01) < topY) {
    await waitOnGround(bot, 1000)
    const r = await stairTo(bot, topY, target, signal, deadline)
    if (r === 'aborted') return { status: 'aborted' }
    if (r === 'ok') return { status: 'climbed', depth, how: 'stairs', exit }
    why = why ? `${why}; staircase: ${r}` : `staircase: ${r}`
  }
  if (Math.floor(bot.entity.position.y + 0.01) >= topY) return { status: 'climbed', depth, how: 'stairs', exit }
  const now = Math.floor(bot.entity.position.y + 0.01)
  const blocks = junkBlocks(bot, keepItems).reduce((n, b) => n + b.count, 0)
  return {
    status: 'failed',
    depth,
    line: `stuck in a hole at ${here}: could not climb out of the ${depth}-deep shaft (now y=${now}, ${exit ? 'way out at' : 'first opening at'} y=${topY}, ` +
      `${blocks} scaffold blocks left; ${why || 'no blocks to pillar with and digging is off'}). ` +
      failAdvice(why),
  }
}

// â”€â”€ escapeUp: any hole, after a walk up out of it failed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// 261015 compare (pass 10 B side): the 1x1 check above misses the holes she
// actually ends up in during errands. The pathfinder digs down toward buried
// ore, she mines the ore out of the shaft wall, and now the bottom is an
// irregular pocket: a side cell is open, so pitInfo says "not a pit", and the
// walk back up still times out ("timeout â€” unreachable â€” try build to Y=71",
// errands-02-B and 04-B). escapeUp is the general fallback, run when a walk to
// a target well above her has failed: find a nearby column that is open above
// (her own shaft, usually a step or two away), stand in its center, and
// pillar up it; with no open column or no blocks, cut a staircase toward the
// target. The caller then walks again.

const OPEN_SEARCH_NODES = 80
const OPEN_SEARCH_RADIUS = 6

/** The body can stand at (x,y,z): feet and head free, a full block below. */
function standable(bot, x, y, z) {
  return isPassable(at(bot, x, y, z)) && isPassable(at(bot, x, y + 1, z)) && isSolid(at(bot, x, y - 1, z))
}

/**
 * How far up the column above a standing cell is open, scanning up from her
 * feet and stopping at the first of:
 *   - a level at least 2 up whose side cell opens onto somewhere
 *     (sideLeadsOut): `{ toTarget: false, rimY: that level, exit: true }`.
 *     In an open-sky shaft this is the ground level, so a target higher than
 *     the ground (on a hill) gives toTarget false: the way out is the rim.
 *   - the target's height, the column open all the way:
 *     `{ toTarget: true, exit: true }` (rimY is a pocket level or null).
 *   - a solid block over the column, or maxDepth: `{ toTarget: false,
 *     rimY: first pocket level or null, exit: false }`.
 */
export function columnOpening(bot, x, feetY, z, targetY, maxDepth = MAX_PIT_DEPTH, target = null) {
  let pocketY = null
  const result = (toTarget) => ({ toTarget, rimY: pocketY, exit: false })
  for (let y = feetY + 1; y <= feetY + maxDepth; y++) {
    if (!isPassable(at(bot, x, y + 1, z))) return result(false)
    if (y >= targetY) return { ...result(true), exit: true }
    if (y >= feetY + MIN_PIT_DEPTH) {
      for (const [dx, dz] of DIRS) {
        if (!(isPassable(at(bot, x + dx, y, z + dz)) && isPassable(at(bot, x + dx, y + 1, z + dz)))) continue
        if (pocketY == null) pocketY = y
        if (sideLeadsOut(bot, x, z, x + dx, y, z + dz, target)) return { toTarget: false, rimY: y, exit: true }
      }
    }
  }
  return result(false)
}

/**
 * Nearest cell she can walk to without digging whose column leads up: open to
 * the target's height first, else the one with the highest rim. Breadth-first
 * over standable cells (same level, or one step up or down) within a few
 * blocks. `open` is true when the walkable area around her is NOT a hole
 * (the search ran into its node or radius limit): on open ground or at the
 * foot of a cliff a failed walk is not something climbing fixes.
 *
 * @returns {{ column: null | { x:number, y:number, z:number, steps:number, toTarget:boolean, rimY:number|null }, open: boolean }}
 */
export function findOpenColumn(bot, targetY, target = null) {
  const p = bot?.entity?.position
  if (!p) return { column: null, open: false }
  const sx = Math.floor(p.x), sy = Math.floor(p.y + 0.01), sz = Math.floor(p.z)
  const seen = new Set()
  const queue = []
  let open = false
  const push = (x, y, z, steps) => {
    const k = `${x},${y},${z}`
    if (seen.has(k)) return
    if (seen.size >= OPEN_SEARCH_NODES) { open = true; return }
    seen.add(k)
    queue.push({ x, y, z, steps })
  }
  // The start cell may not be standable by the strict test (she can be held
  // up by the edge of the next block); seed it and walk on from there.
  push(sx, sy, sz, 0)
  let toTarget = null
  let best = null
  while (queue.length) {
    const c = queue.shift()
    if (standable(bot, c.x, c.y, c.z)) {
      const o = columnOpening(bot, c.x, c.y, c.z, targetY, MAX_PIT_DEPTH, target)
      if (o.toTarget && !toTarget) toTarget = { ...c, ...o }
      // A column that leads out beats one that only reaches a pocket.
      else if (o.rimY != null && (!best || (o.exit && !best.exit) || (o.exit === best.exit && o.rimY > best.rimY))) best = { ...c, ...o }
    }
    for (const [dx, dz] of DIRS) {
      const nx = c.x + dx, nz = c.z + dz
      if (Math.abs(nx - sx) > OPEN_SEARCH_RADIUS || Math.abs(nz - sz) > OPEN_SEARCH_RADIUS) {
        if (standable(bot, nx, c.y, nz)) open = true
        continue
      }
      for (const dy of [0, 1, -1]) {
        const ny = c.y + dy
        // A step up needs head room above the cell she steps from.
        if (dy === 1 && !isPassable(at(bot, c.x, c.y + 2, c.z))) continue
        if (standable(bot, nx, ny, nz)) { push(nx, ny, nz, c.steps + 1); break }
      }
    }
  }
  return { column: toTarget ?? best, open }
}

/**
 * The first solid block over her head, when it is not natural ground (a room
 * she is inside). Null under open sky or under rock.
 */
function builtRoof(bot, targetY) {
  const p = bot.entity.position
  const x = Math.floor(p.x), z = Math.floor(p.z)
  for (let y = Math.floor(p.y + 0.01) + 2; y <= Math.max(targetY, Math.floor(p.y) + 2) + 1; y++) {
    const b = at(bot, x, y, z)
    if (isPassable(b)) continue
    return b && !isLiquid(b) && !isNaturalBlock(b.name) ? { name: b.name, x, y, z } : null
  }
  return null
}

/** Walk to the center of a standable cell nearby (no digging, no placing). */
async function stepTo(bot, cell, signal, goToFn) {
  const p = bot.entity.position
  const centered = Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && Math.floor(p.y + 0.01) === cell.y &&
    Math.abs(p.x - (cell.x + 0.5)) < 0.3 && Math.abs(p.z - (cell.z + 0.5)) < 0.3
  if (centered) return true
  if (cell.steps === 0 || (Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z)) {
    // Same cell, off center: shuffle onto the middle so the block under the
    // feet column is the floor (scaffold: "no solid floor below").
    const ok = await stepUpTo(bot, cell.x, cell.y, cell.z, signal)
    return ok
  }
  if (!goToFn) return false
  const r = await goToFn(bot, cell.x, cell.y, cell.z, 0, 6000, signal, { canDig: false, canPlace: false })
  if (signal?.aborted) return false
  const q = bot.entity.position
  return String(r).startsWith('reached') || (Math.floor(q.x) === cell.x && Math.floor(q.z) === cell.z)
}

/**
 * Get up toward `target` from wherever she is underground. Meant for the
 * case where a walk to a target at least MIN_PIT_DEPTH above her already
 * failed. Same result shape as climbOut.
 *
 * @param {object} bot
 * @param {{x:number,y:number,z:number}} target
 * @param {{ signal?: AbortSignal, budgetMs?: number, keepItems?: string[], canDig?: boolean, goTo?: Function }} [opts]
 */
export async function escapeUp(bot, target, opts = {}) {
  return guarded(bot, opts, (signal) => escapeUpInner(bot, target, { ...opts, signal }))
}

async function escapeUpInner(bot, target, opts = {}) {
  const { signal, budgetMs = 25000, keepItems = [], canDig = true, goTo: goToFn } = opts
  if (!bot?.entity?.position) return { status: 'not_in_pit' }
  if (signal?.aborted) return { status: 'aborted' }
  if (bot.entity.isInWater) return { status: 'not_in_pit' }
  await waitOnGround(bot, 1000)
  const startY = Math.floor(bot.entity.position.y + 0.01)
  const targetY = Math.floor(Number(target?.y))
  if (!Number.isFinite(targetY) || targetY < startY + MIN_PIT_DEPTH) return { status: 'not_in_pit' }
  const here = `${Math.floor(bot.entity.position.x)},${startY},${Math.floor(bot.entity.position.z)}`
  const deadline = Date.now() + budgetMs
  const feet = () => Math.floor(bot.entity.position.y + 0.01)
  const done = () => feet() >= targetY - 1
  let why = ''
  let how = null

  const found = findOpenColumn(bot, targetY, target)
  // Open ground or a cliff foot: the walk failed for another reason, and
  // pillaring or tunnelling here is not what the player expects.
  if (found.open) return { status: 'not_in_pit' }
  const col = found.column
  if (col && junkBlocks(bot, keepItems).length) {
    if (await stepTo(bot, col, signal, goToFn)) {
      if (signal?.aborted) return { status: 'aborted' }
      const top = col.toTarget ? targetY : col.rimY
      const r = await pillarTo(bot, top, signal, keepItems)
      if (r === 'aborted') return { status: 'aborted' }
      if (r === 'ok') how = 'pillar'
      else why = `pillar: ${r}`
    } else {
      if (signal?.aborted) return { status: 'aborted' }
      why = 'pillar: could not get to the open shaft'
    }
  } else {
    why = col ? 'pillar: no dirt, cobblestone or similar blocks' : 'pillar: nothing open above nearby'
  }
  // Review (261017): a column that opens onto the surface below the target's
  // height (a shaft up to the ground, the target on a hill) is done at that
  // opening. Climbing on toward targetY from there would cut a staircase
  // into the hillside; the walk takes over instead.
  const exitY = col && !col.toTarget && col.exit && col.rimY != null ? col.rimY : null
  const atExit = () => exitY != null && feet() >= exitY
  const top = exitY ?? targetY
  if (how && (done() || atExit())) return { status: 'climbed', depth: feet() - startY, how }
  if (canDig && !done() && !atExit() && Date.now() < deadline) {
    await waitOnGround(bot, 1000)
    const r = await stairTo(bot, top, target, signal, deadline)
    if (r === 'aborted') return { status: 'aborted' }
    if (r === 'ok') return { status: 'climbed', depth: feet() - startY, how: how ? 'pillar' : 'stairs' }
    why = why ? `${why}; staircase: ${r}` : `staircase: ${r}`
  }
  // Partway up still counts when it got her out of the shaft she was in: the
  // next walk gets a fresh start.
  if (how || feet() >= startY + MIN_PIT_DEPTH) return { status: 'climbed', depth: feet() - startY, how: how ?? 'stairs' }
  const roof = builtRoof(bot, targetY)
  if (roof) {
    return {
      status: 'failed',
      depth: targetY - startY,
      line: `stuck under a built roof at ${here} (${roof.name} at ${roof.x},${roof.y},${roof.z}), ${targetY - startY} blocks below where you are going. ` +
        'You do not dig through builds: leave by a door or stairs, or ask the player',
    }
  }
  const blocks = junkBlocks(bot, keepItems).reduce((n, b) => n + b.count, 0)
  return {
    status: 'failed',
    depth: targetY - startY,
    line: `stuck in a hole at ${here}: ${targetY - startY} blocks below where you are going and could not climb up (now y=${feet()}, ` +
      `${blocks} scaffold blocks; ${why || 'no blocks to pillar with and digging is off'}). ` +
      failAdvice(why),
  }
}




