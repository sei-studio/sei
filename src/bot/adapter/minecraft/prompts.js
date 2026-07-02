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
  eventAddendum,
  cantReachNudge,
} from '../../brain/promptLibrary.js'
