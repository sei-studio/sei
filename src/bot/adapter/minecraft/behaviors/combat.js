import pkg from 'mineflayer-pathfinder'
import { stopFollow, startFollow } from './follow.js'
import { createThrottle } from '../../../brain/debounce.js'
import { HOSTILE_MOBS } from './hostiles.js'

const { goals } = pkg

// Melee reach the server will accept a swing at. Matches attack.js's REACH.
const REACH = 3.5
// Pursuit goal range while closing on a mob during a DEFEND engagement. Under
// REACH so pathfinder parks the bot inside swing range on a moving target.
const DEFEND_FOLLOW_RANGE = 2

/**
 * Mobs the bot must NEVER auto-engage in melee to defend the player: closing
 * on a creeper is how you set it off, and the survival reflex is already
 * running the other way (reflex.js creeper-flee). The event still fires, so the
 * model can warn the player or place a block; it just does not walk into it.
 */
const NO_MELEE_DEFEND = new Set(['creeper', 'ghast', 'blaze', 'elder_guardian', 'ravager', 'warden'])

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
  // Defend-engagement state: whether the current engagement may WALK to its
  // target, and which entity id owns bot._seiOffensiveTarget because of it.
  let _pursue = false
  let _pursueTargetId = null

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

  // ── Defending the owner (260730) ──────────────────────────────────────────
  // Until now this listener returned immediately unless the bot ITSELF was
  // hurt, so the owner being swarmed produced no event, no reaction, and no
  // help: the companion found out only if the player said something out loud.
  // That is the whole of the "why do the mobs never go for Sui" report — in a
  // live session the mobs were as often nearer to her as to the player, and
  // she had no idea any of it was happening.
  //
  // Vanilla targeting is the reason a swing is the fix rather than positioning:
  // a mob that gets hit runs HurtByTargetGoal and switches to whoever hit it.
  // So one landed swing MOVES the aggro, and nothing else the bot can do
  // does. Automatic (like retaliation) rather than model-driven, because a
  // model round trip is 2-4s of the player taking hits, and the event still
  // fires so the turn can escalate, warn, or run.
  const defendOwner = mc.defend_owner !== false
  const defendRadius = Number.isFinite(mc.defend_radius_blocks) ? mc.defend_radius_blocks : 16
  if (throttleMs > 0) bot._seiDefendThrottle = createThrottle(throttleMs)

  function ownerNames() {
    return [config?.player_username, config?.player_display_name]
      .filter((s) => typeof s === 'string' && s.length > 0)
      .map((s) => s.toLowerCase())
  }

  /** Is this hurt entity the owner's player entity? */
  function isOwner(entity) {
    const name = entity?.username ?? entity?.name
    if (!name) return false
    return ownerNames().includes(String(name).toLowerCase())
  }

  function handleOwnerHurt(owner, source) {
    const target = resolveAttacker(bot, source)
    // No identifiable attacker, or another player hitting them (their fight,
    // and hitting a player needs the PvP opt-in anyway) — stay out of it.
    if (!target) return
    if (target === bot.entity || target.id === bot.entity?.id) return // our own spar
    if (!HOSTILE_MOBS.has(target.name)) return

    const me = bot.entity?.position
    const at = target.position
    let dist = null
    try { if (me && at) dist = me.distanceTo(at) } catch (_) { dist = null }
    if (dist == null || dist > defendRadius) return // too far to be our fight

    const payload = {
      attacker: target,
      attackerLabel: target.name ?? 'a mob',
      attackerKind: 'defend',
      ownerLabel: config?.player_display_name || owner?.username || 'the player',
      distance: Math.round(dist),
      // The model needs to know whether the body already did something, so its
      // line matches what the player is watching happen.
      engaged: false,
    }

    // Engage: swing at the mob so its aggro moves off the player. Skipped for
    // the mobs melee cannot safely answer (NO_MELEE_DEFEND), while the bot is
    // paused/AFK, while a safety reflex owns the body, or when a fight of our
    // own is already running (that one is the more urgent of the two).
    const canMelee =
      defendOwner &&
      !bot._seiPaused &&
      !NO_MELEE_DEFEND.has(target.name) &&
      !bot._seiReflexActive && !bot._seiSurvivalActive && !bot._seiCriticalRetreat &&
      (_target == null || _target.id === target.id)
    if (canMelee) {
      payload.engaged = true
      if (_target?.id !== target.id) {
        stopFollow()
        _pursueTargetId = target.id
        // Claim the deliberate-target flag so reflex.js stops kiting the mob we
        // are walking INTO (same contract attack.js uses).
        bot._seiOffensiveTarget = target.id
        startAttacking(target, { pursue: true })
      }
      clearTimeout(_exitTimer)
      _exitTimer = setTimeout(stopAttacking, 4000)
    }

    if (bot._seiDefendThrottle) {
      bot._seiDefendThrottle.throttle(`defend:${target.name}`, payload, (p) => bot.emit('sei:owner_attacked', p))
    } else {
      bot.emit('sei:owner_attacked', payload)
    }
  }

  /**
   * @param {object} target
   * @param {{ pursue?: boolean }} [opts] — `pursue` walks the bot into swing
   *   range instead of only facing + swinging from where it stands. OFF for
   *   retaliation (the bot was hit, so the attacker is already in reach, and
   *   moving would walk off the knockback stagger); ON for defending the owner,
   *   where the mob is on THEM and closing the gap is the entire point.
   */
  function startAttacking(target, { pursue = false } = {}) {
    _target = target
    _pursue = pursue
    clearInterval(_attackLoop)
    clearTimeout(_exitTimer)

    _attackLoop = setInterval(() => {
      // 260725 play/pause: an AFK player does not swing back. Drop the target
      // entirely rather than idling on it, so the fight ends at the freeze.
      if (bot._seiPaused) { stopAttacking(); return }
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

      // Defend pursuit: close the gap when the mob is out of swing range. A
      // swing from further away is silently dropped by the server, so without
      // this a "defend the player" engagement is the bot standing still
      // waving at a zombie 6 blocks away. Never touches the goal while a
      // safety reflex owns it (creeper flee / survival takeover) or during a
      // player-knockback stagger — the same ownership rules as attack.js.
      if (_pursue && !bot._seiReflexActive && !bot._seiSurvivalActive &&
          !bot._seiCriticalRetreat && !inStagger()) {
        try {
          const d = pos.distanceTo(live.position)
          if (d > REACH) bot.pathfinder?.setGoal?.(new goals.GoalFollow(live, DEFEND_FOLLOW_RANGE), true)
        } catch (_) {}
      }

      try {
        // Zombies face their target — inverting their yaw is cheaper and more reliable
        // than computing ours from bot position (which may still be stale).
        if (Number.isFinite(live.yaw)) bot.look(live.yaw + Math.PI, 0, true)
        bot.attack(live)
        bot.swingArm()
      } catch (_) {}
    }, 250)
  }

  function inStagger() {
    return bot._seiStaggerUntil != null && Date.now() < bot._seiStaggerUntil
  }

  function stopAttacking() {
    clearInterval(_attackLoop)
    clearTimeout(_exitTimer)
    _attackLoop = null
    _target = null
    // Release the deliberate-target flag so reflex.js resumes its own kiting,
    // and only if it is still OURS (a later engagement's flag must survive).
    if (_pursue && bot._seiOffensiveTarget === _pursueTargetId) bot._seiOffensiveTarget = null
    _pursue = false
    _pursueTargetId = null
    try { bot.pathfinder?.stop() } catch (_) {}
    startFollow(bot, config)
  }

  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity) {
      // 260725 play/pause: a frozen bot does not come to anyone's rescue.
      if (bot._seiPaused) return
      if (isOwner(entity)) handleOwnerHurt(entity, source)
      return
    }
    // 260725 play/pause: while the player has the game paused the bot takes
    // hits like an AFK player. No retaliation, and no sei:attacked either —
    // the FSM hold would only bank it and fire a stale panic on resume.
    if (bot._seiPaused) return

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
