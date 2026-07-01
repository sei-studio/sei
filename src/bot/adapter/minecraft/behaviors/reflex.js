import pkg from 'mineflayer-pathfinder'
import { HOSTILE_MOBS } from './hostiles.js'
const { goals } = pkg

// Reflex evasion micro-controller (Phase 17, D-05). A ~20 Hz physicsTick
// survival loop that evades incoming damage BEFORE it lands — the reactive
// reflex tier of the hybrid hierarchy (D-04), acting on mineflayer structured
// state rather than pixel RL (D-02). It is a sibling of startCombat: it lives
// ENTIRELY on the adapter side and NEVER enters src/bot/brain/fsm.js, so it can
// never abort the in-flight LLM action (no AbortController trip — the brain
// keeps thinking, gather() keeps running).
//
// Three evasion mechanisms, two of them non-interruptive control-state pulses
// (arrow sidestep, melee strafe — they add lateral velocity for a few ticks and
// release, leaving the action's pathfinder goal untouched) and one goal-owning
// flee (creeper — save/preempt/restore under the bot._seiReflexActive mutex,
// see Task 3 below).

// Skeletons that draw bows (the bow-draw telegraph applies to all of these).
const RANGED_SKELETONS = new Set(['skeleton', 'stray', 'bogged', 'wither_skeleton'])

// Threat priority ranks (lower wins): a creeper mid-fuse is the most urgent,
// then an incoming arrow, then a creeper merely in flee range, then a melee mob.
const RANK = { creeperPanic: 0, arrow: 1, creeper: 2, melee: 3 }

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/**
 * Closest-approach (point-to-line) test for an arrow's ray.
 *
 * Given a ray from `arrowPos` along `arrowVel`, returns:
 *   - `missDist`: the perpendicular distance from `botPos` to that ray (how far
 *     the arrow misses the bot's centre by).
 *   - `ahead`: whether the bot is in FRONT of the arrow along its travel
 *     direction (dot(botPos - arrowPos, arrowVel) > 0). An arrow that already
 *     flew past has `ahead === false` and must never trigger a dodge.
 *
 * Pure function (plain {x,y,z} math, no Vec3 dependency) so the ray geometry is
 * unit-testable in isolation. ~D-05 highest-leverage core.
 */
export function closestApproach(arrowPos, arrowVel, botPos) {
  const wx = botPos.x - arrowPos.x
  const wy = botPos.y - arrowPos.y
  const wz = botPos.z - arrowPos.z
  const vlen = Math.hypot(arrowVel.x, arrowVel.y, arrowVel.z)
  if (vlen === 0) return { missDist: Infinity, ahead: false }
  const dx = arrowVel.x / vlen
  const dy = arrowVel.y / vlen
  const dz = arrowVel.z / vlen
  // Projection of w onto the unit ray direction.
  const t = wx * dx + wy * dy + wz * dz
  const ahead = wx * arrowVel.x + wy * arrowVel.y + wz * arrowVel.z > 0
  // Perpendicular component = w minus its projection along the ray.
  const px = wx - t * dx
  const py = wy - t * dy
  const pz = wz - t * dz
  const missDist = Math.hypot(px, py, pz)
  return { missDist, ahead }
}

/**
 * D-06 per-persona override point. Today this returns the FIXED config-key
 * defaults and IGNORES `personaWeights` (a deliberate one-line behavioral
 * no-op); Phase 16 persona weighting will later bias these thresholds per
 * character (a timid persona flees creepers earlier, a brave one kites closer).
 * The reflex tick reads EVERY threshold through this function so that future
 * hook lands in exactly one place.
 */
export function resolveReflexThresholds(mc, personaWeights) {
  void personaWeights // intentionally unused this phase — the D-06 hook stub
  const num = (v, d) => (Number.isFinite(v) ? v : d)
  return {
    arrow_watch_blocks: num(mc?.arrow_watch_blocks, 16),
    arrow_miss_threshold: num(mc?.arrow_miss_threshold, 1.2),
    creeper_flee_enter_blocks: num(mc?.creeper_flee_enter_blocks, 8),
    creeper_flee_exit_blocks: num(mc?.creeper_flee_exit_blocks, 12),
    melee_kite_blocks: num(mc?.melee_kite_blocks, 4.5),
  }
}

