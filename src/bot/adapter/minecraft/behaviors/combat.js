import { stopFollow, startFollow } from './follow.js'
import { createThrottle } from '../../../brain/debounce.js'
import { HOSTILE_MOBS } from './hostiles.js'

function resolveAttacker(bot, source) {
  // Trust an identified source first — including players. The previous
  // fallback scanned for "any nearby hostile mob" when the source wasn't
  // hostile, which made a player punch get blamed on a creeper 24 blocks
  // away. If the source is identifiable, return it as-is and let downstream
  // decide what to do with a non-mob attacker.
  const live = source?.id != null ? bot.entities[source.id] : null
  if (live) return live
  if (source?.name || source?.username) return source
  // Truly unknown source (no id, no name): scan for a *close* hostile only.
  // Far-off creepers are not the attacker in any realistic scenario.
  const me = bot.entity
  for (const e of Object.values(bot.entities)) {
    if (e === me) continue
    if (!HOSTILE_MOBS.has(e?.name)) continue
    if (!me?.position || !e?.position) continue
    try {
      if (e.position.distanceTo(me.position) <= 6) return e
    } catch {}
  }
  return null
}

export function startCombat(bot, config) {
  let _target = null
  let _attackLoop = null
  let _exitTimer = null

  // ── Per-bot runtime flags (NOT persisted; reset each session) ──────────────
  // Goal / control ownership rules these flags participate in:
  //  • bot._seiPvp (default false): PvP spar mode, toggled ONLY by the setPvp
  //    tool. Read by attack.js (allow player targets), reflex.js (kite players),
  //    and the retaliation branch below. It owns NO goal — it just gates policy.
  //  • bot._seiStaggerUntil (timestamp): a short window opened here on a PLAYER
  //    hit. During it, reflex.js and follow.js SKIP asserting movement controls
  //    and attack.js pursuit yields, so the server knockback plays out. It is a
  //    plain timestamp — it does NOT touch bot._seiSavedGoal, so it never
  //    collides with the creeper-flee goal mutex (bot._seiReflexActive).
  //  • The goal-owning reflexes (creeper-flee via _seiReflexActive/_seiSavedGoal)
  //    and attack.js pursuit remain the authoritative goal owners; stagger only
  //    pauses re-assertion, it never snapshots or restores a goal.
  if (bot._seiPvp == null) bot._seiPvp = false
  const mcSlice = config?.adapter?.minecraft ?? config ?? {}
  const staggerMs = Number.isFinite(mcSlice.player_stagger_ms) ? mcSlice.player_stagger_ms : 350

  // Leading-edge throttle for sei:attacked emission. The entityHurt handler
  // below has ALWAYS referenced bot._seiAttackThrottle, but nothing ever
  // assigned it — so the throttle was dead and EVERY hit emitted a sei:attacked
  // (the throttle's `else` fallback). Under sustained attack that produced a
  // preempt storm: each hit aborted the in-flight LLM reaction and reseeded the
  // loop ~every 300-500ms, faster than Haiku could answer, so the bot never
  // completed a single reaction (zero say / zero combat action — the "Sui is
  // frozen and silent in fights" bug). Actually instantiating it here collapses
  // a burst of hits into one reaction per window. windowMs=0 disables (tests).
  const mc = config?.adapter?.minecraft ?? config ?? {}
  const throttleMs = Number.isFinite(mc.attack_react_throttle_ms) ? mc.attack_react_throttle_ms : 3500
  if (throttleMs > 0) bot._seiAttackThrottle = createThrottle(throttleMs)

  function startAttacking(target) {
    _target = target
    clearInterval(_attackLoop)
    clearTimeout(_exitTimer)

    _attackLoop = setInterval(() => {
      if (!_target) return
      const live = bot.entities[_target.id]
      if (!live) return

      // Knockback packets occasionally produce transient non-finite velocity/position.
      // Do NOT rewrite bot.entity.* — that's anti-cheat-detectable client-side teleport
      // and was causing repeated server kicks. Skip this tick; mineflayer's normal
      // physics will restore valid state on the next packet.
      const vel = bot.entity?.velocity
      const pos = bot.entity?.position
      if (!vel || !pos) return
      if (!Number.isFinite(vel.x) || !Number.isFinite(vel.y) || !Number.isFinite(vel.z)) return
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return

      try {
        // Zombies face their target — inverting their yaw is cheaper and more reliable
        // than computing ours from bot position (which may still be stale).
        if (Number.isFinite(live.yaw)) bot.look(live.yaw + Math.PI, 0, true)
        bot.attack(live)
        bot.swingArm()
      } catch (_) {}
    }, 250)
  }

  function stopAttacking() {
    clearInterval(_attackLoop)
    clearTimeout(_exitTimer)
    _attackLoop = null
    _target = null
    try { bot.pathfinder?.stop() } catch (_) {}
    startFollow(bot, config)
  }

  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity) return

    const target = resolveAttacker(bot, source)
    if (!target) return

    const isPlayer = Boolean(target.username) || target.type === 'player'

    // ── PvP opponent lock (Task 2) ────────────────────────────────────────────
    // When a player lands a hit and PvP spar mode is on, lock them as THE
    // opponent so reflex.js circle-strafes only this player (not the owner or a
    // bystander). The `at` timestamp refreshes on every hit and decays ~10s after
    // the last blow, so the bot can idle/talk between rounds with PvP still armed.
    if (isPlayer && bot._seiPvp && target.id != null) {
      bot._seiPvpOpponent = { id: target.id, at: Date.now() }
    }

    // ── Player-knockback stagger (Task 3) ─────────────────────────────────────
    // A player landing a hit opens a short window during which the movement
    // controllers (reflex strafe, follow re-path, attack pursuit) stop asserting
    // controls so the server's knockback impulse is visible instead of being
    // walked off. We clear controls now and briefly stop the pathfinder; follow's
    // 1s tick re-installs its goal after the window (its target is persistent),
    // and a creeper-flee goal is left untouched. We NEVER rewrite
    // bot.entity.velocity/position (anti-cheat kicks — see the NaN-skip comment
    // below). Trade-off: an in-flight goTo gets interrupted (returns cant_reach)
    // when punched mid-navigation; acceptable for a deliberate melee hit.
    if (isPlayer && staggerMs > 0) {
      bot._seiStaggerUntil = Date.now() + staggerMs
      try { bot.clearControlStates?.() } catch (_) {}
      // Do NOT stop the pathfinder while a P0 safety escape/takeover owns the
      // goal: a creeper-flee (bot._seiReflexActive) or a survival takeover
      // (drowning swim-up / critical-HP retreat — bot._seiSurvivalActive /
      // _seiCriticalRetreat). Clearing the goal here would strand the escape —
      // reflex's active-flee tick only re-checks distance/panic, it never
      // re-issues its setGoal, so the flee goal would stay cleared and the bot
      // would stand next to a fusing creeper and die (an owner punch with PvP
      // off must never cancel a safety escape). The stagger's control clear is
      // enough; the flee keeps its goal and its knockback plays out anyway.
      if (!bot._seiReflexActive && !bot._seiSurvivalActive && !bot._seiCriticalRetreat) {
        try { bot.pathfinder?.stop?.() } catch (_) {}
      }
    }

    const attackedPayload = {
      attacker: target,
      attackerLabel: target.username ?? target.name ?? 'unknown',
      attackerKind: isPlayer ? 'player' : (HOSTILE_MOBS.has(target.name) ? 'hostile_mob' : 'other'),
      // Surface the live PvP flag so the prompt addendum can pick "hit back"
      // (PvP on) vs "you can't hit back" (PvP off) framing at injection time.
      pvp: Boolean(bot._seiPvp),
    }
    // Leading-edge throttle: react to the FIRST hit immediately; suppress
    // rapid follow-ups within the throttle window so a burst of entityHurt
    // events triggers exactly one LLM dispatch (and that dispatch happens
    // on the first hit, not after a 500ms quiet period).
    if (bot._seiAttackThrottle) {
      bot._seiAttackThrottle.throttle(`attacked:${target?.username ?? 'unknown'}`, attackedPayload, (p) => bot.emit('sei:attacked', p))
    } else {
      bot.emit('sei:attacked', attackedPayload)
    }

    // Auto-retaliate against mobs always, and against players ONLY when PvP mode
    // is on (bot._seiPvp) — a spar the player opted into. With PvP off we keep
    // the original "never hit back at a player" behavior (the sei:attacked event
    // still fires so the LLM can react verbally). The 250ms attack loop only
    // faces + swings (no movement controls), so it does not walk off the stagger
    // knockback above; reflex.js circle-strafes the opponent for positioning.
    if (!isPlayer || bot._seiPvp) {
      if (_target?.id !== target.id) {
        stopFollow()
        startAttacking(target)
      }
      clearTimeout(_exitTimer)
      _exitTimer = setTimeout(stopAttacking, 1000)
    }
  })

  bot.on('entityGone', (entity) => {
    if (_target && entity.id === _target.id) stopAttacking()
  })
}
