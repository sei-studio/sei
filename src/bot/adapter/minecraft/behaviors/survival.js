// src/adapter/minecraft/behaviors/survival.js
//
// Automatic, LLM-independent survival micro-controllers — the same "reflex tier"
// as behaviors/reflex.js, but for two failure modes reflex.js does NOT cover:
//
//   1. DROWNING  — oxygen drops underwater and NOTHING in the codebase reacts
//      to bot.oxygenLevel (verified: no other usage). Sei drowned in a flooded
//      cave in the last live run. This loop swims her up before the bar empties.
//   2. CRITICAL-HP RETREAT — the model repeatedly chose attackEntity at 1-2 HP
//      instead of backing off (3 deaths in one run), so prompt advice alone is
//      demonstrably not enough. This loop force-disengages: it takes the
//      pathfinder and flees the nearest hostile until health recovers.
//
// Like reflex.js this lives ENTIRELY on the adapter side. It is a ~20 Hz
// physicsTick loop; it never enters src/bot/brain/fsm.js and never aborts an
// in-flight LLM action. It emits `sei:survival` (mirroring reflex's `sei:reflex`)
// so the brain CAN narrate — but the physical response never waits on the LLM.
//
// ── Goal-ownership rules (this file's contract) ──────────────────────────────
// reflex.js owns  bot._seiReflexActive / bot._seiSavedGoal  for its creeper flee.
// This file owns its OWN, DISJOINT slots so the two never collide:
//     bot._seiSurvivalActive    (bool)  — true while a survival controller owns
//                                          movement (swim-up OR critical flee)
//     bot._seiCriticalRetreat   (bool)  — true while the critical-HP flee is up
//     bot._seiSurvivalSavedGoal (goal)  — the action goal to restore on exit
// CREEPER FLEE WINS: whenever bot._seiReflexActive is set we stand DOWN entirely
// (release our control states, leave the goal to reflex) — a fusing creeper is
// the more urgent threat and reflex's flee already respects pathfind.js's mutex.
//
// ── Interaction with attack.js (documented per task) ─────────────────────────
// attack.js pursues a mob by calling goTo() (bot.pathfinder.goto) on a loop, and
// pathfind.js only yields to reflex's flag, NOT ours. So during a critical
// retreat the attack loop and our flee tug over the pathfinder. We WIN by
// re-asserting our flee goal whenever we detect the goal was stolen (a non-self
// goal_updated) — at 20 Hz that is far faster than attack's ~2.5 s per-pursuit
// goTo, so attack's goto() keeps getting GoalChanged-rejected, reads as
// cant_reach, and its loop times out while the bot flees. This is the intended
// outcome: at <=6 HP we do NOT let the model keep swinging.

import pkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { HOSTILE_MOBS } from './hostiles.js'
const { goals } = pkg

const WATER = new Set(['water', 'bubble_column'])
const AIR = new Set(['air', 'cave_air', 'void_air'])

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** Resolve the survival thresholds from the minecraft config slice (all defaulted). */
export function resolveSurvivalThresholds(mc) {
  const num = (v, d) => (Number.isFinite(v) ? v : d)
  return {
    oxygen_flee_enter: num(mc?.oxygen_flee_enter, 10),
    oxygen_flee_exit: num(mc?.oxygen_flee_exit, 18),
    survival_blocked_ms: num(mc?.survival_blocked_ms, 3000),
    critical_hp_enter: num(mc?.critical_hp_enter, 6),
    critical_hp_exit: num(mc?.critical_hp_exit, 10),
    critical_hostile_enter_blocks: num(mc?.critical_hostile_enter_blocks, 8),
    critical_hostile_exit_blocks: num(mc?.critical_hostile_exit_blocks, 16),
    critical_flee_range: num(mc?.critical_flee_range, 14),
  }
}

/** The floored cell the bot's HEAD occupies (feet.y + 1 for a ~1.8-tall entity). */
function headCell(pos) {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y + 1), z: Math.floor(pos.z) }
}

