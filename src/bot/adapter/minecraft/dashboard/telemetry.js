// src/bot/adapter/minecraft/dashboard/telemetry.js — Minecraft dashboard
// telemetry loop (260721).
//
// While the renderer reports it is watching (the dashboard tile/panel is on
// screen), emit a compact snapshot every ~2s, plus immediately when the
// current tool call changes: position + yaw + dimension, vitals, inventory,
// the natural-language activity line, and the minimap sample. While nobody
// watches, nothing is emitted and the world is never scanned.
//
// One instance per mineflayer bot instance (bringUp creates a fresh one on
// every reconnect); the watching flag survives reconnects because
// src/bot/index.js re-applies it to the new instance.

import { activityLabel } from './activityLabel.js'
import { sampleMap } from './mapSample.js'
import { vitals } from '../observers/vitals.js'

const DEFAULT_INTERVAL_MS = 2_000
/** Never resample the map faster than this, even across action-change emits.
 * Slightly under the tick interval so timer jitter cannot skip every other
 * tick's resample (a 2000/2000 beat would refresh the map only every 4s). */
const MAP_MIN_INTERVAL_MS = 1_800
const MAP_SIZE = 33
/** Player-window slots worth shipping: 5-8 armor, 9-35 main, 36-44 hotbar, 45 off-hand. */
const SLOT_MIN = 5
const SLOT_MAX = 45
const MAX_ITEMS = 46

/** Strip a namespaced id ("minecraft:stone" → "stone"). The stripped name
 * doubles as the renderer's texture key (GET /mcassets/<v>/item/<name>.png,
 * src/main/mcAssets.ts) — mineflayer item names ARE the minecraft item ids,
 * so keep this a pure namespace strip. */
function plainName(name) {
  return String(name ?? '').replace(/^minecraft:/, '')
}

/**
 * @param {object} opts
 * @param {import('mineflayer').Bot} opts.bot
 * @param {(snapshot: object) => void} opts.emit posts up the port (throw-safe)
 * @param {{warn?: Function}} [opts.logger]
 * @param {number} [opts.intervalMs]
 */
export function createDashboardTelemetry({ bot, emit, logger = console, intervalMs = DEFAULT_INTERVAL_MS }) {
  let watching = false
  let timer = null
  let stopped = false
  let actionName = null
  let actionArgs = undefined
  let lastMap = null
  let lastMapAt = 0

  function buildSnapshot() {
    const pos = bot?.entity?.position
    if (!pos) return null // not spawned (yet / anymore)
    const v = vitals(bot)
    const items = []
    const slots = bot?.inventory?.slots ?? []
    for (let s = SLOT_MIN; s <= SLOT_MAX && items.length < MAX_ITEMS; s++) {
      const it = slots[s]
      if (!it || !it.name || !(it.count > 0)) continue
      items.push({ name: plainName(it.name), count: it.count, slot: s })
    }
    const now = Date.now()
    let map = lastMap
    if (now - lastMapAt >= MAP_MIN_INTERVAL_MS || !lastMap) {
      try {
        map = sampleMap(bot, MAP_SIZE)
      } catch (err) {
        try { logger.warn?.(`[sei/dash] map sample failed: ${err?.message ?? err}`) } catch {}
        map = null
      }
      lastMap = map
      lastMapAt = now
    }
    return {
      ts: now,
      dimension: plainName(bot?.game?.dimension ?? 'overworld'),
      pos: {
        x: Math.round(pos.x * 10) / 10,
        y: Math.round(pos.y * 10) / 10,
        z: Math.round(pos.z * 10) / 10,
      },
      yaw: Number.isFinite(bot?.entity?.yaw) ? bot.entity.yaw : 0,
      health: Math.max(0, Math.min(20, v.hp)),
      food: Math.max(0, Math.min(20, v.food)),
      held: bot?.heldItem?.name ? plainName(bot.heldItem.name) : null,
      items,
      activity: activityLabel(actionName, actionArgs),
      actionName: actionName ?? null,
      map,
    }
  }

  function tick() {
    if (stopped || !watching) return
    let snap = null
    try {
      snap = buildSnapshot()
    } catch (err) {
      try { logger.warn?.(`[sei/dash] snapshot failed: ${err?.message ?? err}`) } catch {}
    }
    if (snap) {
      try { emit(snap) } catch {}
    }
  }

  function arm() {
    if (timer || stopped) return
    timer = setInterval(tick, intervalMs)
    // Node timers keep the process alive; the bot process must be able to
    // drain on its own once the brain stops.
    if (typeof timer.unref === 'function') timer.unref()
  }

  function disarm() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    /** Renderer visibility flag. Turning it on emits immediately. */
    setWatching(active) {
      const next = active === true
      if (next === watching) return
      watching = next
      if (watching) {
        arm()
        tick()
      } else {
        disarm()
      }
    },
    /** The orchestrator dispatched a tool (name set) or drained (name null). */
    setAction(name, args) {
      const changed = (name ?? null) !== actionName
      actionName = name ?? null
      actionArgs = args
      // "Plus immediately on change" — but the map still rides its own 2s cap.
      if (changed) tick()
    },
    isWatching() {
      return watching
    },
    stop() {
      stopped = true
      disarm()
    },
  }
}
