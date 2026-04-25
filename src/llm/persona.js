// src/llm/persona.js — pure functions, no I/O
const TONE_LINES = {
  friendly:  'Speak warmly and casually, like a friend hanging out. Keep it brief.',
  sarcastic: 'Speak with dry wit and gentle sarcasm. Keep it brief.',
  serious:   'Speak directly and matter-of-factly. No filler. Keep it brief.',
  curious:   'Speak with genuine curiosity, asking small questions when natural. Keep it brief.',
}

/**
 * Render the persona block as a single text string for the cached system prefix.
 * Stable per-session: any byte change invalidates the Anthropic prompt cache.
 * @param {{name:string, backstory:string, tone:'friendly'|'sarcastic'|'serious'|'curious'}} persona
 * @returns {string}
 */
export function renderPersona(persona) {
  return [
    `You are ${persona.name}, a Minecraft companion.`,
    `Backstory: ${persona.backstory}`,
    `Tone: ${TONE_LINES[persona.tone]}`,
  ].join('\n')
}

/**
 * Pre-rendered cap-hit chat line, persona-tone aware (D-12 — must NOT call LLM).
 * @param {{tone:string}} persona
 */
export function capHitLine(persona) {
  switch (persona.tone) {
    case 'sarcastic': return 'okay, brain melting — taking five.'
    case 'serious':   return 'Pausing — thought loop detected.'
    case 'curious':   return 'huh — getting tangled up. let me reset.'
    default:          return 'hmm, getting dizzy — let me catch my breath.'
  }
}
