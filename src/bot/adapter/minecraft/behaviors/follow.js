import pkg from 'mineflayer-pathfinder'
import { sessionActionStats } from '../../../brain/actionStats.js'
import { climbOut, escapeUp, pitInfo, MIN_PIT_DEPTH } from './climbOut.js'
import { goTo, protectBuiltBlocks } from './pathfind.js'
const { pathfinder, Movements, goals } = pkg

/**
 * The Movements the follow trail uses: the pathfinder defaults (follow keeps
 * digCost 1 so it can still tunnel after the player), minus sprinting.
 * 261011: a sprint-jump wedges the bot mid-air on block corners (see
 * companionMovements in pathfind.js for the measurement), which read as a
 * follow that stalled 20 blocks behind on a hillside.
 */
export function followMovements(bot) {
  const m = new Movements(bot)
  m.allowSprinting = false
  // 261016: the trail tunnels after the player, but not through a build.
  protectBuiltBlocks(bot, m)
  return m
}

// Catch-up sprint while trailing: a walking bot loses about a block a second
// to a sprinting player, so the trail sprints while it is far behind and
// walks again once close. The pathfinder reads allowSprinting live each tick.
export const FOLLOW_SPRINT_ON_DIST = 10
export const FOLLOW_SPRINT_OFF_DIST = 6

/** Sprint decision with hysteresis; returns the new allowSprinting value. */
export function followSprintFor(dist, current) {
  if (dist >= FOLLOW_SPRINT_ON_DIST) return true
  if (dist <= FOLLOW_SPRINT_OFF_DIST) return false
  return !!current
}

let _bot = null
let _config = null
let _interval = null

// Active follow target. Either { kind: 'player', username } or
// { kind: 'entity', entityId, label }. null = not following.
let _target = null

// No-progress / unreachable detection (260617). The bare Movements below can
// only climb by placing scaffolding blocks the bot is carrying, so a sheer
// slope with a dirt-poor inventory yields NO path and GoalFollow silently
// idles â€” the body sits still while the target walks away (the cliff freeze in
// the play log). follow had no timeout/unreachable signal at all (unlike goTo).
// These track last position + last forward progress so the 1s tick can flag
// `_stuck`, which the snapshot surfaces so the model reacts instead of
// narrating "the follow is working fine" for 55s.
const STUCK_MS = 6000
let _lastPos = null
let _lastProgressAt = 0
let _stuck = null // null | { stuckSec, dist, targetY, deltaY }

// 261015: the trail's own climb out of a 1x1 shaft (see climbOut.js). GoalFollow
// from the bottom of a shaft towered a block per ~5s or tunnelled along under
// the player (errands eval: 30s of follow, still 6 blocks down). The tick
// runs climbOut once instead, then resumes the trail from the rim.
let _climb = null // null | AbortController of the climb in progress
const CLIMB_BUDGET_MS = 20000
// After a climb that failed (no blocks, walls she cannot dig), leave the hole
// to GoalFollow for a while instead of re-running the same climb every tick.
const CLIMB_RETRY_MS = 30000
let _climbFailedAt = 0
// 261019: startFollow({keepMovements}) left another walk's movements in place.
let _movementsOwed = false

function cancelClimb() {
  if (_climb) { try { _climb.abort() } catch {} }
  _climb = null
}

/** The follow tick is climbing out of a hole right now. */
export function isFollowClimbing() {
  return _climb != null
}

