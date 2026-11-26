// src/bot/adapter/minecraft/observers/nearPlayer.js
//
// 261123 (quality pass 61): where the companion is relative to a player who
// just spoke, for the brain's repeated-ask check (ownRepeats.js
// repeatedAskTurn). A player who keeps saying "stay close" while she stands
// next to them is asking for something already being done; this reads that
// from state (distance, her follow on them), never from their words.

import { ownerDistanceBlocks } from './snapshot.js'
import { getFollowTargetLabel } from '../behaviors/follow.js'

/**
 * @param {object} bot  mineflayer bot
 * @param {string} name  the speaker's in-game name
 * @param {{ followLabel?: () => string|null }} [opts]  test seam
 * @returns {{ distance: number|null, following: boolean } | null}
 *   null when no such player is known; distance null when either entity is
 *   not loaded (out of range).
 */
export function playerNearby(bot, name, { followLabel = getFollowTargetLabel } = {}) {
  if (!bot || !name) return null
  const players = bot.players || {}
  const lc = String(name).toLowerCase()
  const key = players[name] ? name : Object.keys(players).find((n) => n.toLowerCase() === lc)
  if (!key) return null
  let distance = null
  try { distance = ownerDistanceBlocks(players[key]?.entity?.position, bot.entity?.position) } catch { distance = null }
  let following = false
  try { following = String(followLabel() ?? '').toLowerCase() === key.toLowerCase() } catch { following = false }
  return { distance, following }
}
