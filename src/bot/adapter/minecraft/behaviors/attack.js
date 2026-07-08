// src/behaviors/attack.js — multi-swing attack on an entity (D-22, Pitfall 5)
import pkg from 'mineflayer-pathfinder'
import { resolveEntity, isStaleHandle } from '../observers/targeting.js'
import { reason } from '../../../brain/errStrings.js'

const { goals, Movements } = pkg

export const DEFAULT_TIMEOUT_MS = 12000
const REACH = 3.5
// Dynamic GoalFollow range while closing on a MOVING target. Kept below REACH
// (3.5) so pathfinder actually parks the bot inside swing range on a kiting mob.
const PURSUE_FOLLOW_RANGE = 2
const PURSUE_POLL_MS = 100       // pursuit loop cadence: re-check distance / re-assert goal
const SWING_DELAY_MS = 600       // matches mob attack cooldown; faster spams hits without damage

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Anti-stuck movement tuning shared with goTo (pathfind.js): make digging a
// last resort so pursuit routes around obstacles rather than tunnelling.
function pursuitMovements(bot) {
  const m = new Movements(bot)
  m.digCost = 8
  m.maxDropDown = 4
  return m
}

function inStaggerWindow(bot) {
  return bot._seiStaggerUntil != null && Date.now() < bot._seiStaggerUntil
}

/**
 * Close on a MOVING entity with a DYNAMIC follow goal until within `reach`, the
 * `deadline` elapses, or the target dies/despawns. The old code snapshotted a
 * STATIC coordinate and pathed to it for one 2.5s budget, so a kiting skeleton
 * outran the stale point and the bot gave up after a single chase. GoalFollow
 * with dynamic=true lets pathfinder recompute toward the LIVE entity every tick,
 * so the target is actually run down under the caller's overall timeout.
 *
 * Goal ownership (see attackEntityAction finally): the pursuit installs its own
 * goal, so it YIELDS to a creeper-flee that owns the goal (bot._seiReflexActive)
 * and to a player-knockback stagger window, re-asserting once either clears. The
 * caller's finally releases sprint + the goal.
 *
 * Returns 'reached' | 'gone' | 'timeout' | 'aborted'.
 */
async function pursueUntilInReach(bot, entityId, reach, deadline, signal) {
  let goalOwned = false
  while (true) {
    if (signal?.aborted) return 'aborted'
    if (Date.now() > deadline) return 'timeout'
    const live = bot.entities?.[entityId]
    if (!live || !live.position) return 'gone'
    const dist = bot.entity?.position?.distanceTo?.(live.position)
    if (typeof dist === 'number' && dist <= reach) return 'reached'
    // Yield the goal to a creeper-flee (Plan 01 mutex), a survival takeover
    // (drowning swim-up / critical-HP retreat — survival.js re-asserts its flee
    // goal on any foreign goal_updated, so fighting it would just waste the
    // pursuit budget), or a stagger window; don't fight them tick-for-tick.
    // Re-assert once they clear.
    if (bot._seiReflexActive || bot._seiSurvivalActive || bot._seiCriticalRetreat || inStaggerWindow(bot)) {
      goalOwned = false
      await sleep(PURSUE_POLL_MS)
      continue
    }
    if (!goalOwned) {
      try {
        bot.pathfinder.setGoal(new goals.GoalFollow(live, PURSUE_FOLLOW_RANGE), true)
        bot.setControlState('sprint', true)
        goalOwned = true
      } catch (_) {}
    }
    await sleep(PURSUE_POLL_MS)
  }
}

