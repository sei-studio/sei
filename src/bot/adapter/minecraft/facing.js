// src/bot/adapter/minecraft/facing.js
//
// Yaw ↔ world-axis grammar. Pure: no mineflayer, no natives, safe to import
// from the observer path (which is why it is not in visualize.js — that module
// statically imports renderPov, which pulls in native gl/canvas).
//
// 260803. The bot had no facing ANYWHERE: not in the snapshot, not in the
// result of look({orientation}). So "behind you", "to your left" and "that
// island over there" were unanswerable questions, and look({orientation:
// "backward"}) silently rotated the bot 180° without telling it which way it
// now pointed. Live (260731 Nether log): asked to bridge to an island directly
// behind her, the model turned around, rendered a frame it could not place on
// any axis, and INVENTED a span 12 blocks off its own body — then died in lava
// walking to it. This module is the answer to "which way is that".
//
// ONE CONVENTION, STATED ONCE. A mineflayer yaw's ground vector is
//   [dx, dz] = (-sin yaw, -cos yaw)
// and its inverse is yaw = atan2(-dx, -dz). Both appear already in gaze.js
// (aimAt), survival.js, reflex.js and the povRenderer camera — this module is
// where they get a name. Under it, INCREASING yaw turns LEFT, yaw 0 looks down
// -z (north), and the CLOCKWISE cardinal order is -z, +x, +z, -x.

/**
 * The four cardinals in CLOCKWISE order starting at north, so `(i + 1) % 4` is
 * "turn right" and `(i + 2) % 4` is "turn around". That ordering is the whole
 * data structure: it is what makes `facingFrame` four modular additions.
 */
export const CARDINALS = Object.freeze([
  Object.freeze({ axis: '-z', compass: 'north', dx: 0, dz: -1 }),
  Object.freeze({ axis: '+x', compass: 'east', dx: 1, dz: 0 }),
  Object.freeze({ axis: '+z', compass: 'south', dx: 0, dz: 1 }),
  Object.freeze({ axis: '-x', compass: 'west', dx: -1, dz: 0 }),
])

/** Unit ground vector [dx, dz] for a mineflayer yaw. */
export function yawToUnit(yaw) {
  return [-Math.sin(yaw), -Math.cos(yaw)]
}

/**
 * Index into CARDINALS for the cardinal NEAREST `yaw`. A diagonal facing snaps
 * to the closer of its two neighbours; an exact 45° tie rounds CLOCKWISE
 * (northeast → east). Snapping rather than reporting "northeast" is deliberate
 * for now: every consumer of this (build spans, the look grammar, the player's
 * "over there") is axis-aligned, so a diagonal answer would have to be resolved
 * to an axis by the model, which is the guessing this module exists to remove.
 */
export function cardinalIndexFromYaw(yaw) {
  if (!Number.isFinite(yaw)) return 0
  const [dx, dz] = yawToUnit(yaw)
  // Clockwise angle from north, measured in quarter turns.
  const quarters = Math.atan2(dx, -dz) / (Math.PI / 2)
  return ((Math.round(quarters) % 4) + 4) % 4
}

/** The cardinal the bot is facing. */
export function cardinalFromYaw(yaw) {
  return CARDINALS[cardinalIndexFromYaw(yaw)]
}

/**
 * Resolve the four RELATIVE directions the tool grammar already speaks
 * (forward / right / backward / left, the keys of visualize.js's
 * ORIENTATION_DEG) into world axes. "Build a bridge behind you" and
 * `look({orientation:"backward"})` are the same question; this is the answer to
 * both, and it is what lets the model turn a pointed-at direction into a span.
 *
 * @returns {{forward:object, right:object, backward:object, left:object}}
 */
export function facingFrame(yaw) {
  const i = cardinalIndexFromYaw(yaw)
  return {
    forward: CARDINALS[i],
    right: CARDINALS[(i + 1) % 4],
    backward: CARDINALS[(i + 2) % 4],
    left: CARDINALS[(i + 3) % 4],
  }
}

/**
 * One snapshot line. Leads with the compass name (which the model has strong
 * priors about) and then spells out all four relative directions as signed
 * axes, so "behind you" is a lookup rather than a derivation:
 *
 *   facing: north. forward -z, back +z, left -x, right +x
 *
 * @param {ReturnType<typeof facingFrame>} frame
 */
export function facingLine(frame) {
  if (!frame?.forward) return 'unknown'
  return `${frame.forward.compass}. forward ${frame.forward.axis}, back ${frame.backward.axis}, left ${frame.left.axis}, right ${frame.right.axis}`
}
