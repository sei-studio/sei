// src/bot/adapter/dontstarve/errors.js — DST connect-error classification
// (contract v2 classifyConnectError). Pure; used by runtime.js before an
// adapter exists and declared on the adapter.
//
// The runtime tags every terminal message with its class as a prefix:
//   GAME_WORLD_NOT_OPEN:   the mod stopped heartbeating (world closed / host quit)
//   GAME_NOT_ANSWERING:    the world is open but the mod never contacted the runtime
//   DST_SPAWN_FAILED:      the mod answered but could not spawn the survivor
//   DST_PORT_IN_USE:       the runtime could not bind a loopback port
//   DST_BODY_DIED:         the survivor died (no client can revive an ownerless body)
// Anything else is a silent stall -> BOT_START_TIMEOUT.

const KNOWN = ['GAME_WORLD_NOT_OPEN', 'GAME_NOT_ANSWERING', 'DST_SPAWN_FAILED', 'DST_PORT_IN_USE', 'DST_BODY_DIED']

/**
 * @param {string} message
 * @returns {'GAME_WORLD_NOT_OPEN'|'GAME_NOT_ANSWERING'|'DST_SPAWN_FAILED'|'DST_PORT_IN_USE'|'DST_BODY_DIED'|'BOT_START_TIMEOUT'}
 */
export function classifyConnectError(message) {
  const m = String(message ?? '')
  for (const k of KNOWN) if (m.startsWith(k)) return k
  return 'BOT_START_TIMEOUT'
}
