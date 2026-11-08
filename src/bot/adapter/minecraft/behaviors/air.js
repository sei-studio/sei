// src/bot/adapter/minecraft/behaviors/air.js
//
// 261108 (quality pass 47): air for the actions that keep the body busy in
// one spot (dig, gather). In gather_craft-02-B she gathered stone on a river
// bed: the survival reflex (survival.js) started its swim-up at 10 air, but
// the gather kept going under it (a new walk to the next stone, the dig's
// own pickup walk, the next swing), she never rose, drowned with the gather
// still "running", and lost every tool. Her line "coming up for air, still
// mining" was what the reflex announced, not what the body did.
//
// The repro (pathing-repro river_gather_stone) showed why the reflex did not
// save her: the stone she mined was over a flooded cave under the river bank.
// Straight up was a stone ceiling, the reflex only swims up (or looks for air
// level with her head within 4 blocks), so she pressed into the ceiling and
// drowned. Air was 8 blocks away, out through the cave mouth into the river.
//
// The rule now: a dig or gather that finds her low on air with her head
// under water stops swinging and swims to the nearest place she can breathe
// (findBreathPath: a short search through the water, so a ceiling sends her
// sideways and out), or lets the reflex do it, and waits until her air is
// back before it goes on. "Low" scales with how far the air is, so in a
// flooded cave she leaves while she still has the air to get out. The
// snapshot shows her air while it is not full, so what she says can match.

import { Vec3 } from 'vec3'

// Same water columns as survival.js: kelp and seagrass are waterlogged.
const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air'])
const HURTS = /lava|fire|magma|cactus|berry_bush|powder_snow/

/** Air at or below this (0-20) with the head under water stops a dig. The
 * survival reflex takes over at 10, so the action steps aside first. */
export const AIR_LOW = 12
/** Back to digging once air is at least this. */
export const AIR_FULL = 18
const POLL_MS = 50
export const SURFACE_BUDGET_MS = 20000

function isWaterBlock(b) {
  if (!b) return false
  if (WATER.has(b.name)) return true
  try { if (b.getProperties?.()?.waterlogged === true) return true } catch {}
  return false
}

/** Can her body be in this cell (water or open air, nothing that hurts)? */
function passable(b) {
  if (!b || HURTS.test(b.name)) return false
  if (b.boundingBox != null) return b.boundingBox === 'empty'
  return WATER.has(b.name) || AIR_NAMES.has(b.name)
}

/** Air budget for the way out: air units (0-20, one is 0.75s) she wants
 * left per cell of swimming, on top of a margin. */
const ESCAPE_MARGIN = 8
export const BREATH_RADIUS = 12
const BREATH_MAX_NODES = 3000

/**
 * The shortest way, through water and open air, to a spot where her head is
 * out of the water: the feet cells to move through, the last one the spot.
 * [] when her head is already out, null when nothing is within reach.
 */
export function findBreathPath(bot, { radius = BREATH_RADIUS, maxNodes = BREATH_MAX_NODES } = {}) {
  const p = bot?.entity?.position
  if (!p || !Number.isFinite(p.y)) return null
  const at = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) } catch { return null } }
  const start = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  const head0 = at(start.x, start.y + 1, start.z)
  if (passable(head0) && !isWaterBlock(head0)) return []
  const key = (c) => `${c.x},${c.y},${c.z}`
  const prev = new Map([[key(start), null]])
  const seen = new Set([key(start)])
  const queue = [start]
  // Up first, so an open column straight up wins a tie.
  const DIRS = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]
  for (let qi = 0; qi < queue.length && qi < maxNodes; qi++) {
    const c = queue[qi]
    for (const [dx, dy, dz] of DIRS) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
      if (Math.abs(n.x - start.x) > radius || Math.abs(n.y - start.y) > radius || Math.abs(n.z - start.z) > radius) continue
      const k = key(n)
      if (seen.has(k)) continue
      seen.add(k)
      const feet = at(n.x, n.y, n.z)
      const head = at(n.x, n.y + 1, n.z)
      if (!passable(feet) || !passable(head)) continue
      prev.set(k, c)
      if (!isWaterBlock(head)) {
        const path = []
        for (let cur = n; cur && key(cur) !== key(start); cur = prev.get(key(cur))) path.unshift(cur)
        return path
      }
      queue.push(n)
    }
  }
  return null
}

/** Does the way out go sideways (a ceiling over her), not just up? */
export function breathPathSideways(path, pos) {
  if (!path?.length || !pos) return false
  const x = Math.floor(pos.x), z = Math.floor(pos.z)
  return path.some((c) => c.x !== x || c.z !== z)
}

/**
 * The air she wants left before heading out: AIR_LOW for open water above,
 * more the farther the way out is (a flooded cave). Cached for a second on
 * the bot; only searched while her head is under water.
 */