// Pick a body-relative sidestep direction perpendicular to an incoming arrow's
// horizontal velocity. We step toward whichever side the bot is already offset
// (sign of the horizontal cross product) so the pulse clears the ray fastest.
// Either perpendicular direction clears a 0.3-wide hitbox; the sign just makes
// it deterministic.
function arrowSideHint(arrowPos, arrowVel, botPos) {
  const cross = arrowVel.x * (botPos.z - arrowPos.z) - arrowVel.z * (botPos.x - arrowPos.x)
  return cross >= 0 ? 'left' : 'right'
}

/**
 * Classify every in-range entity into a single highest-priority threat, or
 * null when nothing threatens. Distance-capped per threat class before any ray
 * math (T-17-01 DoS mitigation: bound the scan). Returns
 * `{ kind:'arrow'|'creeper'|'melee', entity, sideHint?, panic? }`.
 *
 * Priority: creeper-panic > arrow > creeper > melee.
 */
export function scanThreats(bot, mc) {
  const me = bot.entity
  const botPos = me?.position
  if (!botPos) return null
  const th = resolveReflexThresholds(mc)

  let best = null
  let bestRank = Infinity
  const consider = (cand, rank) => {
    if (rank < bestRank) { best = cand; bestRank = rank }
  }

  for (const id in bot.entities) {
    const e = bot.entities[id]
    if (!e || e === me || !e.position) continue

    // ── Arrows: any moving arrow whose ray passes within the miss threshold ──
    if (e.name === 'arrow') {
      const v = e.velocity
      if (!v || (!v.x && !v.y && !v.z)) continue // grounded/stale arrow keeps its
      const { missDist, ahead } = closestApproach(e.position, v, botPos)
      if (ahead && missDist < th.arrow_miss_threshold) {
        consider({ kind: 'arrow', entity: e, sideHint: arrowSideHint(e.position, v, botPos) }, RANK.arrow)
      }
      continue
    }

    const dist = dist3(e.position, botPos)

    // ── Creepers: fuse/ignite telegraph = panic (any distance); else flee band ──
    if (e.name === 'creeper') {
      const md = e.metadata
      const panic = md != null && (Number(md[16]) === 1 || Boolean(md[18]))
      if (panic) {
        consider({ kind: 'creeper', entity: e, panic: true }, RANK.creeperPanic)
      } else if (dist <= th.creeper_flee_enter_blocks) {
        consider({ kind: 'creeper', entity: e, panic: false }, RANK.creeper)
      }
      continue
    }

    // ── Skeletons (ranged): arm the arrow dodge on the bow-draw telegraph ──
    // metadata index 8 bit 0x01 = "hand active" (drawing the bow).
    if (RANGED_SKELETONS.has(e.name)) {
      if (dist <= th.arrow_watch_blocks) {
        const md = e.metadata
        if (md != null && (Number(md[8]) & 0x01) === 1) {
          const v = me.velocity ?? { x: 0, y: 0, z: 1 }
          consider({ kind: 'arrow', entity: e, sideHint: arrowSideHint(e.position, v, botPos) }, RANK.arrow)
        }
      }
      // wither_skeleton is also a melee threat; fall through to the melee check.
      if (e.name !== 'wither_skeleton') continue
    }

    // ── Melee mobs: kite when just outside reach (band + 2 for approach margin) ──
    if (HOSTILE_MOBS.has(e.name) && dist <= th.melee_kite_blocks + 2) {
      consider({ kind: 'melee', entity: e }, RANK.melee)
    }
  }

  return best
}

/**
 * Install the reflex survival loop. Returns a `dispose()` that removes the
 * physicsTick listener and clears any pending pulse timers. Mirrors the
 * startCombat factory shape (config slice, closed-over state, NaN guard) but its
 * loop is a `physicsTick` subscription rather than a setInterval.
 *
 * Public contract surfaced to Plan 02 (live wiring):
 *   - bot._seiReflexActive  (bool)   — true while a creeper flee owns the goal
 *   - bot._seiSavedGoal      (goal)  — the action goal to restore on flee exit
 *   - bot.emit('sei:reflex', payload) — one in-character announcement per engagement
 */
