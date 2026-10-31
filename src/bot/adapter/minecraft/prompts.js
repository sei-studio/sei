// Minecraft-specific LLM-facing text used to live here; it now lives in the
// single editable prompt document, src/bot/brain/promptLibrary.js. This module
// is a thin barrel that re-exports the minecraft-level names from there, so
// every existing `import ... from './prompts.js'` in the adapter keeps working.
//
// Edit prompt WORDING in promptLibrary.js, not here.

export {
  // Raw text blocks.
  WORLD_PRIMER,
  CAPABILITY_PARAGRAPH,
  SEEING_SENTENCE_VISION,
  SEEING_SENTENCE_NOVISION,
  ACTION_RULES,
  SEEING_RULE_VISION,
  SEEING_RULE_NOVISION,
  PATHFINDER_RULE_VISION,
  PATHFINDER_RULE_NOVISION,
  CUBOID_GRAMMAR,
  ACTION_DESCRIPTIONS,
  EXPLORE_DESCRIPTION_NOVISION,
  ATTACKED_ADDENDUM,
  EVENT_GUIDANCE,
  // Looking-mode-aware assembly functions (the adapter's public surface).
  worldPrimer,
  capabilityParagraph,
  actionRules,
  cuboidGrammar,
  describeAction,
  cantReachNudge,
} from '../../brain/promptLibrary.js'

import { eventAddendum as baseEventAddendum } from '../../brain/promptLibrary.js'
import { weaponScore, dimLabel } from './behaviors/weaponSelect.js'

// ── Death event framing (sei:death) ──────────────────────────────────────
// This prose lives HERE rather than in promptLibrary.js's EVENT_GUIDANCE (where
// its peers — sei:idle / sei:loop_end / sei:attacked — live) purely for merge
// hygiene: the death→brain event was added while promptLibrary.js was owned by a
// concurrent change, so the small, adapter-specific death text rides in the
// barrel wrapper below instead. If/when things settle, this can move into
// EVENT_GUIDANCE with the other events.
// 261019 (quality pass 19): the death framing names what she lost, uses the
// game's own death message as the cause when chat.js saw it, and says how the
// drops show up again (item(...) entries in the nearby entities, pickup walks
// onto them). Before this she was told "everything you were carrying dropped"
// without the list, then tried to eat bread that was lying on the ground and
// fought bare-handed without noticing her sword was gone. The death is now
// reported after the respawn (behaviors/deathTracker.js), so the snapshot in
// the same turn shows her real, current inventory.
const REACT_LINE =
  'React in character in ONE short say() line: how you feel about dying, in your own voice, not a report of what happened or of your plan.'

export const DEATH_ADDENDUM_WITH_POS =
  '\n\nYou DIED and respawned at the world spawn. Your health and food are full again.{cause}{lost} ' + REACT_LINE + ' Then decide whether to go back for your things or let them go. The drops lie where you died, around {x},{y},{z}, and despawn about 5 minutes after the death. Once you are close to that spot they show up as item(...) entries in your nearby entities with their exact positions, and pickup walks onto them (it searches 16 blocks by default, up to 32). Whatever killed you may still be there.'
export const DEATH_ADDENDUM_NO_POS =
  '\n\nYou DIED and respawned at the world spawn. Your health and food are full again.{cause}{lost} ' + REACT_LINE + ' Then decide whether to go back for your things or let them go. The drops lie where you died and despawn about 5 minutes after the death; near that spot they show up as item(...) entries in your nearby entities, and pickup walks onto them.'
export const DEATH_ADDENDUM_KEPT =
  '\n\nYou DIED and respawned at the world spawn. Your health and food are full again.{cause} This world keeps inventories on death, so you still have everything you were carrying. ' + REACT_LINE + ' Then carry on.'
export const DEATH_ADDENDUM_EMPTY =
  '\n\nYou DIED and respawned at the world spawn. Your health and food are full again.{cause} You were not carrying anything, so nothing dropped. ' + REACT_LINE + ' Then carry on.'
// 261031 (quality pass 33): nothing dropped this time, but the weapon from an
// earlier death still lies on the ground ({earlier}, DEATH_EARLIER_WEAPON).
export const DEATH_ADDENDUM_EMPTY_EARLIER =
  '\n\nYou DIED and respawned at the world spawn. Your health and food are full again.{cause} You were not carrying anything this time.{earlier} ' + REACT_LINE + ' Then decide whether to go back for it.'

const LOST_LIST_MAX = 12

/** "bread x5, stone_sword, oak_planks x3" (items carry their tool names). */
export function formatLostItems(lost) {
  if (!Array.isArray(lost)) return ''
  const rows = lost.filter((r) => r && typeof r.item === 'string' && r.item && Number.isFinite(r.n) && r.n > 0)
  const shown = rows.slice(0, LOST_LIST_MAX).map((r) => (r.n > 1 ? `${r.item} x${r.n}` : r.item))
  const more = rows.length - shown.length
  return shown.join(', ') + (more > 0 ? `, and ${more} more kinds of item` : '')
}

// 260708: name the cause of death when the brain knows the last real hit
// (src/bot/brain/index.js attaches `lastAttack` when a hit landed within 30s
// of the death). Without this the model has no idea what killed it and
// confabulates confusion ("i have literally no idea what just happened") even
// mid-PvP-spar. 261019: the game's death message wins when there is one.
function deathCauseSentence(data) {
  const la = data?.lastAttack
  const text = typeof data?.deathText === 'string' && data.deathText ? data.deathText : null
  const pvp = la && la.label && la.kind === 'player' && la.pvp
  if (text) {
    return ` The game reported: "${text}".` + (pvp ? ` That was your PvP spar with ${la.label}; you knew this fight was on, so react to losing the round, not to a mystery.` : '')
  }
  if (!la || !la.label) return ''
  const when = Number.isFinite(la.secondsBefore)
    ? `${la.secondsBefore}s before you died`
    : 'moments before you died'
  if (pvp) {
    return ` ${la.label} killed you in your PvP spar (their hit landed ${when}). You knew this fight was on; react to losing the round, not to a mystery.`
  }
  return ` The last thing that hit you was ${la.label} (${when}), so that is almost certainly what killed you.`
}

