// src/bot/adapter/sts2/stats.js: per-session counters for bot_session_ended
// (shape only: counts, classes and booleans, never card names, chat or
// state text). Posted to main as {type:'sts2-stats'} about every 30 s and at
// the end (runtime.js); main folds them in with an `sts2_` prefix
// (src/main/sts2SessionStats.ts). Pure, no I/O.

/** Every action family (actionFamily) and failure class (failureClass): closed sets for main's props. */
export const ACTION_FAMILIES = Object.freeze(['play_card', 'end_turn', 'potion', 'map', 'reward', 'event', 'shop', 'lobby', 'query', 'other'])
export const FAIL_CLASSES = Object.freeze(['invalid_action', 'bad_args', 'timeout', 'no_link', 'paused', 'rejected'])

/** Action families, so a mod that renames an action does not explode the props. */
export function actionFamily(name) {
  const n = String(name ?? '')
  if (n === 'play_card') return 'play_card'
  if (n === 'end_turn') return 'end_turn'
  if (n === 'use_potion') return 'potion'
  if (/^select_map_node/.test(n)) return 'map'
  if (/^(select_card|claim_reward|collect_all|take_relic|select_bundle|select_multiple_cards|choose_hand_cards)/.test(n)) return 'reward'
  if (/^select_event_option/.test(n)) return 'event'
  if (/^shop_/.test(n)) return 'shop'
  if (/^(select_character|embark)/.test(n)) return 'lobby'
  if (/^query|info$/.test(n)) return 'query'
  return 'other'
}

/** Why an act failed, as a closed class. */
export function failureClass(text) {
  const t = String(text ?? '')
  if (/not available right now|is not one of/.test(t)) return 'invalid_action'
  if (/needs |no card|there is no|no potion|name the/.test(t)) return 'bad_args'
  if (/did not answer|in time/.test(t)) return 'timeout'
  if (/not connected|link (is )?closed/.test(t)) return 'no_link'
  if (/paused/.test(t)) return 'paused'
  return 'rejected'
}

const RUN_END = new Set(['won', 'lost', 'abandoned'])

export function createSts2Stats({ now = () => Date.now() } = {}) {
  let dirty = false
  const startedAt = now()
  const s = {
    acts: 0,
    acts_ok: 0,
    by_family: {},
    failures: {},
    forces: 0,
    wakes: 0,
    nudges: 0,
    batch_max: 0,
    first_act_ms: null,
    combats_won: 0,
    max_floor: 0,
    max_act: 0,
    run_end: null,
    seat_drops: 0,
    host_seen: false,
    structured_state: false,
    coop: false,
    says: 0,
  }
  const bump = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1 }
  return {
    /** @param {string} name @param {boolean} ok @param {string|null} [failText] */
    act(name, ok, failText = null) {
      dirty = true
      s.acts += 1
      bump(s.by_family, actionFamily(name))
      if (ok) {
        s.acts_ok += 1
        if (s.first_act_ms == null) s.first_act_ms = now() - startedAt
      } else bump(s.failures, failureClass(failText))
    },
    batch(n) { if (n > s.batch_max) { s.batch_max = n; dirty = true } },
    force() { s.forces += 1; dirty = true },
    wake() { s.wakes += 1; dirty = true },
    nudge() { s.nudges += 1; dirty = true },
    say() { s.says += 1; dirty = true },
    state(st) {
      if (!st || typeof st !== 'object') return
      s.structured_state = true
      const floor = Number(st.run?.floor)
      const act = Number(st.run?.act)
      if (Number.isFinite(floor) && floor > s.max_floor) { s.max_floor = floor; dirty = true }
      if (Number.isFinite(act) && act > s.max_act) { s.max_act = act; dirty = true }
    },
    event(kind) {
      if (kind === 'combat_won') { s.combats_won += 1; dirty = true }
      if (kind === 'run_won') { s.run_end = 'won'; dirty = true }
      if (kind === 'run_lost') { s.run_end = 'lost'; dirty = true }
      if (kind === 'run_abandoned') { s.run_end = 'abandoned'; dirty = true }
    },
    seatDropped() { s.seat_drops += 1; dirty = true },
    hostSeen() { if (!s.host_seen) { s.host_seen = true; dirty = true } },
    setCoop(on) { if (s.coop !== !!on) { s.coop = !!on; dirty = true } },
    isDirty() { return dirty },
    snapshot() {
      dirty = false
      return {
        ...s,
        by_family: { ...s.by_family },
        failures: { ...s.failures },
        run_end: RUN_END.has(s.run_end) ? s.run_end : null,
      }
    },
  }
}
