// src/bot/adapter/factorio/errors.js: connect-error classification for the
// Factorio runtime (contract v2 classifyConnectError). Pure.
//
// The runtime tags every terminal message with the ErrorClass main should
// surface: GAME_NOT_ANSWERING (no answer on the UDP port: the game is not
// running, the mod is off, or Factorio was started without
// --enable-lua-udp), GAME_WORLD_NOT_OPEN (the game closed under a live
// session), GAME_VERSION_UNSUPPORTED (protocol mismatch), else
// BOT_START_TIMEOUT.

const KNOWN = [
  'GAME_WORLD_NOT_OPEN',
  'GAME_NOT_ANSWERING',
  'GAME_VERSION_UNSUPPORTED',
  'BOT_START_TIMEOUT',
]

/** @param {string} message */
export function classifyConnectError(message) {
  const m = String(message ?? '')
  for (const k of KNOWN) {
    if (m.startsWith(k)) return k
  }
  return 'BOT_START_TIMEOUT'
}