export function airToLeave(bot) {
  if (!headUnderwater(bot)) return AIR_LOW
  const p = bot.entity.position
  const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const c = bot._seiBreathCache
  const now = Date.now()
  if (c && c.k === k && now - c.at < 1000) return c.need
  const path = findBreathPath(bot)
  const need = path == null ? 19 : Math.min(19, Math.max(AIR_LOW, ESCAPE_MARGIN + path.length))
  bot._seiBreathCache = { k, at: now, need, path }
  return need
}

/**
 * One steering step along a breath path (`st = { path }`): face the next
 * cell, swim forward to it, hold jump (swim up) unless the next cell is
 * lower. Call it every tick or poll; refresh `st.path` now and then.
 */
export function breathSteer(bot, st) {
  const p = bot?.entity?.position
  if (!p || !st?.path?.length) return
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z)
  let i = 0
  for (let j = st.path.length - 1; j >= 0; j--) {
    const c = st.path[j]
    if (c.x === fx && c.y === fy && c.z === fz) { i = Math.min(j + 1, st.path.length - 1); break }
  }
  const wp = st.path[i]
  const dx = wp.x + 0.5 - p.x, dz = wp.z + 0.5 - p.z
  const h = Math.hypot(dx, dz)
  // Center on the cell: her body is 0.6 wide, so a 1-wide gap or shaft
  // only lets her through near the middle.
  if (h > 0.1) { try { bot.look?.(Math.atan2(-dx, -dz), 0, true) } catch {} }
  try { bot.setControlState?.('forward', h > 0.15) } catch {}
  try { bot.setControlState?.('jump', wp.y >= fy) } catch {}
}

/** Is the cell the head is in water? */
export function headUnderwater(bot) {
  const p = bot?.entity?.position
  if (!p || !Number.isFinite(p.y)) return false
  try {
    return isWaterBlock(bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y + 1.62), Math.floor(p.z))))
  } catch { return false }
}

/** Air left, 0-20, or null when the game has not said. */
export function airLevel(bot) {
  const o = bot?.oxygenLevel
  return Number.isFinite(o) ? o : null
}

/** Running low on air under water (for how far the air is), or the
 * drowning reflex is already up. */
export function lowOnAir(bot) {
  if (bot?._seiDrowning) return true
  const o = airLevel(bot)
  if (o == null || o >= 20 || !headUnderwater(bot)) return false
  return o <= airToLeave(bot)
}

/** Is the block under water (water right above it)? Digging it means
 * standing or floating in the water. */
export function isUnderwaterBlock(bot, pos) {
  try { return isWaterBlock(bot.blockAt(new Vec3(pos.x, pos.y + 1, pos.z))) } catch { return false }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Stop digging and walking, swim to air, and wait until the air is back.
 * The survival reflex drives the swim when it is up; otherwise this steers
 * along findBreathPath itself (sideways out from under a ceiling, then up;
 * in water, jump is swim up).
 * @returns {Promise<'ok'|'aborted'|'timeout'>}
 */
export async function surfaceForAir(bot, signal, budgetMs = SURFACE_BUDGET_MS) {
  if (!bot) return 'ok'
  try { bot.stopDigging?.() } catch {}
  try { bot.pathfinder?.setGoal?.(null) } catch {}
  bot._seiAirBreak = true
  let driving = false
  const st = { path: null, at: 0 }
  const deadline = Date.now() + budgetMs
  const release = () => {
    try { bot.setControlState?.('jump', false) } catch {}
    try { bot.setControlState?.('forward', false) } catch {}
  }
  try {
    while (true) {
      if (signal?.aborted) return 'aborted'
      const under = headUnderwater(bot)
      const air = airLevel(bot)
      if (!under && (air == null || air >= AIR_FULL)) return 'ok'
      if (Date.now() >= deadline) return 'timeout'
      const inWater = under || bot.entity?.isInWater === true
      if (bot._seiDrowning || !inWater) {
        // The reflex is swimming her, or she is on dry ground: wait.
        if (driving) { release(); driving = false }
      } else if (under) {
        if (!st.path || Date.now() - st.at > 750) {
          st.path = findBreathPath(bot); st.at = Date.now()
        }
        if (st.path?.length) breathSteer(bot, st)
        else { try { bot.setControlState?.('forward', false); bot.setControlState?.('jump', true) } catch {} }
        driving = true
      } else {
        // Bobbing at the top: keep swimming up so she does not sink again
        // while the air comes back.
        try { bot.setControlState?.('forward', false); bot.setControlState?.('jump', true) } catch {}
        driving = true
      }
      await sleep(POLL_MS)
    }
  } finally {
    if (driving) release()
    bot._seiAirBreak = false
  }
}

/** Snapshot line for her air: only while it is not full or her head is
 * under water, so it costs nothing the rest of the time. */
export function airLine(bot) {
  const air = airLevel(bot)
  const under = headUnderwater(bot)
  if (!under && (air == null || air >= 20)) return null
  const parts = [`air: ${air ?? '?'}/20`]
  if (under) parts.push('head under water')
  if (bot?._seiDrowning || bot?._seiAirBreak) parts.push('swimming up for air now')
  return parts.join(', ')
}
