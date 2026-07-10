import pkg from 'mineflayer-pathfinder'
const { pathfinder, Movements, goals } = pkg

let _bot = null
let _config = null
let _interval = null

// Active follow target. Either { kind: 'player', username } or
// { kind: 'entity', entityId, label }. null = not following.
let _target = null

// No-progress / unreachable detection (260617). The bare Movements below can
// only climb by placing scaffolding blocks the bot is carrying, so a sheer
// slope with a dirt-poor inventory yields NO path and GoalFollow silently
// idles — the body sits still while the target walks away (the cliff freeze in
// the play log). follow had no timeout/unreachable signal at all (unlike goTo).
// These track last position + last forward progress so the 1s tick can flag
// `_stuck`, which the snapshot surfaces so the model reacts instead of
// narrating "the follow is working fine" for 55s.
const STUCK_MS = 6000
let _lastPos = null
let _lastProgressAt = 0
let _stuck = null // null | { stuckSec, dist, targetY, deltaY }

export function setFollowTarget(t) {
  // Reset the progress clock on every (re)assignment so a fresh follow never
  // inherits a stale stuck state.
  _stuck = null
  _lastPos = null
  _lastProgressAt = Date.now()
  if (t == null) { _target = null; return }
  if (t.kind === 'player' && typeof t.username === 'string') {
    _target = { kind: 'player', username: t.username }
  } else if (t.kind === 'entity' && Number.isFinite(t.entityId)) {
    _target = { kind: 'entity', entityId: t.entityId, label: t.label || `entity-${t.entityId}` }
  }
}

export function getFollowTargetLabel() {
  if (!_target) return null
  return _target.kind === 'player' ? _target.username : _target.label
}

// Stuck info for the snapshot composer: null when following normally, or
// { stuckSec, dist, targetY, deltaY } when the bot has made no forward progress
// toward a still-distant target for STUCK_MS (e.g. the target climbed terrain
// the pathfinder can't scale).
export function getFollowStuckInfo() {
  return _stuck
}

function resolveTargetEntity() {
  if (!_target || !_bot) return null
  if (_target.kind === 'player') return _bot.players?.[_target.username]?.entity ?? null
  return _bot.entities?.[_target.entityId] ?? null
}

/**
 * Abort contract (260516-0yw; revised 260607): follow is an OPEN-ENDED
 * long-runner. The registry handler installs the follow target and BLOCKS on
 * the AbortSignal until the orchestrator aborts (player-chat preempt, R2/R3/R4
 * dispatch, or the model calls unfollow).
 *
 * 260607 — follow is now PERSISTENT state. The abort does NOT clear `_target`
 * anymore: an abort is almost always a player chat waking the suspended loop,
 * and clearing on it made every message cancel the follow (churn). The 1s
 * background tick below keeps trailing as long as `_target` is set, so the bot
 * stays on the owner while the model answers a chat. `_target` is cleared ONLY
 * by `unfollow` or by an explicit relocate (`goTo` and `explore`, which call
 * setFollowTarget(null) — explore added 260710 after a live run where the
 * follow tick yanked the bot straight back from every explore hop); incidental
 * actions (dig/gather/build) leave it set so the bot resumes trailing once
 * they finish. follow.js itself does not consume the signal — the registry
 * handler owns the long-running lifecycle.
 */
export function startFollow(bot, config) {
  _bot = bot
  // Resolve the minecraft adapter slice — the caller passes the top-level
  // config, but follow_range lives at config.adapter.minecraft.follow_range.
  // Without this resolution we silently pass `undefined` to GoalFollow and
  // get mineflayer-pathfinder's built-in default (1), so the configured
  // range never takes effect.
  const mc = config?.adapter?.minecraft ?? config ?? {}
  const range = Number.isFinite(mc.follow_range) ? mc.follow_range : 3
  _config = { follow_range: range }

  if (!bot.hasPlugin(pathfinder)) bot.loadPlugin(pathfinder)
  bot.pathfinder.setMovements(new Movements(bot))

  // No default target — the LLM decides whether to call follow(player) on the
  // join event. Hardcoding it caused the body to drift toward the player
  // between every gap in LLM-issued movement.

  // GoalFollow with dynamic=true tracks the entity itself, so we don't need
  // to recompute paths each tick. We only re-install when the pathfinder is
  // idle and our goal isn't currently set — this yields naturally to any
  // LLM-issued movement action (goTo, dig, etc.) without an explicit pause.
  clearInterval(_interval)
  _interval = setInterval(() => {
    if (!_target) { _stuck = null; _lastPos = null; return }
    const ent = resolveTargetEntity()
    const me = bot?.entity
    if (!ent || !me) return // target or self not loaded — can't assess progress
    // Re-install the follow goal when the pathfinder has gone idle (yields to
    // any LLM-issued movement without an explicit pause). Also yield while a
    // reflex creeper-flee owns the goal (bot._seiReflexActive, Plan 01 mutex):
    // re-installing GoalFollow here would fight the flee tick-for-tick. The flee
    // restores the prior goal when it clears, and this tick resumes naturally.
    // Also yield to a survival takeover (bot._seiSurvivalActive / _seiCriticalRetreat,
    // survival.js — the drowning swim-up / critical-HP flee): re-installing here
    // would tug against the flee whenever the pathfinder momentarily idles.
    // Also hold off while digIn is holding position (bot._seiHoldPosition > 0):
    // re-installing GoalFollow(owner) between dig primitives walks the bot out of
    // the half-dug hole (Fix 5). And hold off during a player-knockback stagger
    // window (Task 3): while bot._seiStaggerUntil is in the future, re-installing
    // GoalFollow would path the bot straight back and walk off the knockback the
    // stagger is meant to let play out. The window is ~350ms; the next tick resumes.
    const staggering = bot._seiStaggerUntil != null && Date.now() < bot._seiStaggerUntil
    const holding = bot._seiHoldPosition > 0
    if (
      !bot.pathfinder.isMoving() && !bot._seiReflexActive &&
      !bot._seiSurvivalActive && !bot._seiCriticalRetreat && !holding && !staggering
    ) {
      bot.pathfinder.setGoal(new goals.GoalFollow(ent, _config.follow_range), true)
    }
    // No-progress tracking: stuck = not moving AND still far from the target
    // for STUCK_MS. Cleared the instant we move or get within range.
    const pos = me.position
    const dist = pos.distanceTo(ent.position)
    const moved = _lastPos ? pos.distanceTo(_lastPos) : 99
    const t = Date.now()
    if (moved > 0.6 || dist <= _config.follow_range + 2) {
      _lastProgressAt = t
      _stuck = null
    } else if (t - _lastProgressAt >= STUCK_MS) {
      _stuck = {
        stuckSec: Math.round((t - _lastProgressAt) / 1000),
        dist: Math.round(dist),
        targetY: Math.round(ent.position.y),
        deltaY: Math.round(ent.position.y - pos.y),
      }
    }
    _lastPos = pos.clone()
  }, 1000)
}

export function stopFollow() {
  clearInterval(_interval)
  _interval = null
  _target = null
  _bot = null
  _config = null
  _stuck = null
  _lastPos = null
}