/**
 * Install the survival loop. Returns a `dispose()` that removes the physicsTick
 * listener, releases any held control states, and clears our goal-ownership
 * flags. Mirrors startReflex's factory shape (config slice, NaN guard, dispose
 * on death) so connect.js can install/re-arm it exactly next to startReflex.
 *
 * Public contract surfaced to the brain:
 *   - bot._seiSurvivalActive   (bool)
 *   - bot._seiCriticalRetreat  (bool)
 *   - bot._seiSurvivalSavedGoal (goal)
 *   - bot.emit('sei:survival', { kind, threatLabel, count }) — one per engagement
 */
export function startSurvival(bot, config) {
  const mc = config?.adapter?.minecraft ?? config ?? {}
  if (mc.survival_enabled === false) return () => {}

  const TH = resolveSurvivalThresholds(mc)

  let _disposed = false

  // ── Goal tracking (our own, disjoint from reflex's) ───────────────────────
  // We track the externally-set action goal via `goal_updated` (pathfinder ^2.4
  // does not expose bot.pathfinder.goal). `_selfSetting` masks our own set/clear
  // so we never snapshot our own flee goal as the goal to restore, and
  // `_goalStolen` flags that someone else (e.g. attack.js's goTo) grabbed the
  // pathfinder so an engaged controller can re-assert on the next tick.
  let _trackedGoal = null
  let _trackedDynamic = false
  let _selfSetting = false
  let _goalStolen = false

  function onGoalUpdated(goal, dynamic) {
    if (_selfSetting) return
    // While a controller owns movement, a foreign goal set is a STEAL, not the
    // action goal — record it for re-assert but do NOT overwrite the frozen
    // saved goal captured at engage time.
    if (bot._seiSurvivalActive) { _goalStolen = true; return }
    _trackedGoal = goal
    _trackedDynamic = Boolean(dynamic)
  }

  function setGoalSelf(goal, dynamic) {
    try {
      _selfSetting = true
      bot.pathfinder?.setGoal(goal, dynamic)
    } catch (_) {} finally { _selfSetting = false }
  }

  // ── Shared movement-takeover bookkeeping ──────────────────────────────────
  function beginOwnership() {
    if (!bot._seiSurvivalActive) {
      bot._seiSurvivalSavedGoal = _trackedGoal ?? null
      _savedDynamic = _trackedDynamic
      bot._seiSurvivalActive = true
    }
  }
  let _savedDynamic = false

  function endOwnership() {
    if (!bot._seiSurvivalActive) return
    setGoalSelf(bot._seiSurvivalSavedGoal ?? null, _savedDynamic)
    bot._seiSurvivalActive = false
    bot._seiSurvivalSavedGoal = null
    _goalStolen = false
  }

  function releaseControls() {
    for (const c of ['jump', 'forward', 'back', 'left', 'right', 'sneak']) {
      try { bot.setControlState(c, false) } catch (_) {}
    }
  }

  // ═══════════════════════ 1. DROWNING SWIM-UP ═════════════════════════════
  let _drownActive = false
  let _drownStartMs = 0
  let _drownStartY = 0
  let _lastAirScanMs = 0
  let _airDir = null

  function headInWater(pos) {
    try {
      const h = headCell(pos)
      const b = bot.blockAt(new Vec3(h.x, h.y, h.z))
      return !!(b && WATER.has(b.name))
    } catch (_) { return false }
  }

  // Bounded horizontal-escape heuristic: when the ascent is blocked by solid
  // blocks overhead, scan a small radius at head level for the nearest AIR cell
  // (a breathable pocket) and return a unit horizontal direction toward it.
  // Throttled (only runs while blocked, at most ~2 Hz) so per-tick cost stays
  // tiny. Returns null when no pocket is in reach (then we just keep swimming up).
  function findAirEscape(pos) {
    const h = headCell(pos)
    let best = null
    let bestD = Infinity
    for (let r = 1; r <= 4; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue // ring only
          let b
          try { b = bot.blockAt(new Vec3(h.x + dx, h.y, h.z + dz)) } catch (_) { continue }
          if (!b || !AIR.has(b.name)) continue
          const d = Math.hypot(dx, dz)
          if (d < bestD) { bestD = d; best = { x: dx, z: dz } }
        }
      }
      if (best) break // nearest ring with a pocket wins
    }
    if (!best) return null
    const len = Math.hypot(best.x, best.z) || 1
    return { x: best.x / len, z: best.z / len }
  }

  function drownEngage() {
    _drownActive = true
    _drownStartMs = Date.now()
    _drownStartY = bot.entity.position.y
    _airDir = null
    beginOwnership()
    // Clear any action goal so pathfinder controls don't fight the jump/forward
    // we drive by hand. (Re-asserted below if something steals the pathfinder.)
    setGoalSelf(null, false)
    emitSurvival('drowning', 'deep water', 1)
  }

  function drownDisengage() {
    _drownActive = false
    _airDir = null
    releaseControls()
    try { bot.look(bot.entity.yaw, 0, false) } catch (_) {}
    endOwnership()
  }

  // Drive the swim-up. Returns true while it OWNS this tick (so retreat stands
  // down and the tick short-circuits).
  function updateDrown(pos, oxy) {
    if (_drownActive) {
      const stillWater = headInWater(pos)
      if (!stillWater || oxy >= TH.oxygen_flee_exit) { drownDisengage(); return false }
    } else {
      if (typeof oxy !== 'number' || oxy > TH.oxygen_flee_enter) return false
      if (!headInWater(pos)) return false
      drownEngage()
    }

    // Foreign goal grabbed the pathfinder while we own movement — clear it again.
    if (_goalStolen) { setGoalSelf(null, false); _goalStolen = false }

    // Always hold jump: in water, jump = ascend.
    try { bot.setControlState('jump', true) } catch (_) {}

    const rose = bot.entity.position.y - _drownStartY
    const blocked = (Date.now() - _drownStartMs) > TH.survival_blocked_ms && rose < 0.5
    if (!blocked) {
      // Ascending fine — look straight up, no horizontal drift.
      try { bot.setControlState('forward', false) } catch (_) {}
      try { bot.look(bot.entity.yaw, -Math.PI / 2, false) } catch (_) {}
      return true
    }

    // Blocked overhead: swim horizontally toward the nearest air pocket.
    const now = Date.now()
    if (!_airDir || now - _lastAirScanMs > 500) {
      _lastAirScanMs = now
      _airDir = findAirEscape(pos)
    }
    if (_airDir) {
      // Match this codebase's yaw convention: yawToUnit(yaw) = [-sin, -cos], so
      // to face direction (dx, dz) the yaw is atan2(-dx, -dz).
      const yaw = Math.atan2(-_airDir.x, -_airDir.z)
      try { bot.look(yaw, 0, false) } catch (_) {}
      try { bot.setControlState('forward', true) } catch (_) {}
    } else {
      // No pocket found — keep jumping and hope the surface is straight up.
      try { bot.setControlState('forward', false) } catch (_) {}
      try { bot.look(bot.entity.yaw, -Math.PI / 2, false) } catch (_) {}
    }
    return true
  }

  // ═══════════════════════ 2. CRITICAL-HP RETREAT ══════════════════════════
  let _retreatActive = false
  let _retreatMobId = null

  function nearestHostile(pos, radius) {
    let best = null
    let bestD = Infinity
    for (const id in bot.entities) {
      const e = bot.entities[id]
      if (!e || e === bot.entity || !e.position) continue
      if (e.name !== 'creeper' && !HOSTILE_MOBS.has(e.name)) continue
      const d = dist3(e.position, pos)
      if (d <= radius && d < bestD) { bestD = d; best = e }
    }
    return best
  }

  function countHostiles(pos, radius) {
    let n = 0
    for (const id in bot.entities) {
      const e = bot.entities[id]
      if (!e || e === bot.entity || !e.position) continue
      if (e.name !== 'creeper' && !HOSTILE_MOBS.has(e.name)) continue
      if (dist3(e.position, pos) <= radius) n++
    }
    return n
  }

  function retreatSetFleeGoal(mob) {
    // Flee = invert a follow of the mob out to `critical_flee_range`, dynamic so
    // it keeps re-pathing as the mob (and we) move.
    const goal = new goals.GoalInvert(new goals.GoalFollow(mob, TH.critical_flee_range))
    setGoalSelf(goal, true)
  }

  function retreatEngage(mob, pos) {
    _retreatActive = true
    _retreatMobId = mob.id
    bot._seiCriticalRetreat = true
    beginOwnership()
    retreatSetFleeGoal(mob)
    emitSurvival('critical_retreat', mob.name ?? 'a hostile', countHostiles(pos, TH.critical_hostile_exit_blocks))
  }

  function retreatDisengage() {
    _retreatActive = false
    _retreatMobId = null
    bot._seiCriticalRetreat = false
    releaseControls()
    endOwnership()
  }

  function updateRetreat(pos, health) {
    if (_retreatActive) {
      // Hysteresis: keep fleeing until HP recovers OR no hostiles remain in the
      // (larger) exit radius.
      if (health > TH.critical_hp_exit) { retreatDisengage(); return }
      const near = nearestHostile(pos, TH.critical_hostile_exit_blocks)
      if (!near) { retreatDisengage(); return }
      // Re-target if our mob died/left; otherwise re-assert the same goal only
      // when the pathfinder was stolen (keeps us winning the tug with attack.js).
      if (near.id !== _retreatMobId) {
        _retreatMobId = near.id
        retreatSetFleeGoal(near)
      } else if (_goalStolen) {
        retreatSetFleeGoal(near)
        _goalStolen = false
      }
      return
    }
    // Not engaged: cheap HP gate — only scan entities when HP is actually low.
    if (health > TH.critical_hp_enter) return
    const near = nearestHostile(pos, TH.critical_hostile_enter_blocks)
    if (near) retreatEngage(near, pos)
  }

  // ── Emit (rising-edge, once per engagement; mirrors reflex's emitReflex) ──
  function emitSurvival(kind, threatLabel, count) {
    try {
      bot.emit('sei:survival', { kind, threatLabel, count })
    } catch (_) {}
  }

  // ═══════════════════════════════ TICK ════════════════════════════════════
  function tick() {
    if (_disposed) return
    const pos = bot.entity?.position
    const vel = bot.entity?.velocity
    if (!pos || !vel) return
    // T-17-01: a malformed knockback packet can produce non-finite pos — skip
    // rather than read garbage (same guard as reflex.js).
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return
    if (bot.health != null && bot.health <= 0) return

    // CREEPER FLEE WINS: reflex owns movement — stand fully down.
    if (bot._seiReflexActive) {
      if (_drownActive) { _drownActive = false; _airDir = null; releaseControls() }
      if (_retreatActive) { _retreatActive = false; _retreatMobId = null; bot._seiCriticalRetreat = false }
      // Do NOT restore the goal here — reflex owns it and will restore its own
      // saved goal on flee exit. Just drop our ownership flag if we held it.
      if (bot._seiSurvivalActive) { bot._seiSurvivalActive = false; bot._seiSurvivalSavedGoal = null; _goalStolen = false }
      return
    }

    // Drowning has priority over the HP retreat — you die in seconds underwater.
    const oxy = bot.oxygenLevel
    if (updateDrown(pos, oxy)) {
      if (_retreatActive) retreatDisengage()
      return
    }

    updateRetreat(pos, typeof bot.health === 'number' ? bot.health : 20)
  }

  function dispose() {
    if (_disposed) return
    _disposed = true
    releaseControls()
    // Restore the goal if we still own it, then clear every flag so no consumer
    // deadlocks waiting on a survival takeover that will never end.
    if (bot._seiSurvivalActive) endOwnership()
    bot._seiCriticalRetreat = false
    _drownActive = false
    _retreatActive = false
    try { bot.removeListener('physicsTick', tick) } catch (_) {}
    try { bot.removeListener('death', dispose) } catch (_) {}
    try { bot.removeListener('goal_updated', onGoalUpdated) } catch (_) {}
  }

  bot.on('physicsTick', tick)
  bot.once('death', dispose)
  bot.on('goal_updated', onGoalUpdated)
  return dispose
}
