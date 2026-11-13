// src/bot/adapter/factorio/dashboard/telemetry.js: dashboard telemetry for a
// Factorio body (contract v2 createTelemetry). While the renderer watches,
// one snapshot per second (plus one at once when the current tool changes).
// Nothing is emitted while nobody watches.

const DEFAULT_INTERVAL_MS = 1_000

/** Lowercase natural-language activity line (activityLabel.js contract). */
export function activityLabel(name, args) {
  if (!name) return 'idling'
  const a = args ?? {}
  const w = (s) => String(s ?? '').replace(/-/g, ' ')
  switch (name) {
    case 'thinking': return 'thinking'
    case 'goTo': return 'walking...'
    case 'come': return 'coming to you...'
    case 'follow': return 'following you'
    case 'stay': return 'idling'
    case 'gather': return `mining ${w(a.resource) || 'resources'}...`
    case 'craft': return `crafting ${w(a.item) || 'something'}...`
    case 'give': return `handing over ${w(a.item) || 'something'}...`
    case 'take': return 'taking items...'
    case 'deposit': return `putting away ${w(a.item) || 'items'}...`
    case 'tend': return 'feeding the machines...'
    case 'build': return `building ${w(a.item) || 'something'}...`
    case 'buildGhosts': return 'building your blueprint...'
    case 'pickUp': return 'picking something up...'
    case 'inspect': return 'looking at a machine...'
    case 'research': return 'starting research...'
    case 'defend': return 'getting ready to fight'
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
    const at = Array.isArray(obs.at) ? obs.at : [0, 0]
    const items = Array.isArray(obs.inv?.items) ? obs.inv.items : []
    return {
      game: 'factorio',
      ts: Date.now(),
      surface: String(obs.surface ?? 'nauvis'),
      x: Number(at[0]) || 0,
      y: Number(at[1]) || 0,
      health: Number(obs.health) || 0,
      dead: !!obs.dead,
      fighting: !!obs.fighting,
      stance: String(obs.stance ?? 'defensive'),
      following: !!obs.follow,
      items: items.slice(0, 20).map((r) => ({ name: String(r?.[0] ?? ''), count: Number(r?.[1]) || 0 })),
      research: obs.research?.name ? `${obs.research.name} ${Number(obs.research.pct) || 0}%` : null,
      activity: activityLabel(actionName, actionArgs),
      actionName: actionName ?? null,
    }
  }

  function tick() {
    if (stopped || !watching) return
    let snap = null
    try { snap = buildSnapshot() } catch (err) {
      try { logger.warn?.(`[sei/factorio dash] snapshot failed: ${err?.message ?? err}`) } catch {}
    }
    if (snap) { try { emit(snap) } catch {} }
  }

  return {
    setWatching(active) {
      const next = active === true
      if (next === watching) return
      watching = next
      if (watching) {
        if (!timer && !stopped) {
          timer = setInterval(tick, intervalMs)
          if (typeof timer.unref === 'function') timer.unref()
        }
        tick()
      } else if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    setAction(name, args) {
      const changed = (name ?? null) !== actionName
      actionName = name ?? null
      actionArgs = args
      if (changed) tick()
    },
    isWatching() { return watching },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null },
  }
}