export async function attackEntityAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const entity = resolveEntity(args, bot)
  if (!entity) return isStaleHandle(args) ? 'stale target' : 'target gone'

  // Refuse Players unless PvP mode is ON (bot._seiPvp, toggled by the setPvp
  // tool). When OFF this keeps the original refusal + message; when ON the
  // player is a legal target so the companion can spar (Task 2a).
  if ((entity.type === 'player' || entity.username) && !bot._seiPvp) return 'cannot attack player — PvP spar mode is off; if they asked to fight/spar, call setPvp({enabled:true}) first, then attack'

  // Refuse item-class entities. Dropped items, xp
  // orbs, and global entities (lightning) cannot die — the dispatch wastes
  // iterations chasing them and the model never learns they are non-targets
  // unless we surface a clear refusal here. The `entity.name === 'item'`
  // check covers mineflayer versions where dropped items report differently.
  if (entity.type === 'object' || entity.name === 'item') {
    const label = entity.name === 'item' ? 'item' : (entity.name ?? 'object')
    return `cannot attack ${label} (dropped item entity)`
  }
  if (entity.type === 'orb') {
    return 'cannot attack xp orb'
  }
  if (entity.type === 'global') {
    return 'cannot attack global entity'
  }

  const name = entity.name ?? entity.displayName ?? 'entity'
  const times = clampTimes(args.times)
  const timeoutMs = args.timeout_ms ?? config?.attack_timeout_ms ?? DEFAULT_TIMEOUT_MS
  const entityId = entity.id
  const isPlayerTarget = entity.type === 'player' || entity.username != null
  const startedAt = Date.now()

  // Mark this mob as the deliberate offensive target so the survival reflex
  // (reflex.js) suppresses its melee circle-strafe while we are actively
  // attacking it — otherwise the reflex fights our own lookAt/positioning.
  // Cleared on every exit path (finally) and guarded so a newer attack's flag
  // is never clobbered.
  bot._seiOffensiveTarget = entityId
  // Attacking a player IS a PvP exchange — lock them as the reflex opponent
  // (Task 2) so reflex.js kites this player and only this player. The `at`
  // refreshes on each swing below and decays ~10s after the last blow.
  if (isPlayerTarget && bot._seiPvp) bot._seiPvpOpponent = { id: entityId, at: Date.now() }
  try {
    // Set anti-stuck movements once for the whole engagement (pursueUntilInReach
    // installs GoalFollow against these). goTo resets movements on its next call.
    try { bot.pathfinder?.setMovements?.(pursuitMovements(bot)) } catch (_) {}
    let hits = 0
    for (let i = 0; i < times; i++) {
      if (signal?.aborted) {
        return hits ? `aborted after ${hits}/${times} hits on ${name}` : 'aborted'
      }
      if (Date.now() - startedAt > timeoutMs) {
        return hits ? `timeout after ${hits}/${times} hits on ${name}` : `timeout attacking ${name}`
      }

      let live = bot.entities?.[entityId]
      if (!live) {
        return hits ? `killed ${name} (${hits} hits)` : 'target gone'
      }

      let dist = bot.entity?.position?.distanceTo?.(live.position)
      if (typeof dist === 'number' && dist > REACH) {
        // Chase the LIVE entity with a dynamic follow goal until in reach. The
        // overall timeout (deadline) is the ONLY give-up condition — no more
        // single-budget surrender on a kiting mob.
        const deadline = startedAt + timeoutMs
        const res = await pursueUntilInReach(bot, entityId, REACH, deadline, signal)
        if (res === 'aborted') return hits ? `aborted after ${hits}/${times} hits on ${name}` : 'aborted'
        if (res === 'gone') return hits ? `killed ${name} (${hits} hits)` : 'target gone'
        if (res === 'timeout') {
          return hits
            ? `${hits}/${times} hits, then ${name} kept its distance until time ran out`
            : `couldn't catch ${name} — it kept its distance`
        }
        // res === 'reached'
        live = bot.entities?.[entityId]
        if (!live) return hits ? `killed ${name} (${hits} hits)` : 'target gone'
      }

      try {
        bot.lookAt?.(live.position.offset(0, live.height ? live.height * 0.5 : 0.5, 0), true)
        bot.attack(live)
        bot.swingArm?.()
        hits++
        // Refresh the PvP opponent lock on every swing so the reflex keeps
        // kiting this player through the exchange (decays ~10s after the last).
        if (isPlayerTarget && bot._seiPvp) bot._seiPvpOpponent = { id: entityId, at: Date.now() }
      } catch (err) {
        const r = reason(err)
        return hits
          ? `${hits}/${times} hits then attack failed (${name}): ${r ?? 'unknown'}`
          : (r ? `attack failed (${name}): ${r}` : `attack failed (${name})`)
      }

      if (i < times - 1) {
        const waited = await sleepOrAbort(SWING_DELAY_MS, signal)
        if (waited === 'aborted') return `aborted after ${hits}/${times} hits on ${name}`
      }
    }

    // A spar against a player is a running exchange, not a completed task: frame
    // the result so the model keeps fighting instead of narrating an ending.
    if (isPlayerTarget) return `attacked ${name} ${hits}× — they're still standing and the spar is still ON; keep it going (attack again, reposition, trash-talk) until they say stop`
    return `attacked ${name} ${hits}× (target still alive)`
  } finally {
    // Release the sprint + pursuit goal we installed. NEVER yank a creeper-flee's
    // goal (bot._seiReflexActive) OR a survival takeover's flee goal
    // (bot._seiSurvivalActive / _seiCriticalRetreat): those own the goal and
    // restore/re-assert it themselves, so nulling it here would just wipe an
    // active flee (survival re-asserts on goal_updated, but the wipe is a needless
    // race). When none is active, clearing to null lets the 1s follow tick
    // (follow.js) re-install GoalFollow(owner) if a follow target is set — the
    // single-owner restore convention.
    try { bot.setControlState?.('sprint', false) } catch (_) {}
    // Restore the default Movements. We swapped in pursuitMovements (digCost=8,
    // maxDropDown=4) globally for the chase; the pathfinder keeps whatever
    // Movements were last set, and follow.js installs its bare `new Movements`
    // only ONCE at startFollow (it re-installs GoalFollow each tick WITHOUT
    // resetting movements). So without this the companion would trail with
    // pursuit movements (permitting larger drops) after every fight until the
    // next goTo() reset them. Reset here so they never leak past the engagement.
    try { bot.pathfinder?.setMovements?.(new Movements(bot)) } catch (_) {}
    if (!bot._seiReflexActive && !bot._seiSurvivalActive && !bot._seiCriticalRetreat) {
      try { bot.pathfinder?.setGoal?.(null) } catch (_) {}
    }
    if (bot._seiOffensiveTarget === entityId) bot._seiOffensiveTarget = null
  }
}

function clampTimes(t) {
  const n = Number.isFinite(t) ? Math.floor(t) : 1
  if (n < 1) return 1
  if (n > 10) return 10
  return n
}

function sleepOrAbort(ms, signal) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve('done') } }, ms)
    if (signal) {
      const onAbort = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve('aborted')
      }
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