export function startReflex(bot, config) {
  const mc = config?.adapter?.minecraft ?? config ?? {}
  if (mc.reflex_enabled === false) return () => {}

  const tickMs = Number.isFinite(mc.reflex_tick_ms) && mc.reflex_tick_ms > 0 ? mc.reflex_tick_ms : 50
  const TH = resolveReflexThresholds(mc)

  let _disposed = false
  let _pulseSide = null
  let _pulseTimer = null
  let _strafeSide = null
  let _strafeFlipAt = 0

  // Creeper-flee goal-ownership state. The installed mineflayer-pathfinder
  // (^2.4.5) does NOT expose `bot.pathfinder.goal`, so we track the externally
  // set action goal via the `goal_updated` event (the pathfinder emits it on
  // every setGoal). `_selfSetting` masks our own flee set/restore so we never
  // snapshot our own GoalInvert as the goal to restore.
  let _fleeId = null
  let _savedDynamic = false
  let _trackedGoal = null
  let _trackedDynamic = false
  let _selfSetting = false

  function onGoalUpdated(goal, dynamic) {
    if (_selfSetting) return
    _trackedGoal = goal
    _trackedDynamic = Boolean(dynamic)
  }

  function releasePulse() {
    if (_pulseTimer) { clearTimeout(_pulseTimer); _pulseTimer = null }
    if (_pulseSide) {
      try { bot.setControlState(_pulseSide, false) } catch (_) {}
      _pulseSide = null
    }
  }

  // Drop any melee-strafe control states we are holding. Guarded on _strafeSide
  // so it is a no-op when we are NOT strafing — critical, or we would clear the
  // forward/back the pathfinder/gather legitimately set on non-melee ticks.
  function releaseStrafe() {
    if (!_strafeSide) return
    try { bot.setControlState(_strafeSide, false) } catch (_) {}
    try { bot.setControlState('forward', false) } catch (_) {}
    try { bot.setControlState('back', false) } catch (_) {}
    _strafeSide = null
    _strafeFlipAt = 0
  }

  // ARROW response: a transient lateral sidestep pulse (~4 ticks). It does NOT
  // touch the pathfinder goal — the action's goal re-asserts course next tick.
  function doArrowDodge(threat) {
    if (_pulseSide) return // already mid-pulse
    const side = threat.sideHint === 'right' ? 'right' : 'left'
    _pulseSide = side
    try { bot.setControlState(side, true) } catch (_) {}
    _pulseTimer = setTimeout(releasePulse, tickMs * 4)
  }

  // MELEE response: a best-effort circle-strafe pulse over the goal. Alternates
  // left/right every ~10 ticks and nudges forward/back to hold a 2.5-4 band.
  // Suppressed when we are already offensively attacking this exact mob.
  function doMeleeStrafe(threat) {
    const mob = threat.entity
    if (bot._seiOffensiveTarget != null && bot._seiOffensiveTarget === mob.id) return
    try { bot.lookAt(mob.position) } catch (_) {}
    const now = Date.now()
    if (!_strafeSide || now >= _strafeFlipAt) {
      if (_strafeSide) { try { bot.setControlState(_strafeSide, false) } catch (_) {} }
      _strafeSide = _strafeSide === 'left' ? 'right' : 'left'
      try { bot.setControlState(_strafeSide, true) } catch (_) {}
      _strafeFlipAt = now + tickMs * 10
    }
    const d = dist3(mob.position, bot.entity.position)
    try {
      if (d < 2.5) { bot.setControlState('back', true); bot.setControlState('forward', false) }
      else if (d > 4) { bot.setControlState('forward', true); bot.setControlState('back', false) }
      else { bot.setControlState('forward', false); bot.setControlState('back', false) }
    } catch (_) {}
  }

  function creeperPanic(creeper) {
    const md = creeper?.metadata
    // index 16 === 1 → fuse/swelling; index 18 → ignited (flint-and-steel lit).
    return md != null && (Number(md[16]) === 1 || Boolean(md[18]))
  }

  function countNearbyHostiles(botPos) {
    let n = 0
    for (const id in bot.entities) {
      const e = bot.entities[id]
      if (!e || e === bot.entity || !e.position) continue
      if (e.name !== 'creeper' && !HOSTILE_MOBS.has(e.name)) continue
      if (dist3(e.position, botPos) <= TH.creeper_flee_exit_blocks) n++
    }
    return n
  }

  // CREEPER response: a GOAL-OWNING flee (the one reflex that takes the
  // pathfinder goal). Snapshot the action goal, take over with
  // GoalInvert(GoalFollow(creeper, exit)), and restore on exit — transparent to
  // gather()/follow() under the bot._seiReflexActive mutex that those consumers
  // yield to (Plan 02 wiring). Fire exactly one in-character announcement per
  // engagement (rising edge — enterFlee runs once, the active-flee branch in
  // tick() keeps us fleeing without re-entering).
  function enterFlee(creeper) {
    bot._seiReflexActive = true
    bot._seiSavedGoal = _trackedGoal ?? bot.pathfinder?.goal ?? null
    _savedDynamic = _trackedDynamic
    _fleeId = creeper.id
    releasePulse() // drop any in-flight sidestep before taking the goal
    try {
      const goal = new goals.GoalInvert(new goals.GoalFollow(creeper, TH.creeper_flee_exit_blocks))
      _selfSetting = true
      bot.pathfinder.setGoal(goal, true)
    } catch (_) {} finally { _selfSetting = false }
    emitReflex(creeper)
  }

  function exitFlee() {
    try {
      _selfSetting = true
      bot.pathfinder.setGoal(bot._seiSavedGoal ?? null, _savedDynamic)
    } catch (_) {} finally { _selfSetting = false }
    bot._seiReflexActive = false
    bot._seiSavedGoal = null
    _fleeId = null
  }

  // The payload is shaped so Plan 02's fsmWires translation can frame an
  // in-character say() offering attack()/explore(). The emit MUST NOT block
  // evasion and MUST NOT enqueue into fsm.js.
  function emitReflex(creeper) {
    try {
      bot.emit('sei:reflex', {
        threat: creeper.name,
        threatLabel: creeper.name,
        // noticed: did a positive telegraph fire (fuse/ignite) vs a distance-only flee
        noticed: creeperPanic(creeper),
        count: countNearbyHostiles(bot.entity.position),
      })
    } catch (_) {}
  }

  function tick() {
    if (_disposed) return
    // Knockback packets occasionally produce transient non-finite velocity /
    // position (combat.js:67-71). Skip the tick rather than read garbage —
    // T-17-01 mitigation: a malformed packet never throws out of the loop.
    const vel = bot.entity?.velocity
    const pos = bot.entity?.position
    if (!vel || !pos) return
    if (!Number.isFinite(vel.x) || !Number.isFinite(vel.y) || !Number.isFinite(vel.z)) return
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return
    if (bot.health != null && bot.health <= 0) return

    // Maintain an active flee independent of scanThreats: once fleeing we keep
    // going until the creeper is gone or beyond the EXIT band (hysteresis —
    // scanThreats only reports the creeper at ≤ enter band, so the exit decision
    // must live here). A panicking (fusing) creeper holds the flee at any range.
    if (_fleeId != null) {
      const creeper = bot.entities[_fleeId]
      if (!creeper || !creeper.position) { exitFlee(); return }
      const d = dist3(creeper.position, pos)
      if (!creeperPanic(creeper) && d > TH.creeper_flee_exit_blocks) exitFlee()
      return // creeper is top priority while the flee is active
    }

    const threat = scanThreats(bot, mc)
    // Any tick that is not a live melee engagement drops leftover strafe control
    // states (mob died/left, or a higher-priority threat took over) so the bot
    // does not keep drifting after the fight.
    if (!threat || threat.kind !== 'melee') releaseStrafe()
    if (!threat) return

    if (threat.kind === 'creeper') return enterFlee(threat.entity)
    if (threat.kind === 'arrow') return doArrowDodge(threat)
    if (threat.kind === 'melee') return doMeleeStrafe(threat)
  }

  function dispose() {
    if (_disposed) return
    _disposed = true
    releasePulse()
    releaseStrafe()
    // Clear the mutex so consumers (gather/follow/goTo) never deadlock waiting
    // on a flee that will never exit; leave the goal as-is on teardown.
    if (bot._seiReflexActive) { bot._seiReflexActive = false; bot._seiSavedGoal = null }
    _fleeId = null
    try { bot.removeListener('physicsTick', tick) } catch (_) {}
    try { bot.removeListener('death', dispose) } catch (_) {}
    try { bot.removeListener('goal_updated', onGoalUpdated) } catch (_) {}
  }

  bot.on('physicsTick', tick)
  bot.once('death', dispose)
  bot.on('goal_updated', onGoalUpdated)
  return dispose
}
