// src/bot/adapter/dontstarve/observers/alerts.js: the situations a good
// Don't Starve partner notices without being asked (260926).
//
// The mod's reflexes already ACT at frame rate (light, fuel, gear, defend,
// heal, eat; native/dst-mod/sei/scripts/sei/reflexes.lua). What they cannot
// do is plan or talk, so this watcher reads the observation state and names
// the situations that deserve a decision or a word from the brain:
//
//   wake   (P1, through onAttacked attackerKind 'reflex'): starving with no
//          food, health low, freezing or overheating
//   nudge  (P3 idle tick with reason 'alert'): dusk with no way to make light,
//          sanity low, the player hungry, the season about to turn
//   note   (snapshot only): a creature attacking a player
//
// computeAlerts() is pure (state in, list out) and also feeds the snapshot's
// heads_up line. createAlertWatcher() adds the edge + cooldown bookkeeping so
// one situation wakes the brain once, not on every 3 Hz frame.

const LIGHT_PREFABS = new Set(['torch', 'lantern', 'minerhat', 'molehat'])

/** Alert tuning. Percent thresholds are fractions of the meter's max. */
export const ALERT_TUNING = Object.freeze({
  starvingPct: 0.15,
  lowHealthPct: 0.35,
  lowSanityPct: 0.3,
  playerHungryPct: 0.25,
  seasonDaysLeft: 2,
  hostileNearM: 10,
  cooldownMs: { wake: 60_000, nudge: 180_000 },
})

const NEXT_SEASON = { autumn: 'winter', winter: 'spring', spring: 'summer', summer: 'autumn' }

function frac(cur, max) {
  return max > 0 ? cur / max : 1
}

function count(self, prefab) {
  let n = 0
  for (const it of [...(self.inv ?? []), ...Object.values(self.equip ?? {})]) {
    if (it.prefab === prefab) n += it.qty ?? 1
  }
  return n
}

function isHostile(e) {
  return (e.flags?.includes('hostile') || e.flags?.includes('monster')) && e.flags.includes('combat')
}

/**
 * What the body's light habit has to work with (mod 0.3.0 reflexes.lua
 * LightAction/DuskPrep): a light it carries, the makings of a torch or a
 * campfire, or a fire burning within sight.
 * @returns {{ carried: boolean, makings: boolean, fireNear: boolean, any: boolean }}
 */
export function lightMeans(state) {
  const self = state?.self
  if (!self) return { carried: false, makings: false, fireNear: false, any: false }
  const all = [...(self.inv ?? []), ...Object.values(self.equip ?? {})]
  const carried = all.some((it) => LIGHT_PREFABS.has(it.prefab))
  const grass = count(self, 'cutgrass')
  const makings = (grass >= 2 && count(self, 'twigs') >= 2) || (grass >= 3 && count(self, 'log') >= 2)
  const ents = state.nearby ? state.nearby() : [...(state.ents?.values?.() ?? [])]
  const fireNear = ents.some((e) => e.flags?.includes('burning') && (e.flags.includes('fire') || e.prefab === 'campfire' || e.prefab === 'firepit'))
  return { carried, makings, fireNear, any: carried || makings || fireNear }
}

/** Distance helper that tolerates a bare state object in tests. */
function distOf(state, e) {
  if (typeof state.distTo === 'function') return state.distTo(e)
  const s = state.self
  if (!s || typeof e.x !== 'number' || typeof s.x !== 'number') return Infinity
  return Math.hypot(e.x - s.x, e.z - s.z)
}

/**
 * @param {object} state  the observation state (protocol.js createObservationState)
 * @returns {Array<{key: string, level: 'wake'|'nudge'|'note', text: string}>}
 */
