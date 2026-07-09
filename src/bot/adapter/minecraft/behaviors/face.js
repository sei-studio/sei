// src/behaviors/face.js — face what you act on (260708).
//
// The avatar should visibly TURN (yaw + pitch) toward a block before breaking
// or using it, the way a player does. Most mineflayer primitives already
// smooth-look at their target (dig, placeBlock via generic_place,
// activateBlock, containers, craft-with-table all await an internal
// bot.lookAt(..., false)), so this module fills the two real gaps:
//
//   1. mineflayer-pathfinder's path-clearing digs call `bot.dig(block, true)`
//      — forceLook=true snaps the head instantly, so on other players'
//      screens the bot appears to mine walls it never turned toward. Most of
//      the visible mining in a cave trip is exactly these digs.
//   2. mineflayer's smooth look resolves only when the sent yaw converges on
//      the target ('move'-event check) — knockback or a physics hiccup can
//      stall that promise. Anything that awaits a turn needs a bound.
//
// faceBlock() is the bounded smooth turn; installFaceOnDig() wraps bot.dig so
// EVERY dig path (our digAction, gather/mineVein via digAction, and the
// pathfinder's own digs) turns before swinging. After the bounded turn the
// wrapped dig passes forceLook=true, making mineflayer's internal lookAt an
// instant no-op — already aimed, or snapping the tail of an interrupted turn —
// so a dig can never wedge behind an unconverged look.
import { Vec3 } from 'vec3'

/** Upper bound on the visible turn. Default physics yaw speed is ~172°/s, so
 * a worst-case half-turn converges in ~1s; past this we snap the remainder
 * (see installFaceOnDig) rather than stall the action. */
export const FACE_TIMEOUT_MS = 1100

/**
 * Smoothly face the center of the block at `position` (yaw AND pitch),
 * bounded by `timeoutMs`. Resolves when aimed or when the bound expires —
 * never rejects, never hangs. Accepts a Vec3 or a plain {x,y,z}.
 */
export async function faceBlock(bot, position, timeoutMs = FACE_TIMEOUT_MS) {
  if (!position) return
  const p = typeof position.offset === 'function'
    ? position.offset(0.5, 0.5, 0.5)
    : new Vec3(position.x + 0.5, position.y + 0.5, position.z + 0.5)
  let timer = null
  try {
    await Promise.race([
      bot.lookAt(p, false),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
    ])
  } catch {
    /* best-effort — facing must never fail the action that asked for it */
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Wrap bot.dig so every dig — including the pathfinder's instant-snap
 * path-clearing digs — visibly turns to the block first. Idempotent (respawn
 * re-runs the spawn behaviors; wrapping twice would double the turn wait).
 * forceLook === 'ignore' is passed through untouched: a caller that opted out
 * of looking entirely keeps that contract.
 */
export function installFaceOnDig(bot) {
  if (bot._seiFaceOnDig) return
  const rawDig = bot.dig.bind(bot)
  bot.dig = async (block, forceLook, digFace) => {
    if (forceLook !== 'ignore' && block?.position) {
      await faceBlock(bot, block.position)
    }
    return rawDig(block, forceLook === 'ignore' ? 'ignore' : true, digFace)
  }
  bot._seiFaceOnDig = true
}
