// src/bot/adapter/minecraft/behaviors/unreachable.js
//
// 261015 quality pass 10: a short memory of block targets the body could not
// reach, so a retry picks a different block instead of the same one.
//
// Before this, nothing remembered a failed target across actions. `find`
// returns the nearest matching block, the walk to it fails, and the next
// `find` returns the very same block (cliff log: 3 finds, 3 identical answers,
// 3 "out of range"). The 261015 errands eval did the same with a log after she
// got stuck in a hole: every find said 186,71,6.
//
// Entries are per bot (stored on the bot object, so a fresh session or a
// reconnect starts clean) and expire after a few minutes, because the world
// changes: the player bridges a gap, she picks up blocks to pillar with.
// A noted block also covers its close neighbours, because the next-nearest
// match is usually the log above it on the same trunk or the next ore in the
// same buried vein, which fails the same way.

export const UNREACHABLE_TTL_MS = 3 * 60 * 1000
// Neighbourhood a note covers: the rest of the same trunk (the logs above a
// log she could not reach are higher still) and the ores touching it. Kept
// small, so one stone block she could not reach does not rule out a quarry.
const COVER_H = 1
const COVER_UP = 5
const COVER_DOWN = 1
const MAX_ENTRIES = 64

function store(bot) {
  if (!bot) return null
  if (!Array.isArray(bot._seiUnreachable)) bot._seiUnreachable = []
  // 261016 review: coordinates mean nothing after a death or a portal. A
  // respawn (death, or a dimension change: mineflayer emits 'respawn' for
  // both) clears the memory.
  if (!bot._seiUnreachableHooked && typeof bot.on === 'function') {
    bot._seiUnreachableHooked = true
    try { bot.on('respawn', () => clearUnreachable(bot)) } catch {}
  }
  return bot._seiUnreachable
}

const dimensionOf = (bot) => bot?.game?.dimension ?? null

function prune(list, now) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].until <= now) list.splice(i, 1)
  }
}

/**
 * Remember that the block at `pos` could not be reached.
 * @param {object} bot
 * @param {{x:number,y:number,z:number}} pos
 * @param {string} [why] short reason, for the find note
 * @param {number} [now]
 */
export function noteUnreachable(bot, pos, why = '', now = Date.now()) {
  const list = store(bot)
  if (!list || !pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return
  prune(list, now)
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
  const dim = dimensionOf(bot)
  const same = list.find((e) => e.x === x && e.y === y && e.z === z && e.dim === dim)
  if (same) { same.until = now + UNREACHABLE_TTL_MS; same.why = why || same.why; return }
  list.push({ x, y, z, dim, why, until: now + UNREACHABLE_TTL_MS })
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
}

/** True when `pos` is a noted block or close to one (same trunk / vein). */
export function isUnreachable(bot, pos, now = Date.now()) {
  const list = bot?._seiUnreachable
  if (!Array.isArray(list) || !list.length || !pos) return false
  prune(list, now)
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
  // Also by dimension, in case a respawn event was missed.
  const dim = dimensionOf(bot)
  return list.some((e) => e.dim === dim && Math.abs(e.x - x) <= COVER_H && Math.abs(e.z - z) <= COVER_H &&
    y - e.y <= COVER_UP && e.y - y <= COVER_DOWN)
}

export function clearUnreachable(bot) {
  if (bot) bot._seiUnreachable = []
}

/**
 * A goTo/dig result that says the target itself could not be reached (as
 * opposed to an abort, or the bot being stuck in a hole, which says nothing
 * about the target).
 */
export function isUnreachableResult(result) {
  const s = String(result ?? '')
  if (!s || s === 'reached' || s.startsWith('aborted')) return false
  if (s.startsWith('stuck in a hole') || s.startsWith('could not climb out')) return false
  return s.startsWith('cant_reach') || s.startsWith('timeout') || s.startsWith('stuck at') || s.startsWith('out of range')
}




