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
import { weaponScore } from './behaviors/weaponSelect.js'

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
export const DEATH_LOST_WEAPON =
  ' That includes your {weapon}, so you have no weapon until you get it back: your swings do 1 damage, so keep out of fights and stay close to the player.'

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
  const cause = deathCauseSentence(data)
  if (data?.keptAll === true) return DEATH_ADDENDUM_KEPT.replace('{cause}', () => cause)
  if (Array.isArray(data?.lost) && data.lost.length === 0) return DEATH_ADDENDUM_EMPTY.replace('{cause}', () => cause)
  const lost = lostSentence(data)
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
