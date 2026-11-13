// src/bot/adapter/terraria/modVersion.js — the protocol this adapter speaks.
// The welcome/hello frame carries the mod's `protocol`; a mod that speaks a
// newer major than this is refused with GAME_VERSION_UNSUPPORTED so an old
// app never drives a body it does not understand.

export const PROTOCOL_VERSION = 1

/** @param {unknown} protocol  hello.protocol */
export function protocolSupported(protocol) {
  const p = Number(protocol)
  return Number.isFinite(p) && p >= 1 && p <= PROTOCOL_VERSION
}
