// src/bot/adapter/sts2/dashboard/telemetry.js: dashboard telemetry for the
// Slay the Spire 2 seat (contract v2 createTelemetry). While the renderer
// watches, one snapshot per second (plus one at once when the current tool
// changes). Nothing is emitted while nobody watches.

const DEFAULT_INTERVAL_MS = 1_000

/** Lowercase natural-language activity line (activityLabel.js contract). */
export function activityLabel(name, args, state) {
  if (!name) return state?.me?.ended_turn ? 'waiting for the others' : 'idling'
  if (name === 'thinking') return 'thinking'
  if (name !== 'act') return `${name}...`
  const a = args?.action
  switch (a) {
    case 'play_card': return typeof args?.args?.card === 'string' ? `playing ${String(args.args.card).slice(0, 40)}...` : 'playing a card...'
    case 'end_turn': return 'ending the turn'
    case 'use_potion': return 'drinking a potion...'
    case 'select_map_node': return 'picking the path...'
    case 'select_card': return 'picking a card...'
    default: return 'deciding...'
  }
}

/**
 * @param {{ getState: () => object|null, getInfo?: () => object, emit: (snapshot: object) => void, logger?: object, intervalMs?: number }} opts
 */
export function createDashboardTelemetry({ getState, getInfo = () => ({}), emit, logger = console, intervalMs = DEFAULT_INTERVAL_MS }) {
  let watching = false
  let timer = null
  let stopped = false
  let actionName = null
  let actionArgs

  function buildSnapshot() {
    const st = getState()
    const info = getInfo() ?? {}
    const me = st?.me ?? {}
    return {
      game: 'sts2',
      ts: Date.now(),
      connected: info.connected === true,
      coop: info.coop === true,
      screen: typeof st?.screen === 'string' ? st.screen.slice(0, 24) : null,
      act: Number(st?.run?.act) || null,
      floor: Number(st?.run?.floor) || null,
      hp: Number(me.hp) || 0,
      maxHp: Number(me.max_hp) || 0,
      gold: Number(me.gold) || 0,
      character: typeof me.character === 'string' ? me.character.slice(0, 32) : null,
      yourMove: info.yourMove === true,
      activity: activityLabel(actionName, actionArgs, st),
      actionName: actionName ?? null,
    }
  }

  function tick() {
    if (stopped || !watching) return
    let snap = null
    try { snap = buildSnapshot() } catch (err) {
      try { logger.warn?.(`[sei/sts2 dash] snapshot failed: ${err?.message ?? err}`) } catch {}
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
