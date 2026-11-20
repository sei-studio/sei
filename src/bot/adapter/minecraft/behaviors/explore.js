// src/bot/adapter/minecraft/behaviors/explore.js
//
// 260616: `explore` — short directional hop, "like a player walking off to look
// around." goTo to a far target frequently times out as unreachable when the
// destination is across unloaded chunks or up a cliff (260616 playlog: Sui stuck
// at spawn, two goTo timeouts, never moved). A long one-shot pathfind to a
// 40m+ point is the wrong primitive for that — exploration is incremental.
// `explore` walks a SHORT reachable distance (default 16 blocks) in a direction
// RELATIVE to the bot's current facing, which loads new chunks and repositions
// the bot, then auto-looks (renders) in that direction so the model SEES where
// it ended up.
//
// 260617: directions are RELATIVE to current facing (forward/backwards/left/
// right, or an angle 0..360°), matching `look` — not world-absolute compass
// headings. The waypoint and the post-arrival auto-look use the SAME target yaw.
//
// 261108 (quality pass 47). Free play (gather_craft 02-B/03-B) had explore as
// a fifth of the failed actions. Root causes, each fixed below:
//   1. "Forward" was the body's yaw at the moment the action ran, and the gaze
//      controller turns the head to the player all the time. With the player
//      following behind her, "keep going forward" walked her straight back to
//      the base she had just left (03-B A35), and a hop could go any way but
//      the one the model meant (A29 "not north"). Now: compass directions are
//      accepted as such; "forward" continues the last explore's heading while
//      she is still near where it ended; otherwise relative directions are
//      read against the facing her last snapshot SHOWED her (what the model
//      reasoned from), not the live gaze yaw.
//   2. The goal was a 3D point at her own y, 30 blocks off. In hills that
//      point is inside the ground or over a valley, so there was no path at
//      all ("cant_reach (closest=31.5m)", 03-B A19). The goal is now the x,z
//      column, any height.
//   3. One 8s leg for up to 48 blocks: a 32-block hop timed out a third of
//      the way (A29 "10 of 32"). The leg budget now scales with the distance,
//      and like goTo (pass 45) the walk goes on while a timed-out leg was
//      still closing in.
//   4. A blocked first leg gave up (A19, A33). It now tries the headings
//      either side before saying it is blocked, and the result names the
//      way she actually went.
// Explores remember a short trail, and a "forward" that would walk back over
// it turns toward ground she has not walked yet.

import { goTo, timedOutClosingIn, PROGRESS_LEGS } from './pathfind.js'
import { getHealedPos } from '../observers/posHealer.js'
import { orientationToYawOffset, faceYaw, captureFrame } from './visualize.js'
import { yawToUnit } from '../facing.js'

/** World compass headings as ground vectors ([dx, dz], yaw 0 looks down -z). */
export const COMPASS = Object.freeze({
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
})

/** mineflayer yaw that faces ground vector (dx, dz). */
export function yawOf(dx, dz) {
  return Math.atan2(-dx, -dz)
}

const DIR8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']

/** 8-way compass word for a ground displacement. */
export function compassWord(dx, dz) {
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || (dx === 0 && dz === 0)) return 'nowhere'
  // Clockwise angle from north.
  const a = Math.atan2(dx, -dz)
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8
  return DIR8[i]
}

// "forward" continues the last explore while it is this recent and she is
// still this near where it ended.
export const CONTINUE_MS = 3 * 60_000
export const CONTINUE_NEAR_M = 12
// The facing the last snapshot showed counts for relative directions this long.
export const SHOWN_FACING_MS = 90_000
// Trail of explore start/end points, for the "don't walk back" check.
const TRAIL_MAX = 12
const TRAIL_MS = 5 * 60_000
const TRAIL_NEAR_M = 8
const TRAIL_SELF_M = 10
// Leg budget: about walking speed without sprint plus slack for terrain.
const LEG_MS_PER_BLOCK = 300
const LEG_MS_BASE = 2500
const LEG_MS_MIN = 6000
// A hop that moved less than this did not go anywhere.
export const MOVED_MIN_M = 3
// Headings tried when the asked one is blocked, in degrees off it.
const DETOURS_DEG = [40, -40, 80, -80]
const DETOUR_LEG_MS = 6000
const GOAL_RANGE = 3

function hdist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** Human label for the chosen direction, for the result text. */
function dirLabel(args) {
  if (typeof args?.orientation === 'string') return args.orientation.toLowerCase()
  if (typeof args?.angle === 'number' && Number.isFinite(args.angle)) return `${Math.round(args.angle)}°`
  return 'forward'
}