export function computeAlerts(state) {
  const self = state?.self
  const world = state?.world
  if (!self || !world || self.dead) return []
  const out = []
  const ents = state.nearby ? state.nearby() : [...(state.ents?.values?.() ?? [])]
  const hasFood = (self.inv ?? []).some((it) => it.flags?.includes('eat'))
  const hungerF = frac(self.hunger, self.hungerMax)
  const hpF = frac(self.hp, self.hpMax)
  const sanF = frac(self.sanity, self.sanityMax)

  if (hungerF < ALERT_TUNING.starvingPct && !hasFood) {
    out.push({ key: 'starving', level: 'wake', text: `you are starving (hunger ${Math.round(hungerF * 100)}%) and carry nothing you can eat` })
  }
  // Low health NEAR hostiles is the mod's retreat reflex (it reports that
  // itself); this is the quiet case: hurt, nothing attacking, time to heal.
  const hostileNear = ents.some((e) => isHostile(e) && distOf(state, e) <= ALERT_TUNING.hostileNearM)
  if (hpF < ALERT_TUNING.lowHealthPct && !hostileNear) {
    out.push({ key: 'low_health', level: 'wake', text: `your health is low (${Math.round(hpF * 100)}%)` })
  }
  if (self.freezing) out.push({ key: 'freezing', level: 'wake', text: 'you are freezing and losing health' })
  if (self.overheating) out.push({ key: 'overheating', level: 'wake', text: 'you are overheating and losing health' })

  if (world.phase === 'dusk' && !world.caves && !lightMeans(state).any) {
    out.push({ key: 'dusk_no_light', level: 'nudge', text: 'dusk, and you have no torch, nothing to make one or a campfire with, and no fire in sight' })
  }
  if (sanF < ALERT_TUNING.lowSanityPct) {
    out.push({ key: 'low_sanity', level: 'nudge', text: `your sanity is low (${Math.round(sanF * 100)}%): shadow creatures are close to attacking` })
  }
  if (typeof world.seasonDays === 'number' && world.seasonDays <= ALERT_TUNING.seasonDaysLeft && NEXT_SEASON[world.season]) {
    const days = Math.max(0, Math.round(world.seasonDays))
    const when = days <= 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`
    out.push({ key: `season_${world.season}_${world.day}`, level: 'nudge', text: `${NEXT_SEASON[world.season]} starts ${when}` })
  }

  for (const e of ents) {
    const isPlayer = e.flags?.includes('player') && !e.flags.includes('companion')
    if (isPlayer && typeof e.hungerPct === 'number' && e.hungerPct < ALERT_TUNING.playerHungryPct) {
      out.push({ key: `player_hungry_${e.guid}`, level: 'nudge', text: `${e.name ?? 'the player'} is hungry (${Math.round(e.hungerPct * 100)}%)` })
    }
    if (e.target != null && !e.flags?.includes('player')) {
      const victim = state.ents?.get?.(e.target)
      if (victim && victim.flags?.includes('player') && !victim.flags.includes('companion')) {
        out.push({ key: `player_attacked_${e.guid}`, level: 'note', text: `${e.prefab} is attacking ${victim.name ?? 'the player'}` })
      }
    }
  }
  return out
}

/**
 * Edge-triggered alerts with a per-key cooldown: an alert fires when it
 * APPEARS (absent on the previous check) and its key has not fired within
 * the cooldown for its level. Notes never fire.
 *
 * @param {object} args
 * @param {object} args.state
 * @param {(alert: {key: string, level: string, text: string}) => void} args.onWake
 * @param {(alert: {key: string, level: string, text: string}) => void} args.onNudge
 * @param {() => number} [args.now]
 */
export function createAlertWatcher({ state, onWake, onNudge, now = Date.now }) {
  let active = new Set()
  const lastFired = new Map()
  return {
    /** Re-read the state; fire what just appeared. Returns what fired. */
    check() {
      const alerts = computeAlerts(state)
      const next = new Set(alerts.map((a) => a.key))
      const fired = []
      const t = now()
      for (const a of alerts) {
        if (a.level === 'note' || active.has(a.key)) continue
        const cooldown = ALERT_TUNING.cooldownMs[a.level] ?? 60_000
        const last = lastFired.get(a.key)
        if (last != null && t - last < cooldown) continue
        lastFired.set(a.key, t)
        fired.push(a)
        if (a.level === 'wake') onWake?.(a)
        else onNudge?.(a)
      }
      active = next
      return fired
    },
    reset() {
      active = new Set()
      lastFired.clear()
    },
  }
}
