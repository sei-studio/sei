// src/bot/adapter/dontstarve/modVersion.js: what the connected DST helper mod
// can do, read from the version it reports in its `spawned` event (mod 0.3.0
// and later; older mods send no version and read as legacy).
//
// The app and the mod update separately: the mod is copied into the game's
// mods folder on launch, but DST loads mods once at game start, so a world
// that was already running keeps the old helper until it restarts. Anything
// the adapter says or does that depends on new mod behavior gates on this.

/** Mod 0.3.0: give command, night/combat/self-care reflexes, richer perception. */
export const CAPS_MIN_MOD = '0.3.0'

function parts(version) {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

/**
 * Is `version` at least `min`? Numeric major.minor.patch. An unknown or
 * unreadable version is false: the caller keeps the old behavior.
 */
export function modVersionAtLeast(version, min) {
  const a = parts(version)
  const b = parts(min)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}

/** Does this mod run the 0.3.0 capability set (see CAPS_MIN_MOD)? */
export function modHasCaps(version) {
  return modVersionAtLeast(version, CAPS_MIN_MOD)
}
