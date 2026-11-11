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

import { isDeadEntity, msSinceDeath, sameNameDeathAge, isGoneOrDead, recentLossByName } from './entities.js'
import { resolveEntity, getHandles } from './targeting.js'
import { staleAttackerAddendum, sameNameDeathEvent, staleTurnReason } from '../../../brain/promptLibrary.js'

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

const MOB_KINDS = new Set(['mob', 'hostile_mob', 'other', 'defend', 'reflex'])

/**
 * 261111 (quality pass 51): the sentence added to a hit / defend / heads-up
 * event whose live mob has the same name as one that died near her moments
 * ago, else ''. combat_night evals: "drowned's down alex" while a second
 * drowned was hitting the player, "zombie's dead alex" with a live one a
 * block away.
 */
export function sameNameEventNote(bot, event, data) {
  if (event !== 'sei:attacked' || !data || typeof data !== 'object') return ''
  if (!MOB_KINDS.has(data.attackerKind) || data.survivalKind) return ''
  const mob = data.attacker
  if (!mob || typeof mob !== 'object' || mob.username || mob.type === 'player') return ''
  let age = null
  try { age = sameNameDeathAge(bot, mob) } catch { age = null }
  if (age == null) return ''
  const label = data.attackerLabel && data.attackerLabel !== 'unknown' ? data.attackerLabel : (mob.name ?? 'mob')
  return ` ${sameNameDeathEvent(label, age)}`
}

/**
 * 261111 (quality pass 51): whether a hit event belongs to the fight she last
 * spoke about (the orchestrator's "you already told the player about this
 * fight"). A different mob while the one that fight was about has died or is
 * gone is a new fight. Same mob, or the old one still around (two at once),
 * is the same fight. Unknown ids keep the old answer (same fight).
 */
export function sameFight(bot, prevMobId, data) {
  const id = data?.attacker?.id
  if (prevMobId == null || id == null || id === prevMobId) return true
  try { return !isGoneOrDead(bot, prevMobId) } catch { return true }
}

/**
 * 261111 (quality pass 51): a turn that attacks a mob which died (or
 * vanished) while the turn was being written. A model call takes 1-2s and a
 * fight often ends inside it: her own running attack, the automatic swing or
 * the player lands the kill. The turn then said "zombie on me, swinging" or
 * "i'm hitting it now" and its attackEntity came back "no zombie within 16
 * blocks" (combat_night evals 11-06 to 11-10: 10 such calls in 18 runs, 7 of
 * them and 4 of their lines judged off). Returns { reason } for the first
 * attackEntity (or find of a mob name) in the batch whose target is gone and whose loss happened
 * after `sinceMs` (when the turn's snapshot was taken), else null. A name
 * that still finds a live mob in range is not stale.
 *
 * @param {any} bot
 * @param {Array<{name: string, input?: any}>} toolUses
 * @param {number} sinceMs epoch ms
 * @returns {{ reason: string } | null}
 */
export function staleFightTurn(bot, toolUses, sinceMs) {
  if (!Array.isArray(toolUses) || !Number.isFinite(sinceMs)) return null
  const now = Date.now()
  const window = now - sinceMs
  if (!(window >= 0)) return null
  for (const u of toolUses) {
    const args = u?.input && typeof u.input === 'object' ? u.input : {}
    // find() looks for blocks, but a turn that answers "spider!!" with
    // find({name:'spider'}) + "on it" is about the mob all the same (pass 51
    // probe: 4/16 such turns after the spider died during the call). Only a
    // mob name with a loss in the window counts, and any live mob of that name
    // in view keeps the turn.
    if (u?.name === 'find' && typeof args.name === 'string') {
      const want = args.name.toLowerCase()
      const alive = Object.values(bot?.entities ?? {}).some((e) => e && e !== bot.entity
        && String(e.name ?? '').toLowerCase() === want && !isDeadEntity(bot, e))
      if (alive) continue
      let loss = null
      try { loss = recentLossByName(bot, want, { withinMs: window }) } catch { loss = null }
      if (loss) return { reason: staleTurnReason(want, loss.died, loss.age) }
      continue
    }
    if (u?.name !== 'attackEntity') continue
    let live = null
    try { live = resolveEntity(args, bot) } catch { live = null }
    if (live && !isDeadEntity(bot, live)) continue
    let name = null
    let loss = null
    const handle = typeof args.target === 'string' && args.target.startsWith('#') ? args.target : null
    if (handle) {
      const h = getHandles().get(handle)
      const id = h?.kind === 'entity' ? h.entityId : null
      const d = id != null ? bot?._seiRecentLosses?.get(id) : null
      if (d && now - d.at <= window) { name = d.name; loss = { died: d.died, age: now - d.at } }
    } else {
      name = typeof args.entity === 'string' ? args.entity : (typeof args.target === 'string' ? args.target : null)
      if (name) {
        try { loss = recentLossByName(bot, name, { withinMs: window }) } catch { loss = null }
      }
    }
    if (!loss || !name) continue
    return { reason: staleTurnReason(name, loss.died, loss.age) }
  }
  return null
}