// 261030 (quality pass 31): a death that dropped her weapon. Told only "your
// health and food are full again", she fought the next mob bare-handed and
// died again (combat_night eval: 13 of 18 deaths in the two worst runs came
// after an earlier death had taken her sword).
// 261031 (quality pass 33): "keep out of fights and stay close to the player"
// sent her after the player, who was where the mobs were, and away from the
// sword lying a few blocks off (combat_night eval: 7 and 15 deaths in two
// runs). Getting the weapon back is now the plan it names.
export const DEATH_LOST_WEAPON =
  ' That includes your {weapon}, so you have no weapon until you get it back, and your swings do 1 damage. Picking it back up is the quickest way to be armed again; keep out of fights until you have it.'
// 261031 (quality pass 33): a later death while the weapon from an earlier
// one still lies on the ground (deathTracker earlierWeapon). The death turn
// said "nothing dropped" and she forgot it.
export const DEATH_EARLIER_WEAPON =
  ' Your {weapon} from an earlier death is still on the ground{dim} near {x},{y},{z}{dist} for about {minutes} more minutes, and you have no weapon until you get it back.'
// 261031 (quality pass 33): the count of recent deaths (deathTracker
// recentDeaths), so a fifth death does not read like the first one.
export const DEATH_RECENT_COUNT = ' You have died {count} times in the last {minutes} minutes.'

function recentDeathsSentence(data) {
  const r = data?.recentDeaths
  if (!r || !(r.count > 1) || !Number.isFinite(r.minutes)) return ''
  const text = r.minutes === 1 ? DEATH_RECENT_COUNT.replace('the last {minutes} minutes', 'the last minute') : DEATH_RECENT_COUNT
  return text.replace('{count}', String(r.count)).replace('{minutes}', String(r.minutes))
}

function earlierWeaponSentence(data) {
  const w = data?.earlierWeapon
  if (!w || typeof w.weapon !== 'string' || !(w.minutesLeft > 0)) return ''
  const p = w.pos
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    return ` Your ${w.weapon} from an earlier death is still on the ground where you died then, and you have no weapon until you get it back.`
  }
  // 261031 (pass 33 review): a drop in another dimension has no distance
  // from her; it names the dimension instead of "(? blocks from you)".
  return DEATH_EARLIER_WEAPON
    .replace('{weapon}', w.weapon)
    .replace('{dim}', typeof w.otherDim === 'string' ? ` in ${dimLabel(w.otherDim)}` : '')
    .replace('{x}', String(p.x)).replace('{y}', String(p.y)).replace('{z}', String(p.z))
    .replace('{dist}', Number.isFinite(w.dist) ? ` (${w.dist} blocks from you)` : '')
    .replace('{minutes}', String(w.minutesLeft))
}

function lostSentence(data) {
  const list = formatLostItems(data?.lost)
  if (list) {
    const weapon = (Array.isArray(data?.lost) ? data.lost : [])
      .filter((r) => r && typeof r.item === 'string' && weaponScore(r.item) > 0)
      .sort((a, b) => weaponScore(b.item) - weaponScore(a.item))[0]?.item
    const lostWeapon = weapon ? DEATH_LOST_WEAPON.replace('{weapon}', weapon) : ''
    return ` Everything you were carrying dropped: ${list}. You do not have any of it now, so you cannot eat, equip, place or give those items until you pick them back up; your inventory in the snapshot is what you really have.${lostWeapon}`
  }
  // Older adapters (and a death whose inventory could not be read) carry no list.
  return ' Everything you were carrying dropped where you died; your inventory in the snapshot is what you really have now.'
}

export function deathAddendum(data) {
  const p = data?.pos
  // 261031 (pass 33): the recent-death count rides with the cause, and a
  // weapon still lying from an earlier death with what dropped this time.
  const cause = deathCauseSentence(data) + recentDeathsSentence(data)
  const earlier = earlierWeaponSentence(data)
  if (data?.keptAll === true) return DEATH_ADDENDUM_KEPT.replace('{cause}', () => cause)
  if (Array.isArray(data?.lost) && data.lost.length === 0) {
    if (earlier) return DEATH_ADDENDUM_EMPTY_EARLIER.replace('{cause}', () => cause).replace('{earlier}', () => earlier)
    return DEATH_ADDENDUM_EMPTY.replace('{cause}', () => cause)
  }
  const lost = lostSentence(data) + earlier
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
    return DEATH_ADDENDUM_WITH_POS
      .replace('{cause}', () => cause)
      .replace('{lost}', () => lost)
      .replace('{x}', String(Math.round(p.x)))
      .replace('{y}', String(Math.round(p.y)))
      .replace('{z}', String(Math.round(p.z)))
  }
  return DEATH_ADDENDUM_NO_POS.replace('{cause}', () => cause).replace('{lost}', () => lost)
}

// Wrap the shared eventAddendum so a 'sei:death' event gets its framing (the
// base function returns '' for events absent from EVENT_GUIDANCE). Everything
// else delegates unchanged, preserving the existing barrel surface.
export function eventAddendum(event, data, visionMode = 'on-demand') {
  if (event === 'sei:death') return deathAddendum(data)
  return baseEventAddendum(event, data, visionMode)
}
