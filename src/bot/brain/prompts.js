// Game-agnostic LLM-facing text used to live here; it now lives in the single
// editable prompt document, src/bot/brain/promptLibrary.js. This module is a
// thin barrel that re-exports the brain-level names from there (so every
// existing `import ... from './prompts.js'` keeps working) plus the small
// non-text cadence helpers, which are logic rather than prompt wording.
//
// Edit prompt WORDING in promptLibrary.js, not here.

export {
  // Surface baselines (separately editable; BASELINE_INSTRUCTIONS composes the
  // universal + minecraft halves into the cached system block [0]).
  UNIVERSAL_BASELINE,
  CHAT_BASELINE,
  MINECRAFT_BASELINE,
  BASELINE_INSTRUCTIONS,
  // Per-turn speak reminder + tool / personality text.
  SPEAK_REMINDER,
  GREETING_HINT,
  PERSONALITY_TOOL_DESCRIPTIONS,
  PROACTIVENESS_DIRECTIVES,
  PUNCTUATION_DIRECTIVES,
  SEED_HEADERS,
  NUDGES,
  // Render functions (interpolate runtime values into the prompt text).
  renderPersona,
  renderProactivenessDirective,
  renderPunctuationDirective,
  renderCore,
  renderHeartbeat,
  renderCompanions,
} from './promptLibrary.js'

// 260615: per-tier idle-tick cadence (ms). NOT prompt text — these are the FSM
// idle-timer durations consumed in src/bot/brain/index.js, so they stay here
// rather than in the prompt document. Passive ticks rarely (it only comments),
// Reactive every minute, Agentic fast (5s) so a self-directed character resumes
// its goal almost immediately after finishing a step.
export const IDLE_CADENCE_MS = {
  0: 600_000, // 10 min
  1: 60_000,  // 1 min
  2: 5_000,   // 5 s
}

/** Idle cadence (ms) for a proactiveness level, defaulting to Reactive (1). */
export function idleCadenceMs(proactiveness) {
  const lvl = Number.isInteger(proactiveness) ? proactiveness : 1
  return IDLE_CADENCE_MS[lvl] ?? IDLE_CADENCE_MS[1]
}
