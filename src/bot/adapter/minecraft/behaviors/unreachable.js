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

import { Vec3 } from 'vec3'

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
export function noteUnreachable(bot, pos, why = '', now = Date.now(), detail = '') {
  const list = store(bot)
  if (!list || !pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return
  prune(list, now)
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
  const dim = dimensionOf(bot)
  const same = list.find((e) => e.x === x && e.y === y && e.z === z && e.dim === dim)
  if (same) {
    same.until = now + UNREACHABLE_TTL_MS
    same.why = why || same.why
    same.detail = detail || same.detail
    same.tries = (same.tries ?? 1) + 1
    same.last = now
    return
  }
  list.push({ x, y, z, dim, why, detail, tries: 1, first: now, last: now, until: now + UNREACHABLE_TTL_MS })
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
}

/** The note covering `pos` (a noted block or close to one: same trunk /
 * vein), or null. */
export function unreachableEntry(bot, pos, now = Date.now()) {
  const list = bot?._seiUnreachable
  if (!Array.isArray(list) || !list.length || !pos) return null
  prune(list, now)
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
  // Also by dimension, in case a respawn event was missed.
  const dim = dimensionOf(bot)
  return list.find((e) => e.dim === dim && Math.abs(e.x - x) <= COVER_H && Math.abs(e.z - z) <= COVER_H &&
    y - e.y <= COVER_UP && e.y - y <= COVER_DOWN) ?? null
}

/** True when `pos` is a noted block or close to one (same trunk / vein). */
export function isUnreachable(bot, pos, now = Date.now()) {
  return unreachableEntry(bot, pos, now) != null
}

/**
 * 261123 (pass 62): the nearest noted block within `radius` (each axis) of
 * `pos`, with its distance, or null. A block a few steps from one she could
 * not reach (the next ore of a buried vein under a river) usually fails the
 * same way, even outside the cover above.
 */
export function nearestUnreachable(bot, pos, radius = 3, now = Date.now()) {
  const list = bot?._seiUnreachable
  if (!Array.isArray(list) || !list.length || !pos) return null
  prune(list, now)
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
  const dim = dimensionOf(bot)
  let best = null
  for (const e of list) {
    if (e.dim !== dim) continue
    if (Math.abs(e.x - x) > radius || Math.abs(e.y - y) > radius || Math.abs(e.z - z) > radius) continue
    const d = Math.hypot(e.x - x, e.y - y, e.z - z)
    if (!best || d < best.d) best = { entry: e, d }
  }
  return best
}

/**
 * 261123 (pass 62): what a failed walk said about the way there, in a few
 * words, for the next try's refusal ("the path kept failing at 159,63,-10").
 */
export function unreachableDetail(result) {
  const s = String(result ?? '')
  const stuck = s.match(/^stuck at (-?\d+,-?\d+,-?\d+)/)
  if (stuck) return `the path kept failing at ${stuck[1]}`
  if (s.startsWith('cant_reach')) return 'there was no path there'
  if (s.startsWith('timeout')) return 'the walk ran out of time close to it'
  if (s.startsWith('out of range')) return 'it stayed out of reach'
  return ''
}

/** "40s" / "2 min" since a note was made. */
export function agoWords(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`
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

const OPEN_NAMES = new Set(['air', 'cave_air', 'void_air', 'water', 'lava'])
/** Nothing there to walk to or dig (air, a liquid, a plant). */
function isOpen(blk) {
  return OPEN_NAMES.has(blk.name) || blk.boundingBox === 'empty'
}
const cell = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

/**
 * 261123 (quality pass 62): a walk or dig aimed at a block she failed to
 * reach in the last few minutes is not tried again. In the 2026-11-23
 * scorecard (gather_craft-02) she walked at the same buried iron under a
 * river five times (cant_reach, then "stuck at" the shore three times, then
 * a dig whose walk stuck too); every walk ended at the water's edge, the
 * last ones in the river, where she stayed stuck for the rest of the
 * session. The refusal says when and how it failed and what works instead.
 * Null when the target is not a noted block (or is gone now).
 */
export function knownUnreachableLine(bot, pos, verb = 'walking there') {
  try {
    if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return null
    const e = unreachableEntry(bot, pos)
    if (!e) return null
    // A block she once stood beside and could not dig (a log high up a
    // trunk) may still be walked to; a failed walk there is what counts.
    if (verb === 'walking there' && e.why === 'out of reach' && (e.tries ?? 1) < 2) return null
    const blk = bot.blockAt?.(new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)))
    if (!blk || isOpen(blk)) return null
    const ago = agoWords(Date.now() - (e.last ?? e.first ?? Date.now()))
    const times = (e.tries ?? 1) > 1 ? `, ${e.tries} tries` : ''
    const exact = e.x === Math.floor(pos.x) && e.y === Math.floor(pos.y) && e.z === Math.floor(pos.z)
    const what = exact ? `the ${blk.name} at ${cell(pos)}` : `${cell(e)}, right by this ${blk.name}`
    return `not ${verb}: you already failed to reach ${what} ${ago} ago (${e.detail || 'no way there'}${times}). ` +
      `The same way fails the same way. Pick a different ${blk.name} (find skips this one) or leave it for now`
  } catch { return null }
}

