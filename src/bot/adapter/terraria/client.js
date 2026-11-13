// src/bot/adapter/terraria/client.js — the link to the Sei companion
// tModLoader mod (native/terraria-mod/PROTOCOL.md). The wire is the same as
// the Stardew mod's (GET /hello, NDJSON over a loopback WebSocket, `result`
// frames by id, `cancel` on abort), so the Stardew client is reused as is;
// only the per-verb timeouts are Terraria's.

import { createStardewClient, fetchHello, nextId } from '../stardew/client.js'

export { fetchHello, nextId }

/** The mod's own job timeout is 90s (60s for place, 45s for craft); this only catches a dead link. */
export const COMMAND_TIMEOUT_MS = 150_000
/** A walk reports progress rarely; anything else that goes quiet this long is stuck. */
export const COMMAND_IDLE_TIMEOUT_MS = 120_000

/** The timeouts for one `cmd` frame. */
export function commandTimeouts() {
  return { timeoutMs: COMMAND_TIMEOUT_MS, idleTimeoutMs: COMMAND_IDLE_TIMEOUT_MS }
}

/** @param {Parameters<typeof createStardewClient>[0]} opts */
export function createTerrariaClient(opts) {
  return createStardewClient(opts)
}
