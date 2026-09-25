// src/bot/adapter/stardew/modVersion.js: what the connected SMAPI mod can do,
// read from the version in its welcome/hello. The bundled mod DLL is rebuilt
// on a Mac, so the app can ship prompt text ahead of the mod it describes;
// anything that depends on new mod behavior gates on this.

/** Mod 0.1.2: a trip to another map puts follow on hold instead of ending it, and sleep keeps it. */
export const FOLLOW_HOLD_MIN_MOD = '0.1.2'

/**
 * Mod 0.1.3: the ship and give verbs, water/harvest `scope: "farm"`, the
 * watering can refilling itself mid-round, and the host's activity
 * (`host.holding` / `menu` / `inEvent`) plus `tomorrow` in the observation.
 */
export const CHORES_MIN_MOD = '0.1.3'

/** Verbs an older mod answers with "unknown action"; hidden from the tool list until the mod has them. */
export const CHORES_VERBS = Object.freeze(['ship', 'give'])

function parts(version) {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

/**
 * Is `version` at least `min`? Numeric major.minor.patch; a prerelease tag
 * counts as its release. An unknown or unreadable version is false: the
 * caller keeps the old behavior.
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

/** Does this mod hold follow across a trip and the night (see FOLLOW_HOLD_MIN_MOD)? */
export function modHoldsFollow(version) {
  return modVersionAtLeast(version, FOLLOW_HOLD_MIN_MOD)
}

/** Does this mod have ship / give / farm-wide chores (see CHORES_MIN_MOD)? */
export function modHasChores(version) {
  return modVersionAtLeast(version, CHORES_MIN_MOD)
}