/**
 * The heading an explore call means, as a yaw.
 * @returns {{yaw:number, from:'compass'|'continue'|'shown'|'body', forward:boolean}}
 */
export function resolveHeading(args, bot, pos, now = Date.now()) {
  const o = typeof args?.orientation === 'string' ? args.orientation.toLowerCase() : null
  if (o && COMPASS[o]) {
    const [dx, dz] = COMPASS[o]
    return { yaw: yawOf(dx, dz), from: 'compass', forward: false }
  }
  const offset = orientationToYawOffset(args) ?? 0
  const forward = offset === 0 && (o == null || o === 'forward' || o === 'forwards') &&
    !(typeof args?.angle === 'number' && args.angle % 360 !== 0)
  const last = bot?._seiExplore
  if (forward && last && Number.isFinite(last.yaw) && now - last.at <= CONTINUE_MS &&
      last.end && hdist(pos, last.end) <= CONTINUE_NEAR_M) {
    return { yaw: last.yaw, from: 'continue', forward }
  }
  const shown = bot?._seiShownFacing
  if (shown && Number.isFinite(shown.yaw) && now - shown.at <= SHOWN_FACING_MS) {
    return { yaw: shown.yaw + offset, from: 'shown', forward }
  }
  return { yaw: (bot?.entity?.yaw ?? 0) + offset, from: 'body', forward }
}

/** Recent trail points that are not where she stands now. */
function trailAway(bot, pos, now) {
  const trail = Array.isArray(bot?._seiExplore?.trail) ? bot._seiExplore.trail : []
  return trail.filter((p) => now - p.at <= TRAIL_MS && hdist(p, pos) >= TRAIL_SELF_M)
}

/**
 * A "forward" that is not continuing an explore and would end on ground she
 * already walked turns to the nearest heading that does not. Explicit
 * compass and side directions are kept as asked.
 */
export function avoidTrail(yaw, pos, blocks, bot, now = Date.now()) {
  const trail = trailAway(bot, pos, now)
  if (!trail.length) return { yaw, turned: false }
  const lands = (y) => {
    const [ux, uz] = yawToUnit(y)
    const t = { x: pos.x + ux * blocks, z: pos.z + uz * blocks }
    return trail.some((p) => hdist(p, t) < TRAIL_NEAR_M)
  }
  if (!lands(yaw)) return { yaw, turned: false }
  for (const deg of [45, -45, 90, -90, 135, -135]) {
    const y = yaw + deg * Math.PI / 180
    if (!lands(y)) return { yaw: y, turned: true }
  }
  return { yaw, turned: false }
}

/** Per-leg time budget for a hop of `blocks`. */
export function legBudgetMs(blocks, cap = 12000) {
  return Math.max(LEG_MS_MIN, Math.min(cap, Math.round(blocks * LEG_MS_PER_BLOCK + LEG_MS_BASE)))
}

/**
 * Walk toward the x,z point `blocks` out along `yaw`, walking on while each
 * timed-out leg still closed in (the goTo rule from pass 45).
 */
async function hop(bot, pos, yaw, blocks, legMs, signal, walk) {
  const [ux, uz] = yawToUnit(yaw)
  const tx = Math.round(pos.x + ux * blocks)
  const tz = Math.round(pos.z + uz * blocks)
  const ty = Math.round(pos.y)
  const distToTarget = () => {
    const p = bot.entity?.position
    return p ? Math.hypot(p.x - tx, p.z - tz) : NaN
  }
  let before = distToTarget()
  let r = await walk(bot, tx, ty, tz, GOAL_RANGE, legMs, signal, { xz: true })
  for (let leg = 0; leg < PROGRESS_LEGS && !signal?.aborted && r !== 'aborted'; leg++) {
    const after = distToTarget()
    if (!timedOutClosingIn(r, before, after)) break
    before = after
    r = await walk(bot, tx, ty, tz, GOAL_RANGE, legMs, signal, { xz: true })
  }
  return r
}

function recordExplore(bot, start, end, yaw) {
  const now = Date.now()
  const prev = Array.isArray(bot._seiExplore?.trail) ? bot._seiExplore.trail : []
  const trail = [...prev, { x: start.x, z: start.z, at: now }, { x: end.x, z: end.z, at: now }]
    .filter((p) => now - p.at <= TRAIL_MS)
    .slice(-TRAIL_MAX)
  bot._seiExplore = { yaw, end: { x: end.x, z: end.z }, at: now, trail }
}

