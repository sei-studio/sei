// src/bot/adapter/sts2/errors.js: connect-error classification for the Slay
// the Spire 2 runtime (contract v2 classifyConnectError). Pure.
//
// GAME_WORLD_NOT_OPEN: no companion game window connected in time, or it
// closed under a live session. GAME_NOT_ANSWERING: something connected but
// never finished the startup. GAME_VERSION_UNSUPPORTED: the mod speaks a
// different sei/hello protocol. Else BOT_START_TIMEOUT.

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
