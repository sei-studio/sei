// src/bot/adapter/minecraft/behaviors/gaze.js
//
// Head-look ("gaze") behavior — cosmetic, LLM-uninvolved. Makes the companion
// visually track its owner: full yaw+pitch when idle (owner within
// gaze_range_blocks) and pitch-tracking (so it looks up/down at a player above
// or below it) while moving toward the owner during follow/goTo, without
// fighting the pathfinder's ownership of yaw while it is actively steering.
//
// Why this can't just lookAt() every tick (the pathfinder-yaw tension):
// mineflayer's walking is control-state-relative-to-yaw — the forward/back/
// left/right control states move the bot relative to whatever yaw it
// currently faces. The installed mineflayer-pathfinder (^2.4.5) does not
// expose bot.pathfinder.goal (confirmed by reading node_modules directly —
// only setGoal/isMoving/isMining/isBuilding are exposed), so this module has
// no way to tell "is a goal set" beyond bot.pathfinder.isMoving() (path.length
// > 0 internally). The resolution used here:
//   - IDLE (isMoving() false — no goal, OR a GoalFollow that has already
//     closed to arrival range and stopped issuing path steps): full lookAt
//     the owner's eyes whenever they're within range. There is no steering to
//     fight, so this is always safe.
//   - MOVING (isMoving() true — an active goTo or a follow still closing the
//     gap): only lookAt the owner when the CURRENT TRAVEL DIRECTION is
//     already roughly toward them (within MOVING_CONE_DEG). In that case
//     aiming exactly at the owner is a small nudge away from the yaw the
//     pathfinder's own forward control-state already implies (that's exactly
//     the common "following the player" case), so pitch-tracking comes
//     essentially for free without materially perturbing horizontal
//     steering. Outside that cone (pathfinder is walking around an obstacle,
//     or the destination isn't the owner at all) yaw is left entirely alone.
//
// Suppressed whenever another system needs the head: reflex evasion/combat
// (bot._seiReflexActive / _seiOffensiveTarget — reflex.js / attack.js;
// _seiSurvivalActive / _seiCriticalRetreat — survival.js, landing in a
// parallel change), sleeping, or a render aiming the camera for a frame
// (bot._seiGazeHold, a small shared counter incremented/decremented by
// visualize.js and build.js around their own bot.look calls).
//
// Ticks on a plain ~4 Hz interval (not physicsTick) — this is cosmetic head
// movement, not a survival reflex, so a cheap timer is plenty and it keeps
// the per-physicsTick cost budget (reflex.js's ~20 Hz loop) untouched.

import { resolveOwner } from '../observers/snapshot.js'

const DEFAULT_RANGE_BLOCKS = 96 // 6 chunks
const DEFAULT_TICK_MS = 250 // ~4 Hz re-aim cadence
const MOVING_CONE_DEG = 35
const EYE_HEIGHT_FALLBACK = 1.62
// Minimum aim-delta (radians, ~1.5°) worth re-issuing bot.lookAt for — filters
// sub-degree jitter from an owner who is standing still relative to the bot.
const MIN_AIM_DELTA_RAD = 0.026

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// Smallest absolute difference between two angles (radians), wrapped to [0, π].
function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return Math.abs(d)
}

// Mirrors mineflayer's own bot.lookAt math exactly (physics.js) so the
// delta-gate below compares against what bot.lookAt would actually compute,
// not an approximation of it.
function computeAim(bot, targetPos) {
  const me = bot.entity
  if (!me?.position) return null
  const eyeHeight = Number.isFinite(me.eyeHeight) ? me.eyeHeight : EYE_HEIGHT_FALLBACK
  const dx = targetPos.x - me.position.x
  const dy = targetPos.y - (me.position.y + eyeHeight)
  const dz = targetPos.z - me.position.z
  const yaw = Math.atan2(-dx, -dz)
  const pitch = Math.atan2(dy, Math.hypot(dx, dz))
  return { yaw, pitch }
}

/**
 * Install the gaze controller. Returns a `dispose()` mirroring the
 * startReflex/startCombat/startFollow factory shape (installed from
 * connect.js on spawn + respawn; disposed on death).
 */
