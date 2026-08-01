// src/observers/aggro.js — who the hostiles in this fight are actually on.
//
// 260731. The companion had no way to see the thing the player complains about
// ("the mobs are all on me"): the snapshot listed nearby entities with coords
// and nothing else, so a zombie hitting the player and a zombie wandering past
// read identically. This tallies them.
//
// There is no target field on the wire — a server never tells a client which
// player a mob has acquired — so this is an INFERENCE from body yaw. A mob
// pursuing someone faces them, so the mob is attributed to whichever of the two
// of us sits inside its facing cone (nearest angle wins when both do). A mob
// facing neither of us is counted `unclear` rather than guessed at, which is
// what keeps a milling-around skeleton out of the tally.
//
// It is deliberately a two-way tally and not a threat list: the useful fact is
// the IMBALANCE. Aggro in Minecraft is acquired-then-sticky and only damage
// re-points it (HurtByTargetGoal), so "3 on them, 0 on you" is the cue to swing,
// and no amount of standing nearby changes the number.

import { HOSTILE_MOBS } from '../behaviors/hostiles.js'

// How far a mob can be from either of us and still count as part of this fight.
// Wider than melee on purpose (a skeleton shooting the player from 14 blocks is
// very much on them), tighter than the 64-block entity radius so the tally
// describes the fight rather than the chunk.
export const AGGRO_RADIUS = 16

// Full width of the facing cone that reads as "locked on", in degrees. 60 is
// forgiving enough to survive the yaw jitter of a mob stepping around a block
// and tight enough that two people standing apart cannot both be inside it.
export const AGGRO_CONE_DEG = 60

// The tally is only reported when the player is this close. Comparing "on you"
// against "on them" says nothing when they are in another cave: the two sets of
// mobs are unrelated, and printing the comparison anyway invites the model to
// narrate a fight it is not in.
export const AGGRO_PAIR_RANGE = 24

const COS_HALF_CONE = Math.cos((AGGRO_CONE_DEG / 2) * (Math.PI / 180))

// Horizontal only: mob body yaw is a compass bearing, and a spider on a ledge
// above the player is still chasing the player. Convention matches gaze.js /
// reflex.js — mineflayer yaw runs so that forward is (-sin yaw, -cos yaw).
function facingDot(mob, targetPos) {
  const yaw = mob?.yaw
  if (!Number.isFinite(yaw)) return null
  const dx = targetPos.x - mob.position.x
  const dz = targetPos.z - mob.position.z
  const len = Math.hypot(dx, dz)
  if (!Number.isFinite(len)) return null
  if (len === 0) return 1
  return (dx * -Math.sin(yaw) + dz * -Math.cos(yaw)) / len
}

function dist2d(a, b) {
  const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  return Number.isFinite(d) ? d : Infinity
}

function finitePos(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

/**
 * Attribute nearby hostiles to the bot, the owner, or neither. Counts are kept
 * BY MOB NAME — "zombie 2x" is a different situation from "creeper 2x", and the
 * names are already what the model reasons with everywhere else.
 *
 * Pure — takes plain positions so it is testable without a bot.
 *
 * @param {{ mobs: Array<object>, selfPos: {x:number,y:number,z:number}, ownerPos: {x:number,y:number,z:number}, radius?: number }} args
 * @returns {{ onSelf: Record<string,number>, onOwner: Record<string,number>, unclear: number, total: number }}
 */
export function tallyAggro({ mobs, selfPos, ownerPos, radius = AGGRO_RADIUS }) {
  const out = { onSelf: {}, onOwner: {}, unclear: 0, total: 0 }
  if (!finitePos(selfPos) || !finitePos(ownerPos) || !Array.isArray(mobs)) return out
  const bump = (side, name) => { side[name] = (side[name] ?? 0) + 1 }

  for (const m of mobs) {
    if (!m || !HOSTILE_MOBS.has(m.name)) continue
    if (!finitePos(m.position)) continue
    const dSelf = dist2d(m.position, selfPos)
    const dOwner = dist2d(m.position, ownerPos)
    if (dSelf > radius && dOwner > radius) continue

    out.total += 1
    // A mob can only be chasing someone it is near enough to chase.
    const selfDot = dSelf <= radius ? facingDot(m, selfPos) : null
    const ownerDot = dOwner <= radius ? facingDot(m, ownerPos) : null
    const selfLocked = selfDot != null && selfDot >= COS_HALF_CONE
    const ownerLocked = ownerDot != null && ownerDot >= COS_HALF_CONE

    if (selfLocked && ownerLocked) {
      // Both inside the cone. That means we are standing close together, or the
      // mob is lined up with both of us, and the angle cannot separate them —
      // the collinear case makes both dots exactly 1. Give it to whoever it
      // reaches first, which is the one that gets hit.
      bump(dSelf <= dOwner ? out.onSelf : out.onOwner, m.name)
    } else if (selfLocked) bump(out.onSelf, m.name)
    else if (ownerLocked) bump(out.onOwner, m.name)
    else out.unclear += 1
  }
  return out
}

function renderSide(counts) {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} ${n}x`)
  return parts.length ? parts.join(' ') : 'none'
}

/**
 * Render the tally as one snapshot line, or null when no hostile is in the
 * fight. Counts only: what to DO about them is the capability prompt's job, and
 * repeating it on every tick is how a line stops being read.
 *
 * @param {{ tally: ReturnType<typeof tallyAggro>, ownerLabel: string }} args
 * @returns {string|null}
 */
export function aggroLine({ tally, ownerLabel }) {
  if (!tally || tally.total <= 0) return null
  const who = ownerLabel || 'the player'
  return `aggro: ${renderSide(tally.onSelf)} on you, ${renderSide(tally.onOwner)} on ${who}`
}
