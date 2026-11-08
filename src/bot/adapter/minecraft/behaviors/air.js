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
// The rule now: a dig or gather that finds her low on air with her head
// under water stops swinging, swims up (or lets the reflex do it) and waits
// until her air is back before it goes on. The snapshot shows her air while
// it is not full, so what she says about it can match.

import { Vec3 } from 'vec3'

// Same water columns as survival.js: kelp and seagrass are waterlogged.
const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])

/** Air at or below this (0-20) with the head under water stops a dig. The
 * survival reflex takes over at 10, so the action steps aside first. */
export const AIR_LOW = 12
/** Back to digging once air is at least this. */
export const AIR_FULL = 18
const POLL_MS = 100
export const SURFACE_BUDGET_MS = 20000

function isWaterBlock(b) {
  if (!b) return false
  if (WATER.has(b.name)) return true
  try { if (b.getProperties?.()?.waterlogged === true) return true } catch {}
  return false
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

/** Running low on air under water, or the drowning reflex is already up. */
export function lowOnAir(bot) {
  if (bot?._seiDrowning) return true
  const o = airLevel(bot)
  return o != null && o <= AIR_LOW && headUnderwater(bot)
}

/** Is the block under water (water right above it)? Digging it means
 * standing or floating in the water. */
export function isUnderwaterBlock(bot, pos) {
  try { return isWaterBlock(bot.blockAt(new Vec3(pos.x, pos.y + 1, pos.z))) } catch { return false }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Stop digging and walking, swim up, and wait until the air is back.
 * The survival reflex drives the swim when it is up; otherwise this holds
 * jump itself (in water, jump is swim up).
 * @returns {Promise<'ok'|'aborted'|'timeout'>}
 */
export async function surfaceForAir(bot, signal, budgetMs = SURFACE_BUDGET_MS) {
  if (!bot) return 'ok'
  try { bot.stopDigging?.() } catch {}
  try { bot.pathfinder?.setGoal?.(null) } catch {}
  bot._seiAirBreak = true
  let holding = false
  const deadline = Date.now() + budgetMs
  try {
    while (true) {
      if (signal?.aborted) return 'aborted'
      const under = headUnderwater(bot)
      const air = airLevel(bot)
      if (!under && (air == null || air >= AIR_FULL)) return 'ok'
      if (Date.now() >= deadline) return 'timeout'
      // In the water (head under, or bobbing at the top): keep swimming up
      // so she does not sink again while the air comes back. On dry ground
      // just wait for it.
      const inWater = under || bot.entity?.isInWater === true
      const want = inWater && !bot._seiDrowning
      if (want !== holding) {
        try { bot.setControlState?.('jump', want) } catch {}
        holding = want
      }
      await sleep(POLL_MS)
    }
  } finally {
    if (holding) { try { bot.setControlState?.('jump', false) } catch {} }
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
