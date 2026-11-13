// src/bot/adapter/factorio/stats.js: shape-only session counters for the
// Factorio surface (verb outcomes by failure class, reflex events, link
// trouble). The runtime posts a cumulative snapshot up the port as
// {type:'factorio-stats'}; main folds the last one into bot_session_ended
// (src/main/factorioSessionStats.ts). Counts and closed enums only: no item
// names beyond the verb, no coordinates, no chat.

export const FAIL_CLASSES = Object.freeze([
  'no_path', 'missing_materials', 'target_not_found', 'not_researched', 'inventory_full',
  'timeout', 'aborted', 'dead', 'refused', 'error',
])

export const REFLEX_KINDS = Object.freeze(['fight', 'hit', 'retreat', 'safe', 'no_ammo', 'death', 'respawn', 'rescue', 'owner_away'])

/**
 * The failure class of one verb result. These are the mod's own fixed result
 * strings (scripts/verbs.lua, api.lua), not model text.
 * @param {string} text  the registry result ("failed: ..." or a success line)
 * @returns {string|null} a FAIL_CLASSES member, or null for success
 */
export function classifyFactorioResult(text) {
  const s = String(text ?? '').trim().toLowerCase()
  if (!s.startsWith('failed:') && s !== 'aborted' && !s.startsWith('paused:')) return null
  if (s === 'aborted' || s.startsWith('paused:') || /stopped by the app|told to stop|superseded|cancelled/.test(s)) return 'aborted'
  if (/i am dead|retreating/.test(s)) return 'dead'
  if (/ran out of time|ran too long|no answer from factorio|not answering/.test(s)) return 'timeout'
  if (/not researched|is not available|first needs|unlocks by/.test(s)) return 'not_researched'
  // "(or my inventory is full)" is a hedge on an empty-chest result, not the cause.
  if (/my inventory is full(?!\))|the player's inventory is full/.test(s)) return 'inventory_full'
  if (/no path|could not walk|stuck|pathfinder|could not get close|could not reach|tiles short/.test(s)) return 'no_path'
  if (/missing |i have no |have none|cannot craft|need items i do not have|short of/.test(s)) return 'missing_materials'
  if (/nothing with handle|nothing there|^failed: no .* in the |no .* to mine|no ghosts|there is no |it is gone|cannot see the player|is empty/.test(s)) return 'target_not_found'
  if (/^failed: error/.test(s)) return 'error'
  return 'refused'
}

const VERB_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

export function createFactorioStats() {
  /** verb -> { n, ok, fail: {class: n} } */
  const verbs = new Map()
  const reflex = Object.fromEntries(REFLEX_KINDS.map((k) => [k, 0]))
  let linkTimeouts = 0
  let respawnsByApp = 0
  let dirty = false

  return {
    verb(name, resultText) {
      if (!VERB_RE.test(String(name))) return
      const v = verbs.get(name) ?? { n: 0, ok: 0, fail: {} }
      v.n += 1
      const cls = classifyFactorioResult(resultText)
      if (cls) v.fail[cls] = (v.fail[cls] ?? 0) + 1
      else v.ok += 1
      verbs.set(name, v)
      dirty = true
    },
    reflex(kind) {
      if (!(kind in reflex)) return
      reflex[kind] += 1
      dirty = true
    },
    linkTimeout() { linkTimeouts += 1; dirty = true },
    respawnedByApp() { respawnsByApp += 1; dirty = true },
    isDirty() { return dirty },
    snapshot() {
      dirty = false
      return {
        verbs: Object.fromEntries([...verbs].map(([k, v]) => [k, { n: v.n, ok: v.ok, fail: { ...v.fail } }])),
        reflex: { ...reflex },
        link_timeouts: linkTimeouts,
        app_respawns: respawnsByApp,
      }
    },
  }
}

/** Map a feed event to a reflex counter kind, or null. */
export function reflexKindOf(ev) {
  switch (ev?.t) {
    case 'fight': return 'fight'
    case 'hit': return 'hit'
    case 'death': return 'death'
    case 'respawned': return 'respawn'
    case 'rescued': return 'rescue'
    case 'owner_away': return 'owner_away'
    case 'survival':
      return ev.kind === 'retreat' ? 'retreat' : ev.kind === 'safe' ? 'safe' : ev.kind === 'no_ammo' ? 'no_ammo' : null
    default: return null
  }
}
