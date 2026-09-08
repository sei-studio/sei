// src/bot/adapter/stardew/dashboard/telemetry.js — dashboard telemetry for a
// Stardew body (contract v2 createTelemetry). While the renderer watches, one
// snapshot per second (plus one at once when the current tool changes):
// {game:'stardew', location, x, y, stamina, health, held, items, activity,
// day, season, time}. Nothing is emitted while nobody watches. The generic
// gamedash service in main passes the object through (it is `.passthrough()`
// bounded by size), so every field here reaches the renderer.

const DEFAULT_INTERVAL_MS = 1_000

/** Lowercase natural-language activity line (activityLabel.js contract). */
export function activityLabel(name, args) {
  if (!name) return 'idling'
  const a = args ?? {}
  switch (name) {
    case 'thinking': return 'thinking'
    case 'goTo': return a.location ? `walking to ${a.location}...` : 'walking...'
    case 'come': return 'coming to you...'
    case 'follow': return 'following you'
    case 'unfollow': return 'idling'
    case 'till': return 'tilling the soil...'
    case 'water': return a.x != null ? 'watering a crop...' : 'watering the crops...'
    case 'plant': return `planting ${a.seed ?? 'seeds'}...`
    case 'harvest': return 'harvesting...'
    case 'chop': return 'chopping wood...'
    case 'mine': return 'breaking rocks...'
    case 'gather': return `gathering ${a.kind ?? 'things'}...`
    case 'attack': return 'fighting...'
    case 'fish': return 'fishing...'
    case 'eat': return `eating${a.item ? ` ${a.item}` : ''}...`
    case 'equip': return `holding ${a.item ?? 'an item'}`
    case 'place': return `placing ${a.item ?? 'an item'}...`
    case 'chest': return a.action === 'take' ? 'taking from a chest...' : 'putting things in a chest...'
    case 'buy': return `buying ${a.item ?? 'something'}...`
    case 'interact': return 'looking at something...'
    case 'sleep': return 'heading to bed...'
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
    if (!obs) return null
    return {
      game: 'stardew',
      ts: Date.now(),
      location: obs.location ?? 'unknown',
      x: Number(obs.x) || 0,
      y: Number(obs.y) || 0,
      stamina: Number(obs.stamina) || 0,
      maxStamina: Number(obs.maxStamina) || 0,
      health: Number(obs.health) || 0,
      maxHealth: Number(obs.maxHealth) || 0,
      gold: Number(obs.gold) || 0,
      held: obs.held ?? null,
      items: (Array.isArray(obs.inventory) ? obs.inventory : []).slice(0, 36).map((it) => ({
        name: String(it.name ?? ''),
        count: Number(it.count) || 1,
        kind: String(it.kind ?? 'other'),
        slot: Number(it.slot) || 0,
      })),
      activity: activityLabel(actionName, actionArgs),
      actionName: actionName ?? null,
      day: Number(obs.day) || 0,
      season: String(obs.season ?? ''),
      year: Number(obs.year) || 1,
      time: Number(obs.time) || 0,
      timeText: String(obs.timeText ?? ''),
      weather: String(obs.weather ?? ''),
      paused: !!obs.paused,
      sleeping: !!obs.sleeping,
    }
  }

  function tick() {
    if (stopped || !watching) return
    let snap = null
    try { snap = buildSnapshot() } catch (err) {
      try { logger.warn?.(`[sei/stardew dash] snapshot failed: ${err?.message ?? err}`) } catch {}
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