export function setFollowTarget(t) {
  // Reset the progress clock on every (re)assignment so a fresh follow never
  // inherits a stale stuck state.
  _stuck = null
  _lastPos = null
  _lastProgressAt = Date.now()
  cancelClimb()
  _climbFailedAt = 0
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
 * 260607 â€” follow is now PERSISTENT state. The abort does NOT clear `_target`
 * anymore: an abort is almost always a player chat waking the suspended loop,
 * and clearing on it made every message cancel the follow (churn). The 1s
 * background tick below keeps trailing as long as `_target` is set, so the bot
 * stays on the owner while the model answers a chat. `_target` is cleared ONLY
 * by `unfollow` or by an explicit relocate (`goTo` and `explore`, which call
 * setFollowTarget(null) â€” explore added 260710 after a live run where the
 * follow tick yanked the bot straight back from every explore hop); incidental
 * actions (dig/gather/build) leave it set so the bot resumes trailing once
 * they finish. follow.js itself does not consume the signal â€” the registry
 * handler owns the long-running lifecycle.
 */
export function startFollow(bot, config, { keepMovements = false } = {}) {
  _bot = bot
  // Resolve the minecraft adapter slice â€” the caller passes the top-level
  // config, but follow_range lives at config.adapter.minecraft.follow_range.
  // Without this resolution we silently pass `undefined` to GoalFollow and
  // get mineflayer-pathfinder's built-in default (1), so the configured
  // range never takes effect.
  const mc = config?.adapter?.minecraft ?? config ?? {}
  const range = Number.isFinite(mc.follow_range) ? mc.follow_range : 3
  _config = { follow_range: range }

  if (!bot.hasPlugin(pathfinder)) bot.loadPlugin(pathfinder)
  // 261019: keepMovements leaves a walk that owns the pathfinder (a goTo,
  // a reflex flee) on its own movements; the tick puts the trail's back
  // when it next installs GoalFollow.
  _movementsOwed = keepMovements
  if (!keepMovements) bot.pathfinder.setMovements(followMovements(bot))

  // No default target â€” the LLM decides whether to call follow(player) on the
  // join event. Hardcoding it caused the body to drift toward the player
  // between every gap in LLM-issued movement.

  // GoalFollow with dynamic=true tracks the entity itself, so we don't need
  // to recompute paths each tick. We only re-install when the pathfinder is
  // idle and our goal isn't currently set â€” this yields naturally to any
  // LLM-issued movement action (goTo, dig, etc.) without an explicit pause.
  clearInterval(_interval)
  _interval = setInterval(() => {
    // 260725 play/pause: the body is frozen, so do not re-install the follow
    // goal or judge progress. `_target` is KEPT â€” the player pressing play
    // resumes trailing where it left off. The progress clock is held at "now"
    // so a long pause never surfaces as a bogus stuck report on resume.
    // A climb out of a hole stops too (261016 review): left running, its
    // staircase kept digging and its scaffold kept jumping through the pause.
    if (bot._seiPaused) { cancelClimb(); _stuck = null; _lastPos = null; _lastProgressAt = Date.now(); return }
    if (!_target) { _stuck = null; _lastPos = null; return }
    const ent = resolveTargetEntity()
    const me = bot?.entity
    if (!ent || !me) return // target or self not loaded â€” can't assess progress
    // Re-install the follow goal when the pathfinder has gone idle (yields to
    // any LLM-issued movement without an explicit pause). Also yield while a
    // reflex creeper-flee owns the goal (bot._seiReflexActive, Plan 01 mutex):
    // re-installing GoalFollow here would fight the flee tick-for-tick. The flee
    // restores the prior goal when it clears, and this tick resumes naturally.
    // Also yield to a survival takeover (bot._seiSurvivalActive / _seiCriticalRetreat,
    // survival.js â€” the drowning swim-up / critical-HP flee): re-installing here
    // would tug against the flee whenever the pathfinder momentarily idles.
    // Also hold off while digIn is holding position (bot._seiHoldPosition > 0):
    // re-installing GoalFollow(owner) between dig primitives walks the bot out of
    // the half-dug hole (Fix 5). And hold off during a player-knockback stagger
    // window (Task 3): while bot._seiStaggerUntil is in the future, re-installing
    // GoalFollow would path the bot straight back and walk off the knockback the
    // stagger is meant to let play out. The window is ~350ms; the next tick resumes.
    const staggering = bot._seiStaggerUntil != null && Date.now() < bot._seiStaggerUntil
    const holding = bot._seiHoldPosition > 0
    const yielding = bot._seiReflexActive || bot._seiSurvivalActive || bot._seiCriticalRetreat || holding || staggering
    if (_climb) {
      // A reflex or survival takeover owns the body: drop the climb, the
      // next tick starts a fresh one if she is still in the hole.
      if (yielding) cancelClimb()
      return
    }
    // 261015: in a 1x1 shaft with the target above the rim, climb out first.
    if (!yielding && ent.position.y >= me.position.y + MIN_PIT_DEPTH && me.onGround !== false && !me.isInWater &&
        Date.now() - _climbFailedAt >= CLIMB_RETRY_MS) {
      const pit = pitInfo(bot)
      const inPit = pit && pit.rimY != null && pit.depth >= MIN_PIT_DEPTH
      // Any other hole: only once the trail has stalled (the stuck clock
      // below), since GoalFollow may still be on its way out.
      const stalled = _stuck && ent.position.y >= me.position.y + MIN_PIT_DEPTH + 1
      if (inPit || stalled) {
        const ctl = new AbortController()
        _climb = ctl
        try { bot.pathfinder.setGoal(null) } catch {}
        const climb = inPit
          ? climbOut(bot, ent.position, { signal: ctl.signal, budgetMs: CLIMB_BUDGET_MS })
          : escapeUp(bot, ent.position, { signal: ctl.signal, budgetMs: CLIMB_BUDGET_MS, goTo })
        climb
          // Anything but a climb (failed, or climbOut judged it no pit after
          // all) backs off, so the tick does not restart it every second and
          // starve GoalFollow.
          .then((r) => { if (r?.status !== 'climbed' && r?.status !== 'aborted') _climbFailedAt = Date.now() })
          .catch(() => {})
          .finally(() => {
            if (_climb === ctl) _climb = null
            _lastProgressAt = Date.now()
            _stuck = null
            // escapeUp's walk to the open column swaps in no-dig, no-place
            // goTo movements on the shared pathfinder. Put the trail's own
            // back while the trail still owns the body (not after a goTo or
            // unfollow took over, nor under a reflex flee).
            const owned = _target && _bot === bot &&
              !bot._seiReflexActive && !bot._seiSurvivalActive && !bot._seiCriticalRetreat
            if (owned) { try { bot.pathfinder.setMovements(followMovements(bot)) } catch {} }
          })
        return
      }
    }
    if (!bot.pathfinder.isMoving() && !yielding) {
      if (_movementsOwed) {
        _movementsOwed = false
        try { bot.pathfinder.setMovements(followMovements(bot)) } catch {}
      }
      bot.pathfinder.setGoal(new goals.GoalFollow(ent, _config.follow_range), true)
    }
    // No-progress tracking: stuck = not moving AND still far from the target
    // for STUCK_MS. Cleared the instant we move or get within range.
    const pos = me.position
    const dist = pos.distanceTo(ent.position)
    // Only touch the movements while the trail owns the goal, never a goTo's.
    const goal = bot.pathfinder.goal
    const mv = bot.pathfinder.movements
    if (mv && goal instanceof goals.GoalFollow && goal.entity === ent) {
      mv.allowSprinting = followSprintFor(dist, mv.allowSprinting)
    }
    const moved = _lastPos ? pos.distanceTo(_lastPos) : 99
    const t = Date.now()
    if (moved > 0.6 || dist <= _config.follow_range + 2) {
      _lastProgressAt = t
      _stuck = null
    } else if (t - _lastProgressAt >= STUCK_MS) {
      // 261011: count each fresh stuck episode once (telemetry).
      if (!_stuck) { try { sessionActionStats.noteStuck() } catch {} }
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

/**
 * 261019 (quality pass 19): stop the trail's tick for a moment WITHOUT
 * forgetting who she follows. combat.js used stopFollow() whenever a mob hit
 * her, which cleared the target for good: after one zombie hit she stopped
 * trailing the player while the follow action still said "still trailing
 * them" (combat_night eval: follow_target "(none)" for most of each night).
 * startFollow() resumes the tick with the target intact.
 */
export function pauseFollow() {
  cancelClimb()
  clearInterval(_interval)
  _interval = null
  _stuck = null
  _lastPos = null
}

export function stopFollow() {
  cancelClimb()
  clearInterval(_interval)
  _interval = null
  _target = null
  _bot = null
  _config = null
  _stuck = null
  _lastPos = null
}