/**
 * @param {{orientation?:string, angle?:number, blocks?:number}} args
 * @param {object} bot
 * @param {object} config
 * @param {{vision?:boolean, walk?:Function}} [opts]  vision:true ⇒ auto-look after the hop.
 */
export async function exploreAction(args, bot, config, opts = {}) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  const walk = opts.walk ?? goTo
  const p0 = getHealedPos(bot) ?? bot.entity?.position
  if (!p0 || !Number.isFinite(p0.x)) return 'no_bot'
  const pos = { x: p0.x, y: p0.y, z: p0.z }

  const blocks = Math.max(4, Math.min(48, args?.blocks ?? 16))
  const label = dirLabel(args)

  const heading = resolveHeading(args, bot, pos)
  let targetYaw = heading.yaw
  let turnedOffTrail = false
  if (heading.forward && heading.from !== 'continue') {
    const t = avoidTrail(targetYaw, pos, blocks, bot)
    targetYaw = t.yaw
    turnedOffTrail = t.turned
  }

  const legMs = legBudgetMs(blocks, config?.pathfinder_timeout_ms ?? 12000)
  let result = await hop(bot, pos, targetYaw, blocks, legMs, signal, walk)
  if (result === 'aborted' || signal?.aborted) return 'aborted'

  const here = () => getHealedPos(bot) ?? bot.entity?.position
  const movedFrom = () => {
    const n = here()
    return n ? Math.hypot(n.x - pos.x, n.z - pos.z) : 0
  }

  // Blocked straight ahead: try the headings either side before giving up.
  const tried = []
  let travelYaw = targetYaw
  if (movedFrom() < MOVED_MIN_M) {
    const asked = targetYaw
    for (const deg of DETOURS_DEG) {
      const y = asked + deg * Math.PI / 180
      const [dx, dz] = yawToUnit(y)
      tried.push(compassWord(dx, dz))
      const r = await hop(bot, pos, y, Math.max(8, Math.round(blocks * 0.75)), Math.min(legMs, DETOUR_LEG_MS), signal, walk)
      if (r === 'aborted' || signal?.aborted) return 'aborted'
      if (movedFrom() >= MOVED_MIN_M) { travelYaw = y; result = r; break }
    }
  }

  const now = here()
  const moved = Math.round(movedFrom())
  const [ax, az] = yawToUnit(targetYaw)
  const askedWord = compassWord(ax, az)
  const labelWord = heading.from === 'compass' ? askedWord : `${askedWord} (${label})`
  let text
  if (moved >= MOVED_MIN_M && now) {
    const went = compassWord(now.x - pos.x, now.z - pos.z)
    const notes = []
    if (travelYaw !== targetYaw) notes.push(`${askedWord} was blocked`)
    else if (went !== askedWord) notes.push(`asked ${askedWord}${heading.from === 'compass' ? '' : `, ${label}`}`)
    else if (heading.from !== 'compass') notes.push(label)
    if (turnedOffTrail) notes.push('straight on led back over ground you already walked, so you turned')
    if (moved < blocks * 0.6 && !String(result).startsWith('reached')) {
      notes.push(`${blocks} asked, the rest did not path: ${String(result).split(' ')[0]}`)
    }
    const note = notes.length ? ` (${notes.join('; ')})` : ''
    text = `explored ${moved} blocks ${went}${note}, now at ${Math.round(now.x)},${Math.round(now.y)},${Math.round(now.z)} — new terrain loaded`
    recordExplore(bot, pos, now, travelYaw)
  } else {
    const also = tried.length ? `; also tried ${tried.join(', ')}` : ''
    text = `couldn't move ${labelWord} (${result})${also} — blocked; try a different direction or dig/scaffold through`
  }

  // Auto-look in the direction we explored so the model SEES the result (only
  // when the provider supports vision — explore is registered for every
  // provider, but a non-VLM one can't use the image). Face the target yaw first
  // (pathfinding may have re-aimed the head mid-walk). Best-effort: a degrade
  // or abort just returns the text.
  if (opts?.vision && config?.vision?.mode !== 'off' && !signal?.aborted) {
    await faceYaw(bot, travelYaw)
    if (!signal?.aborted) {
      // Never hold explore for a cold render stack: degrade to text instead.
      const f = await captureFrame(bot, config, { loadWaitMs: 0 })
      if (f && typeof f === 'object' && f.ok) {
        return { text, image: { mediaType: f.mediaType, dataBase64: f.dataBase64 } }
      }
    }
  }
  return text
}
