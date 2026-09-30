// src/bot/adapter/minecraft/errors.js — Minecraft connect-error classification
// (contract v2 classifyConnectError, M0 260908). Pure; used by runtime.js
// (before an adapter instance exists) and declared on the adapter.
//
// A dropped live session and an exhausted initial-connect retry both arrive
// tagged "LAN_NOT_OPEN:"; an unsupported world version is
// "UNSUPPORTED_MC_VERSION:"; a Forge/NeoForge world that turns a vanilla
// client away is "MODDED_HOST_REJECTED:"; a silent spawn stall (connect.js's
// wall-clock guard) is a BOT_START_TIMEOUT. Route to the class whose
// ERROR_COPY gives the user the right next step.

/**
 * @param {string} message
 * @returns {'UNSUPPORTED_MC_VERSION'|'MODDED_HOST_REJECTED'|'LAN_NOT_OPEN'|'BOT_START_TIMEOUT'}
 */
export function classifyConnectError(message) {
  const m = String(message ?? '')
  if (m.startsWith('UNSUPPORTED_MC_VERSION')) return 'UNSUPPORTED_MC_VERSION'
  if (m.startsWith('MODDED_HOST_REJECTED')) return 'MODDED_HOST_REJECTED'
  if (m.startsWith('LAN_NOT_OPEN')) return 'LAN_NOT_OPEN'
  return 'BOT_START_TIMEOUT'
}
