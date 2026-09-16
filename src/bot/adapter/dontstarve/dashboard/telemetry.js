// src/bot/adapter/dontstarve/dashboard/telemetry.js — the DST dashboard
// feed (game-adapters M2, 260908). While the renderer says it is watching,
// emit one snapshot per second (plus immediately when the current tool
// changes): position, the vitals triple, temperature, held item, inventory,
// the natural-language activity line, and the world clock. Tagged
// game:'dontstarve' so main's gameDashboardService routes it to
// gamedash:snapshot. Contract: DstDashboardSnapshot in src/shared/dstIpc.ts.

import { activityLabel } from './activityLabel.js'

const DEFAULT_INTERVAL_MS = 1_000
const MAX_ITEMS = 24

/**
 * @param {object} opts
 * @param {ReturnType<import('../protocol.js').createObservationState>} opts.state
 * @param {(snapshot: object) => void} opts.emit
 * @param {{warn?: Function}} [opts.logger]
 * @param {string} [opts.prefab]
 * @param {number} [opts.intervalMs]
 */
export function createDashboardTelemetry({ state, emit, logger = console, prefab = 'wilson', intervalMs = DEFAULT_INTERVAL_MS }) {
  let watching = false
  let timer = null
  let stopped = false
  let actionName = null
  let actionArgs

  function buildSnapshot() {
    const self = state.self
    const world = state.world
    if (!self || !world) return null
    const items = []
    for (const it of self.inv) {
      if (items.length >= MAX_ITEMS) break
      items.push({ prefab: it.prefab, count: it.qty })
    }
    const hands = self.equip?.hands ?? self.equip?.HANDS ?? null
    return {
      game: 'dontstarve',
      ts: Date.now(),
      activity: activityLabel(actionName, actionArgs),
      actionName: actionName ?? null,
      x: Math.round(self.x * 10) / 10,
      z: Math.round(self.z * 10) / 10,
      health: Math.round(self.hp), healthMax: Math.round(self.hpMax),
      hunger: Math.round(self.hunger), hungerMax: Math.round(self.hungerMax),
      sanity: Math.round(self.sanity), sanityMax: Math.round(self.sanityMax),
      temperature: Math.round(self.temp),
      held: hands ? hands.prefab : null,
      items,
      day: world.day, season: world.season, phase: world.phase,
      prefab,
    }
  }

  function tick() {
    if (stopped || !watching) return
    let snap = null
    try { snap = buildSnapshot() } catch (err) {
      try { logger.warn?.(`[sei/dst-dash] snapshot failed: ${err?.message ?? err}`) } catch {}
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
      watching = active === true
      if (watching) { arm(); tick() } else disarm()
    },
    setAction(name, args) {
      actionName = name ?? null
      actionArgs = args
      if (watching) tick()
    },
    stop() {
      stopped = true
      disarm()
    },
  }
}
