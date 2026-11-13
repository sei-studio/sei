// src/bot/adapter/terraria/stats.js: shape-only session counters for the
// Terraria surface (verb outcomes by failure class, reflex and fight events,
// world alerts). The runtime posts a cumulative snapshot up the port as
// {type:'terraria-stats'}; main folds the last one into bot_session_ended
// (src/main/games/terraria/sessionStats.ts). Counts and closed enums only:
// no item names beyond the verb, no coordinates, no chat.

export const FAIL_CLASSES = Object.freeze([
  'no_path', 'missing_materials', 'no_tool', 'target_not_found', 'timeout', 'aborted', 'knocked_out', 'refused', 'error',
])

export const REFLEX_KINDS = Object.freeze(['fight', 'healed', 'retreat', 'low_health', 'knocked_out'])

export const ALERT_KINDS = Object.freeze(['boss_spawn', 'boss_defeated', 'invasion', 'blood_moon', 'player_died'])

/**
 * The failure class of one verb result. These are the mod's own fixed result
 * strings (native/terraria-mod/SeiCompanion/Actions/Verbs.cs), not model text.
 * @param {string} text  the registry result ("failed: ..." or a success line)
 * @returns {string|null} a FAIL_CLASSES member, or null for success
 */
export function classifyTerrariaResult(text) {
  const s = String(text ?? '').trim().toLowerCase()
  if (!s.startsWith('failed:') && s !== 'aborted' && !s.startsWith('paused:')) return null
  if (s === 'aborted' || s.startsWith('paused:') || /superseded|cancelled|stopped by/.test(s)) return 'aborted'
  if (/knocked out/.test(s)) return 'knocked_out'
  if (/timed out|gave up after|still walking after|still up after|for 20s|made no progress/.test(s)) return 'timeout'
  if (/no way to get there|could not reach|stuck|no room/.test(s)) return 'no_path'
  if (/i have no (axe|pickaxe|weapon)/.test(s)) return 'no_tool'
  if (/cannot craft|missing |i have no |no longer have|i have to stand next to/.test(s)) return 'missing_materials'
  if (/no player|nobody|no tree|no exposed|nothing |there is no |the items are gone|left; stopped|do not know/.test(s)) return 'target_not_found'
  if (/error|exception/.test(s)) return 'error'
  return 'refused'
}

const VERB_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

export function createTerrariaStats() {
  /** verb -> { n, ok, fail: {class: n} } */
  const verbs = new Map()
  const reflex = Object.fromEntries(REFLEX_KINDS.map((k) => [k, 0]))
  const alerts = Object.fromEntries(ALERT_KINDS.map((k) => [k, 0]))
  let dirty = false

  return {
    verb(name, resultText) {
      if (!VERB_RE.test(String(name))) return
      const v = verbs.get(name) ?? { n: 0, ok: 0, fail: {} }
      v.n += 1
      const cls = classifyTerrariaResult(resultText)
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
    alert(kind) {
      if (!(kind in alerts)) return
      alerts[kind] += 1
      dirty = true
    },
    isDirty() { return dirty },
    snapshot() {
      dirty = false
      return {
        verbs: Object.fromEntries([...verbs].map(([k, v]) => [k, { n: v.n, ok: v.ok, fail: { ...v.fail } }])),
        reflex: { ...reflex },
        alerts: { ...alerts },
      }
    },
  }
}

/** A pushed mod frame as a reflex counter kind, or null. */
export function reflexKindOf(frame) {
  switch (frame?.t) {
    case 'survival':
      return frame.kind === 'healed' ? 'healed' : frame.kind === 'retreating' ? 'retreat' : frame.kind === 'low_health' ? 'low_health' : null
    case 'death': return 'knocked_out'
    default: return null
  }
}
