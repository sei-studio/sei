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

// ── Death event framing (sei:death) ──────────────────────────────────────
// This prose lives HERE rather than in promptLibrary.js's EVENT_GUIDANCE (where
// its peers — sei:idle / sei:loop_end / sei:attacked — live) purely for merge
// hygiene: the death→brain event was added while promptLibrary.js was owned by a
// concurrent change, so the small, adapter-specific death text rides in the
// barrel wrapper below instead. If/when things settle, this can move into
// EVENT_GUIDANCE with the other events.
export const DEATH_ADDENDUM_WITH_POS =
  '\n\nYou DIED and respawned at the world spawn.{cause} Everything you were carrying dropped where you died (~{x},{y},{z}) — it despawns in about 5 minutes. Your health and hunger are full again. React in character in ONE short say() line, and decide whether to go recover your items (head back toward those coords) or let them go.'
export const DEATH_ADDENDUM_NO_POS =
  '\n\nYou DIED and respawned at the world spawn.{cause} Everything you were carrying dropped where you died — it despawns in about 5 minutes. Your health and hunger are full again. React in character in ONE short say() line, and decide whether to go recover your items or let them go.'

// 260708: name the cause of death when the brain knows the last real hit
// (src/bot/brain/index.js attaches `lastAttack` when a hit landed within 30s
// of the death). Without this the model has no idea what killed it and
// confabulates confusion ("i have literally no idea what just happened") even
// mid-PvP-spar.
function deathCauseSentence(data) {
  const la = data?.lastAttack
  if (!la || !la.label) return ''
  const when = Number.isFinite(la.secondsBefore)
    ? `${la.secondsBefore}s before you died`
    : 'moments before you died'
  if (la.kind === 'player' && la.pvp) {
    return ` ${la.label} killed you in your PvP spar (their hit landed ${when}). You knew this fight was on; react to losing the round, not to a mystery.`
  }
  return ` The last thing that hit you was ${la.label} (${when}), so that is almost certainly what killed you.`
}

function deathAddendum(data) {
  const p = data?.pos
  const cause = deathCauseSentence(data)
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
    return DEATH_ADDENDUM_WITH_POS
      .replace('{cause}', cause)
      .replace('{x}', String(Math.round(p.x)))
      .replace('{y}', String(Math.round(p.y)))
      .replace('{z}', String(Math.round(p.z)))
  }
  return DEATH_ADDENDUM_NO_POS.replace('{cause}', cause)
}

// Wrap the shared eventAddendum so a 'sei:death' event gets its framing (the
// base function returns '' for events absent from EVENT_GUIDANCE). Everything
// else delegates unchanged, preserving the existing barrel surface.
export function eventAddendum(event, data, visionMode = 'on-demand') {
  if (event === 'sei:death') return deathAddendum(data)
  return baseEventAddendum(event, data, visionMode)
}