export function startGaze(bot, config) {
  const mc = config?.adapter?.minecraft ?? config ?? {}
  if (mc.gaze_enabled === false) return () => {}

  // Idempotent re-arm: a dimension-change 'spawn' fires WITHOUT a 'death' and
  // connect.js re-arms on every non-first spawn — tear down any previous install
  // first, or each portal trip stacks a duplicate 250ms interval.
  if (typeof bot._seiGazeDispose === 'function') { try { bot._seiGazeDispose() } catch (_) {} }

  const rangeBlocks = Number.isFinite(mc.gaze_range_blocks) ? mc.gaze_range_blocks : DEFAULT_RANGE_BLOCKS
  const tickMs = Number.isFinite(mc.gaze_tick_ms) && mc.gaze_tick_ms > 0 ? mc.gaze_tick_ms : DEFAULT_TICK_MS
  // player_username lives at the config TOP LEVEL (not adapter.minecraft) —
  // see config.js ConfigSchema. Passed straight into resolveOwner, which
  // already handles the preferred_name vs LAN-login mismatch (260625).
  const pinUsername = config?.player_username ?? null

  let _disposed = false

  function ownerEntity() {
    if (!pinUsername || !bot) return null
    try {
      const owner = resolveOwner(bot, pinUsername, [])
      const ent = owner?.player?.entity
      return ent?.position ? ent : null
    } catch {
      return null
    }
  }

  // Re-aims only when the delta from the bot's CURRENT actual yaw/pitch is
  // meaningful — the interval cadence already throttles call frequency; this
  // additionally throttles by content so a stationary owner doesn't cause a
  // twitchy re-lookAt every tick.
  function aimAt(targetPos) {
    const aim = computeAim(bot, targetPos)
    if (!aim) return
    const curYaw = bot.entity?.yaw
    const curPitch = bot.entity?.pitch
    if (
      Number.isFinite(curYaw) && Number.isFinite(curPitch) &&
      angleDiff(aim.yaw, curYaw) < MIN_AIM_DELTA_RAD &&
      Math.abs(aim.pitch - curPitch) < MIN_AIM_DELTA_RAD
    ) {
      return
    }
    try { bot.lookAt(targetPos, true) } catch (_) {}
  }

  function tick() {
    if (_disposed) return
    if (bot._seiGazeHold > 0) return
    if (bot.isSleeping) return
    if (bot._seiReflexActive) return
    if (bot._seiOffensiveTarget != null) return
    if (bot._seiSurvivalActive) return
    if (bot._seiCriticalRetreat) return

    const me = bot.entity
    if (!me?.position) return
    const owner = ownerEntity()
    if (!owner) return

    const eyePos = typeof owner.position.offset === 'function'
      ? owner.position.offset(0, EYE_HEIGHT_FALLBACK, 0)
      : { x: owner.position.x, y: owner.position.y + EYE_HEIGHT_FALLBACK, z: owner.position.z }

    const moving = Boolean(bot.pathfinder?.isMoving?.())
    if (!moving) {
      // IDLE — including a follow that has already closed to arrival range
      // and stopped issuing path steps (isMoving() goes false there too).
      const d = dist3(owner.position, me.position)
      if (d <= rangeBlocks) aimAt(eyePos)
      return
    }

    // MOVING — only track when travel direction is already roughly toward
    // the owner (the common follow/goTo-to-owner case); otherwise the
    // pathfinder keeps sole ownership of yaw.
    const vel = me.velocity
    let travelYaw
    if (vel && (Math.abs(vel.x) > 0.02 || Math.abs(vel.z) > 0.02)) {
      travelYaw = Math.atan2(-vel.x, -vel.z)
    } else if (Number.isFinite(me.yaw)) {
      travelYaw = me.yaw
    } else {
      return
    }
    const toOwnerYaw = Math.atan2(-(owner.position.x - me.position.x), -(owner.position.z - me.position.z))
    const diffDeg = angleDiff(travelYaw, toOwnerYaw) * 180 / Math.PI
    if (diffDeg <= MOVING_CONE_DEG) aimAt(eyePos)
  }

  const interval = setInterval(tick, tickMs)

  function dispose() {
    if (_disposed) return
    _disposed = true
    clearInterval(interval)
    try { bot.removeListener('death', dispose) } catch (_) {}
    try { bot.removeListener('end', dispose) } catch (_) {}
    if (bot._seiGazeDispose === dispose) bot._seiGazeDispose = null
  }

  // Dispose on BOTH death and end. Unlike reflex/survival (whose physicsTick
  // loops go inert on a dead bot), this setInterval keeps firing after a bot
  // 'end' (kick/disconnect — no 'death' fires), leaking a live timer per
  // reconnect — so wiring 'end' here is what actually stops the leak.
  // dispose is _disposed-guarded, so firing on both is safe.
  bot.once('death', dispose)
  bot.once('end', dispose)
  bot._seiGazeDispose = dispose
  return dispose
}
