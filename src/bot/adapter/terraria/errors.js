// src/bot/adapter/terraria/errors.js — connect-error classification for the
// Terraria runtime (contract v2 classifyConnectError). Pure. The runtime
// tags every terminal message with the class main should surface.

const KNOWN = [
  'GAME_WORLD_NOT_OPEN',
  'GAME_NOT_ANSWERING',
  'GAME_VERSION_UNSUPPORTED',
  'BOT_START_TIMEOUT',
]

/**
 * @param {string} message
 * @returns {'GAME_WORLD_NOT_OPEN'|'GAME_NOT_ANSWERING'|'GAME_VERSION_UNSUPPORTED'|'BOT_START_TIMEOUT'}
 */
export function classifyConnectError(message) {
  const m = String(message ?? '')
  for (const k of KNOWN) {
    if (m.startsWith(k)) return k
  }
  return 'BOT_START_TIMEOUT'
}
