// src/bot/adapter/dontstarve/errors.js — DST connect-error classification
// (contract v2 classifyConnectError). Pure; used by runtime.js before an
// adapter exists and declared on the adapter.
//
// The runtime tags every terminal message with its class as a prefix:
//   GAME_WORLD_NOT_OPEN:   the mod stopped heartbeating (world closed / host quit)
//   GAME_NOT_ANSWERING:    the world is open but the mod never contacted the runtime
//   DST_SPAWN_FAILED:      the mod answered but could not spawn the survivor
//   DST_PORT_IN_USE:       the runtime could not bind a loopback port
//   DST_BODY_DIED:         the survivor died and could not be brought back
//                          (no host to respawn beside, or no new body in time)
//   DST_DIED_TOO_OFTEN:    died again after the session's respawns were used (261104)
//   DST_DANGEROUS_SPOT:    died right after a respawn, twice in a row (261104)
// Anything else is a silent stall -> BOT_START_TIMEOUT.

const KNOWN = ['GAME_WORLD_NOT_OPEN', 'GAME_NOT_ANSWERING', 'DST_SPAWN_FAILED', 'DST_PORT_IN_USE', 'DST_BODY_DIED', 'DST_DIED_TOO_OFTEN', 'DST_DANGEROUS_SPOT']

/**
 * @param {string} message
 * @returns {'GAME_WORLD_NOT_OPEN'|'GAME_NOT_ANSWERING'|'DST_SPAWN_FAILED'|'DST_PORT_IN_USE'|'DST_BODY_DIED'|'DST_DIED_TOO_OFTEN'|'DST_DANGEROUS_SPOT'|'BOT_START_TIMEOUT'}
 */
export function classifyConnectError(message) {
  const m = String(message ?? '')
  for (const k of KNOWN) if (m.startsWith(k)) return k
  return 'BOT_START_TIMEOUT'
}
