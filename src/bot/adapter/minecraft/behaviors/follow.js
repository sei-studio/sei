import pkg from 'mineflayer-pathfinder'
const { pathfinder, Movements, goals } = pkg

let _bot = null
let _config = null
let _interval = null

// Active follow target. Either { kind: 'player', username } or
// { kind: 'entity', entityId, label }. null = not following.
let _target = null

export function setFollowTarget(t) {
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

function resolveTargetEntity() {
  if (!_target || !_bot) return null
  if (_target.kind === 'player') return _bot.players?.[_target.username]?.entity ?? null
  return _bot.entities?.[_target.entityId] ?? null
}

/**
 * Abort contract (260516-0yw): follow is now an OPEN-ENDED long-runner. The
 * registry handler in src/bot/adapter/minecraft/registry.js installs the
 * follow target and BLOCKS on the AbortSignal until the orchestrator aborts
 * (P0/P1 preempt, R2/R3/R4 dispatch, or the model calls unfollow). When the
 * signal fires, the handler clears the target via `setFollowTarget(null)` and
 * resolves with `aborted: follow <label>`. The 1s background pathfinder tick
 * in this file remains a no-op when `_target` is null, so clearing the target
 * is enough to stop the bot's body movement; the AbortSignal is the channel
 * that drives that target-clear. follow.js itself does not consume the
 * signal — the registry handler owns the long-running lifecycle.
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
    if (!_target) return
    if (bot.pathfinder.isMoving()) return
    const ent = resolveTargetEntity()
    if (!ent) return
    bot.pathfinder.setGoal(new goals.GoalFollow(ent, _config.follow_range), true)
  }, 1000)
}

export function stopFollow() {
  clearInterval(_interval)
  _interval = null
  _target = null
  _bot = null
  _config = null
}
