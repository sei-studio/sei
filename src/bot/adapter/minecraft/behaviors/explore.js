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
// it ended up. It reuses goTo under a shorter timeout — a short hop is almost
// always reachable, so it makes real progress instead of freezing.
//
// 260617: directions are RELATIVE to current facing (forward/backwards/left/
// right, or an angle 0..360°), matching `look` — not world-absolute compass
// headings. The waypoint and the post-arrival auto-look use the SAME target yaw.

import { goTo } from './pathfind.js'
import { getHealedPos } from '../observers/posHealer.js'
import { orientationToYawOffset, yawToUnit, faceYaw, captureFrame } from './visualize.js'

/** Human label for the chosen direction, for the result text. */
function dirLabel(args) {
  if (typeof args?.orientation === 'string') return args.orientation.toLowerCase()
  if (typeof args?.angle === 'number' && Number.isFinite(args.angle)) return `${Math.round(args.angle)}°`
  return 'forward'
}

/**
 * @param {{orientation?:string, angle?:number, blocks?:number}} args
 * @param {object} bot
 * @param {object} config
 * @param {{vision?:boolean}} [opts]  vision:true ⇒ auto-look after the hop.
 */
export async function exploreAction(args, bot, config, opts = {}) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  const pos = getHealedPos(bot) ?? bot.entity?.position
  if (!pos || !Number.isFinite(pos.x)) return 'no_bot'

  const blocks = Math.max(4, Math.min(48, args?.blocks ?? 16))
  const label = dirLabel(args)

  // Direction relative to current facing (offset null ⇒ forward / 0°).
  const baseYaw = bot.entity?.yaw ?? 0
  const targetYaw = baseYaw + (orientationToYawOffset(args) ?? 0)
  const [ux, uz] = yawToUnit(targetYaw)

  const wx = Math.round(pos.x + ux * blocks)
  const wz = Math.round(pos.z + uz * blocks)
  const wy = Math.round(pos.y)
  // Cap the hop's timeout below the global pathfinder budget — a short reachable
  // walk shouldn't burn the full 12s, and if it can't path we want to bail and
  // let the model try another direction quickly.
  const timeoutMs = Math.min(config?.pathfinder_timeout_ms ?? 12000, 8000)
  const result = await goTo(bot, wx, wy, wz, 3, timeoutMs, signal)
  if (result === 'aborted') return 'aborted'

  const now = getHealedPos(bot) ?? bot.entity?.position
  const moved = now ? Math.round(Math.hypot(now.x - pos.x, now.z - pos.z)) : 0
  const text = moved >= 3
    ? `explored ${moved} blocks ${label}, now at ${Math.round(now.x)},${Math.round(now.y)},${Math.round(now.z)} — new terrain loaded`
    : `couldn't move ${label} (${result}) — blocked; try a different direction or dig/scaffold through`

  // Auto-look in the direction we explored so the model SEES the result (only
  // when the provider supports vision — explore is registered for every
  // provider, but a non-VLM one can't use the image). Face the target yaw first
  // (pathfinding may have re-aimed the head mid-walk). Best-effort: a degrade
  // or abort just returns the text.
  if (opts?.vision && config?.vision?.mode !== 'off' && !signal?.aborted) {
    await faceYaw(bot, targetYaw)
    if (!signal?.aborted) {
      const f = await captureFrame(bot, config)
      if (f && typeof f === 'object' && f.ok) {
        return { text, image: { mediaType: f.mediaType, dataBase64: f.dataBase64 } }
      }
    }
  }
  return text
}
