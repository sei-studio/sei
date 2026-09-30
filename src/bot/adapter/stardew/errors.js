// src/bot/adapter/stardew/errors.js — connect-error classification for the
// Stardew runtime (contract v2 classifyConnectError). Pure.
//
// The runtime tags every terminal message with the ErrorClass it wants main
// to surface, so this only has to read the prefix: GAME_WORLD_NOT_OPEN (no
// save loaded, the game closed, or a farmhand game), GAME_NOT_ANSWERING (the
// mod's port is dead or the token is wrong), STARDEW_FARMHAND_NO_MOD (the
// mod refused to spawn because a farmhand lacks it),
// GAME_VERSION_UNSUPPORTED (protocol mismatch), else BOT_START_TIMEOUT.

const KNOWN = [
  'GAME_WORLD_NOT_OPEN',
  'GAME_NOT_ANSWERING',
  'STARDEW_FARMHAND_NO_MOD',
  'GAME_VERSION_UNSUPPORTED',
  'BOT_START_TIMEOUT',
]

/**
 * @param {string} message
 * @returns {'GAME_WORLD_NOT_OPEN'|'GAME_NOT_ANSWERING'|'STARDEW_FARMHAND_NO_MOD'|'GAME_VERSION_UNSUPPORTED'|'BOT_START_TIMEOUT'}
 */
export function classifyConnectError(message) {
  const m = String(message ?? '')
  for (const k of KNOWN) {
    if (m.startsWith(k)) return k
  }
  return 'BOT_START_TIMEOUT'
}

/** Strip the class prefix ("GAME_NOT_ANSWERING: ...") off a tagged message. */
export function stripClassPrefix(message) {
  return String(message ?? '').replace(/^[A-Z_]+:\s*/, '')
}
