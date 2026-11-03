// src/bot/adapter/dontstarve/respawn.js — when a dead DST companion comes
// back (261104).
//
// An ownerless survivor has no client to haunt or be revived, so a death used
// to end the session. Now the runtime removes the corpse and summons a fresh
// body next to the host, up to a cap, unless the spot keeps killing her. This
// module is the pure decision; runtime.js does the despawn and the re-summon.
//
//   death -> respawn          (a fresh body beside the host, after a delay)
//   death -> end 'cap'        (she already came back maxRespawns times)
//   death -> end 'bad_spot'   (she died within quickDeathMs of a respawn,
//                              badSpotStreak times in a row)
//
// A quick death counts only after a RESPAWN, never after the first summon.

export const MAX_RESPAWNS = 3
export const QUICK_DEATH_MS = 20_000
export const BAD_SPOT_STREAK = 2

/**
 * The mod's death cause, safe for analytics: a game id such as `darkness`,
 * `hunger`, `cold`, `spider`. Never the afflicter's label, which can be a
 * player's name.
 * @param {unknown} cause
 * @returns {string}
 */
export function sanitizeDeathCause(cause) {
  const c = typeof cause === 'string' ? cause.trim().toLowerCase() : ''
  return /^[a-z0-9_]{1,32}$/.test(c) && c !== 'nil' ? c : 'unknown'
}

/**
 * @param {{ maxRespawns?: number, quickDeathMs?: number, badSpotStreak?: number, now?: () => number }} [opts]
 */
export function createRespawnPolicy(opts = {}) {
  const maxRespawns = Number.isFinite(opts.maxRespawns) ? Math.max(0, opts.maxRespawns) : MAX_RESPAWNS
  const quickDeathMs = Number.isFinite(opts.quickDeathMs) ? opts.quickDeathMs : QUICK_DEATH_MS
  const badSpotStreak = Number.isFinite(opts.badSpotStreak) ? Math.max(1, opts.badSpotStreak) : BAD_SPOT_STREAK
  const now = typeof opts.now === 'function' ? opts.now : Date.now

  let respawns = 0
  let deaths = 0
  let quickStreak = 0
  let lastRespawnAt = 0
  let lastCause = null

  return {
    /**
     * A body died. What happens next.
     * @param {{ cause?: unknown }} [death]
     * @returns {{ action: 'respawn' } | { action: 'end', reason: 'cap' | 'bad_spot' }}
     */
    onDeath(death = {}) {
      deaths++
      lastCause = sanitizeDeathCause(death?.cause)
      const quick = respawns > 0 && now() - lastRespawnAt < quickDeathMs
      quickStreak = quick ? quickStreak + 1 : 0
      if (quickStreak >= badSpotStreak) return { action: 'end', reason: 'bad_spot' }
      if (respawns >= maxRespawns) return { action: 'end', reason: 'cap' }
      return { action: 'respawn' }
    },
    /** The fresh body is in the world. */
    onRespawned() {
      respawns++
      lastRespawnAt = now()
    },
    get respawns() { return respawns },
    get deaths() { return deaths },
    get lastCause() { return lastCause },
    /** Comebacks left after the current one is used (never negative). */
    get respawnsLeft() { return Math.max(0, maxRespawns - respawns) },
    get maxRespawns() { return maxRespawns },
  }
}

/**
 * Plain words for what killed her, for the prompt and the transcript.
 * `cause` is the game's id (health DoDelta cause or the attacker's prefab),
 * `afflicter` the mod's display label of the attacker.
 * @param {{ cause?: unknown, afflicter?: unknown }} ev
 * @returns {string|null}  e.g. "Charlie in the darkness", "starvation", "Spider"
 */
export function describeDeathCause(ev) {
  const cause = sanitizeDeathCause(ev?.cause)
  const label = typeof ev?.afflicter === 'string' ? ev.afflicter.replace(/[\r\n\t]/g, ' ').trim().slice(0, 40) : ''
  switch (cause) {
    case 'darkness': return 'Charlie in the darkness'
    case 'hunger': return 'starvation'
    case 'cold': return 'freezing'
    case 'hot': return 'overheating'
    case 'drowning': return 'drowning'
    case 'lightning': return 'lightning'
    case 'fire': return 'fire'
    default: break
  }
  if (label) return label
  if (cause !== 'unknown') return cause.replace(/_/g, ' ')
  return null
}
