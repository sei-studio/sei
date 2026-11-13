// src/bot/adapter/terraria/dashboard/telemetry.js — dashboard telemetry for
// a Terraria body (contract v2 createTelemetry). While the renderer watches,
// one snapshot per second: {game:'terraria', x, y, health, weapon, armor,
// bag, activity, time, layer}. Nothing is emitted while nobody watches.

import { parseBagEntry } from '../observers/snapshot.js'

const DEFAULT_INTERVAL_MS = 1_000

/** Lowercase natural-language activity line (activityLabel.js contract). */
export function activityLabel(name, args) {
  if (!name) return 'idling'
  const a = args ?? {}
  switch (name) {
    case 'thinking': return 'thinking'
    case 'goTo': return 'walking...'
    case 'come': return 'coming to you...'
    case 'follow': return 'following you'
    case 'unfollow': return 'idling'
    case 'stance': return `stance: ${a.mode ?? 'defensive'}`
    case 'attack': return 'fighting...'
    case 'give': return `handing over ${a.item ?? 'something'}...`
    case 'take': return `picking up ${a.item ?? 'items'}...`
    case 'mine': return `mining${a.block ? ` ${a.block}` : ''}...`
    case 'place': return `placing ${a.item ?? 'blocks'}...`
    case 'chop': return 'chopping trees...'
    case 'use': return `using ${a.item ?? 'an item'}`
    case 'equip': return `equipping ${a.item ?? 'an item'}`
    case 'craft': return `crafting ${a.item ?? 'something'}...`
    default: return `${name}...`
  }
}

/**
 * @param {{ getObs: () => object|null, emit: (snapshot: object) => void, logger?: object, intervalMs?: number }} opts
 */
export function createDashboardTelemetry({ getObs, emit, logger = console, intervalMs = DEFAULT_INTERVAL_MS }) {
  let watching = false
  let timer = null
  let stopped = false
  let actionName = null
  let actionArgs

  function buildSnapshot() {
    const obs = getObs()
    const self = obs?.self
    if (!self || self.absent) return null
    return {
      game: 'terraria',
      ts: Date.now(),
      x: Number(self.x) || 0,
      y: Number(self.y) || 0,
      health: Number(self.hp) || 0,
      maxHealth: Number(self.maxHp) || 0,
      defense: Number(self.defense) || 0,
      stance: String(self.stance ?? 'defensive'),
      weapon: self.weapon ?? null,
      armor: Array.isArray(self.armor) ? self.armor.slice(0, 3).map(String) : [],
      knockedOut: Number(self.knockedOut) || 0,
      items: (Array.isArray(obs.bag) ? obs.bag : []).slice(0, 50).map((s) => {
        const e = parseBagEntry(s)
        return { name: e ? e[0] : String(s), count: e ? e[1] : 1 }
      }),
      activity: activityLabel(actionName, actionArgs),
      actionName: actionName ?? null,
      time: String(obs.time ?? ''),
      day: obs.day !== false,
      layer: String(obs.place?.layer ?? ''),
      events: Array.isArray(obs.events) ? obs.events.slice(0, 4).map(String) : [],
      paused: !!self.paused,
    }
  }

  function tick() {
    if (stopped || !watching) return
    let snap = null
    try { snap = buildSnapshot() } catch (err) {
      try { logger.warn?.(`[sei/terraria dash] snapshot failed: ${err?.message ?? err}`) } catch {}
    }
    if (snap) { try { emit(snap) } catch {} }
  }

  function arm() {
    if (timer || stopped) return
    timer = setInterval(tick, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  function disarm() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    setWatching(active) {
      const next = active === true
      if (next === watching) return
      watching = next
      if (watching) { arm(); tick() } else disarm()
    },
    setAction(name, args) {
      const changed = (name ?? null) !== actionName
      actionName = name ?? null
      actionArgs = args
      if (changed) tick()
    },
    isWatching() { return watching },
    stop() { stopped = true; disarm() },
  }
}
