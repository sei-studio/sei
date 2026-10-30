// 261019 (quality pass 18): attack events whose mob is gone by the time the
// turn reads them.
//
// A hit, defend or heads-up event carries the live mob entity, but it is
// rendered into a turn later: after the call that was in flight, or after the
// queue drained. In the combat_night eval the mob was often dead by then (her
// own swing, the chained fight or the player killed it), the event text still
// said "Call attackEntity on it now", and the call came back "no zombie within
// 16 blocks". The text is chosen when the turn is written, so this checks the
// mob at that moment and swaps in a plain "it is gone" line.

import { isDeadEntity, msSinceDeath } from './entities.js'
import { staleAttackerAddendum } from '../../../brain/promptLibrary.js'

/**
 * The replacement event text when the event's mob has died or left her view,
 * else null (render the normal text). Player attackers and survival takeovers
 * (no mob to fight) are never replaced.
 *
 * @param {any} bot
 * @param {string} event
 * @param {any} data  the onAttacked payload (fsmWires)
 * @returns {string|null}
 */
export function staleAttackerText(bot, event, data) {
  if (event !== 'sei:attacked' || !data || typeof data !== 'object') return null
  const kind = data.attackerKind
  // 261030 (pass 31): her own hits arrive as 'hostile_mob' (combat.js), which
  // this check used to skip, so a hit by a mob that died before the turn
  // still read "... hit you" and she attacked a dead mob.
  if (kind !== 'mob' && kind !== 'hostile_mob' && kind !== 'other' && kind !== 'defend' && kind !== 'reflex') return null
  if (data.survivalKind) return null
  const mob = data.attacker
  if (!mob || typeof mob !== 'object' || mob.username || mob.type === 'player') return null
  const died = isDeadEntity(bot, mob) || msSinceDeath(bot, mob.id) != null
  const gone = mob.isValid === false
  if (!died && !gone) return null
  const label = data.attackerLabel && data.attackerLabel !== 'unknown' ? data.attackerLabel : (mob.name ?? 'mob')
  const who = kind === 'defend' ? (data.ownerLabel || 'the player') : 'you'
  return staleAttackerAddendum(label, who, died)
}
