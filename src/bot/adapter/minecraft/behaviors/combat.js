import pkg from 'mineflayer-pathfinder'
import { pauseFollow, startFollow } from './follow.js'
import { pursuitMovements } from './attack.js'
import { createThrottle } from '../../../brain/debounce.js'
import { HOSTILE_MOBS, NO_MELEE_DEFEND, NO_AUTO_ENGAGE } from './hostiles.js'
import { equipBestWeapon, keepWeaponInHand, lostWeaponUnarmed } from './weaponSelect.js'
import { noteCombat } from './autoEat.js'
import { ownerHealth } from '../observers/snapshot.js'
import { isDeadEntity, trackEntityDeaths } from '../observers/entities.js'

const { goals } = pkg

// Melee reach the server will accept a swing at. Matches attack.js's REACH.
const REACH = 3.5
// Pursuit goal range while closing on a mob during a DEFEND engagement. Under
// REACH so pathfinder parks the bot inside swing range on a moving target.
const DEFEND_FOLLOW_RANGE = 2

// NO_MELEE_DEFEND (hostiles.js): mobs the bot never auto-engages in melee to
// defend the player. The event still fires, so the model can warn the player
// or place a block; it just does not walk into it.
// 261012: owner-threat watch cadence and thresholds (see watchOwnerThreats).
const THREAT_TICK_MS = 500
// A mob counts as closing when it got this much nearer the owner in one tick
// (a chasing zombie covers ~1.1 blocks per 500ms; idle wandering is slower
// and changes direction).
const THREAT_CLOSING_MIN = 0.3
const THREAT_REPEAT_MS = 15000
// "On the player" for the defend turn's count of mobs nothing is swinging at.
const OTHERS_ON_OWNER_RADIUS = 5

// The owner-threat watch tells the turn to attackEntity the mob, so it skips
// the mobs melee cannot safely answer and the enderman, which is neutral until
// provoked and wanders toward players all the time (in the End there are
// dozens, and two "closing" at once would wake her every few seconds to start
// a fight nobody was in).
const NO_THREAT_WATCH = NO_AUTO_ENGAGE

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
  trackEntityDeaths(bot)
  let _target = null
  let _attackLoop = null
  let _exitTimer = null
  // Defend-engagement state: whether the current engagement may WALK to its
  // target, and which entity id owns bot._seiOffensiveTarget because of it.
  let _pursue = false
  let _pursueTargetId = null
  // Whether this engagement swapped in the sprinting pursuit movements.
  let _pursueMovesSet = false

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
  // 261012 (pass 4a): attackEntity's by-name lookup (targeting.js
  // pickHostileForOwner) needs the owner too, to go for the mob nearest them.
  bot._seiOwnerNames = ownerNames()

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

    let ownerHp = null
    try { ownerHp = ownerHealth(bot.registry, owner) } catch { ownerHp = null }
    const payload = {
      attacker: target,
      attackerLabel: target.name ?? 'a mob',
      attackerKind: 'defend',
      ownerLabel: config?.player_display_name || owner?.username || 'the player',
      distance: Math.round(dist),
      // The model needs to know whether the body already did something, so its
      // line matches what the player is watching happen.
      engaged: false,
      // 261012: the automatic swing covers ONE mob. With a second one on the
      // player the turn has to take it (protect_player eval: the turn said
      // "on it" and nothing else, and the other zombie killed a 10 hp player).
      othersOnOwner: hostilesNear(owner, OTHERS_ON_OWNER_RADIUS, target.id).length,
      ownerHp,
    }

    // Engage: swing at the mob so its aggro moves off the player. Skipped for
    // the mobs melee cannot safely answer (NO_MELEE_DEFEND), while the bot is
    // paused/AFK, while a safety reflex owns the body, or when a fight of our
    // own is already running (that one is the more urgent of the two).
    // 261012: an attackEntity action already owns the body (it set
    // _seiOffensiveTarget; ours is tracked as _pursueTargetId). Taking over
    // here used to wreck that chase: this engagement's 4s exit called
    // pathfinder.stop() and attack.js never re-installed its goal, so in the
    // protect_player eval she stood still for several seconds 9 blocks from
    // the zombie that was on the player. Same mob: report it as handled by
    // the action. Another mob: hold, the turn decides.
    const actionTarget = _target == null && bot._seiOffensiveTarget != null ? bot._seiOffensiveTarget : null
    if (actionTarget != null) {
      payload.engaged = actionTarget === target.id
      payload.actionOnIt = actionTarget === target.id
    }
    // 261030 (quality pass 31): not after a death took her weapon. Bare
    // hands do 1 damage a swing, and in the combat_night eval this chase and
    // the turns that followed it killed her again and again once a first
    // death had dropped her sword (13 of 18 deaths in two runs). A bot that
    // never had a weapon still punches to pull aggro (the 260730 design).
    // The event still fires, and the turn is told why (index.js).
    const canMelee =
      actionTarget == null &&
      defendOwner &&
      !lostWeaponUnarmed(bot) &&
      !bot._seiPaused &&
      !NO_MELEE_DEFEND.has(target.name) &&
      !bot._seiReflexActive && !bot._seiSurvivalActive && !bot._seiCriticalRetreat &&
      (_target == null || _target.id === target.id)
    if (canMelee) {
      payload.engaged = true
      if (_target?.id !== target.id) {
        // 261019: pause the trail, keep its target (resumed in stopAttacking).
        pauseFollow()
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

  /** Living hostile mobs within `radius` of an entity (excluding one id). */
  function hostilesNear(center, radius, excludeId = null) {
    const out = []
    const at = center?.position
    if (!at) return out
    for (const e of Object.values(bot.entities ?? {})) {
      if (!e || e === bot.entity || e.username || !e.position) continue
      if (!HOSTILE_MOBS.has(e.name) || e.id === excludeId) continue
      if (isDeadEntity(bot, e)) continue
      let d
      try { d = e.position.distanceTo(at) } catch { continue }
      if (Number.isFinite(d) && d <= radius) out.push({ entity: e, distance: d })
    }
    return out
  }

  // ── Owner threat watch (261012) ───────────────────────────────────────────
  // The defend engagement above fires only once a mob has HIT the owner. At
  // low health that is one or two hits from their death, and a model round
  // trip on top of it is too slow (quality eval protect_player, a 10 hp player
  // and two zombies 21 blocks out: in 4 of 5 trials the order turn called
  // follow, which never swings, the loop ended, nothing else woke the brain
  // until the first hit, and the second zombie killed the player). This watch
  // wakes the brain while the mob is still on its way: a hostile within
  // ownerThreatRadius of the owner that is getting closer to them, when the
  // owner is hurt (ownerThreatHp or less) or two or more are closing. It
  // swings nothing itself; the turn decides (attackEntity, a block, a
  // warning). Skipped while a fight is already running (our own attackEntity
  // or an automatic engagement) and once per mob per THREAT_REPEAT_MS.
  const ownerThreatHp = Number.isFinite(mc.owner_threat_hp) ? mc.owner_threat_hp : 12
  const ownerThreatRadius = Number.isFinite(mc.owner_threat_radius_blocks) ? mc.owner_threat_radius_blocks : 12
  const lastOwnerDist = new Map()
  const threatAnnouncedAt = new Map()

  function ownerEntity() {
    const want = ownerNames()
    if (!want.length) return null
    for (const [name, p] of Object.entries(bot.players ?? {})) {
      if (p?.entity && want.includes(String(name).toLowerCase())) return p.entity
    }
    return null
  }

  function watchOwnerThreats() {
    if (!defendOwner || ownerThreatRadius <= 0 || bot._seiPaused) return
    const owner = ownerEntity()
    const me = bot.entity
    if (!owner?.position || !me?.position) { lastOwnerDist.clear(); return }
    const seen = new Set()
    const closing = []
    for (const { entity: e, distance: dOwner } of hostilesNear(owner, ownerThreatRadius)) {
      if (NO_THREAT_WATCH.has(e.name)) continue
      let dMe
      try { dMe = e.position.distanceTo(me.position) } catch { continue }
      if (!Number.isFinite(dMe) || dMe > defendRadius + ownerThreatRadius) continue
      seen.add(e.id)
      const prev = lastOwnerDist.get(e.id)
      lastOwnerDist.set(e.id, dOwner)
      if (prev != null && prev - dOwner >= THREAT_CLOSING_MIN) closing.push({ e, dOwner, dMe })
    }
    for (const id of [...lastOwnerDist.keys()]) if (!seen.has(id)) lastOwnerDist.delete(id)
    if (closing.length === 0) return
    if (_target || bot._seiOffensiveTarget != null) return
    if (bot._seiReflexActive || bot._seiSurvivalActive || bot._seiCriticalRetreat) return
    let hp = null
    try { hp = ownerHealth(bot.registry, owner) } catch { hp = null }
    const hurt = hp != null && hp <= ownerThreatHp
    if (!hurt && closing.length < 2) return
    const now = Date.now()
    closing.sort((a, b) => a.dOwner - b.dOwner)
    const fresh = closing.find((c) => now - (threatAnnouncedAt.get(c.e.id) ?? 0) >= THREAT_REPEAT_MS)
    if (!fresh) return
    for (const c of closing) threatAnnouncedAt.set(c.e.id, now)
    for (const [id, at] of [...threatAnnouncedAt]) if (now - at > THREAT_REPEAT_MS * 4) threatAnnouncedAt.delete(id)
    bot.emit('sei:owner_attacked', {
      attacker: fresh.e,
      attackerLabel: fresh.e.name ?? 'a mob',
      attackerKind: 'defend',
      threat: true,
      ownerLabel: config?.player_display_name || owner?.username || 'the player',
      distance: Math.round(fresh.dMe),
      ownerDistance: Math.round(fresh.dOwner),
      ownerHp: hp,
      count: closing.length,
      engaged: false,
    })
  }
  if (defendOwner && ownerThreatRadius > 0) {
    const threatTimer = setInterval(() => {
      try { watchOwnerThreats() } catch (_) {}
    }, THREAT_TICK_MS)
    threatTimer.unref?.()
    try { bot.on('end', () => clearInterval(threatTimer)) } catch (_) {}
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
    // 261011: swing the best weapon owned, not whatever is in hand. Skipped
    // while an action runs (it may be holding a tool or block on purpose)
    // and against players (a spar stays at whatever they agreed to).
    const isPlayerTarget = Boolean(target?.username) || target?.type === 'player'
    if (!isPlayerTarget && !(bot._seiActionActive > 0)) {
      equipBestWeapon(bot).catch(() => {})
    }

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
          // 261012 (pass 4a): install the follow goal once and keep it. It is
          // dynamic, so the pathfinder already tracks the moving mob; setting
          // a fresh goal every 250ms reset the path and cleared the controls
          // four times a second, so the run toward the player stuttered.
          const g = bot.pathfinder?.goal
          const ours = g instanceof goals.GoalFollow && g.entity?.id === live.id
          if (d > REACH && !ours) {
            if (!_pursueMovesSet) {
              try { bot.pathfinder?.setMovements?.(pursuitMovements(bot)) } catch (_) {}
              _pursueMovesSet = true
            }
            bot.pathfinder?.setGoal?.(new goals.GoalFollow(live, DEFEND_FOLLOW_RANGE), true)
          }
        } catch (_) {}
      }

      // Keep the weapon in hand for the whole fight, not just the first swing
      // (same skip rules as the equip in startAttacking above).
      const playerTarget = Boolean(live.username) || live.type === 'player'
      if (!playerTarget && !(bot._seiActionActive > 0)) keepWeaponInHand(bot)

      try {
        // Zombies face their target — inverting their yaw is cheaper and more reliable
        // than computing ours from bot position (which may still be stale).
        // 261019 (pass 19): not while an action's walk is moving the body
        // (a goTo the player asked for, resumed through the fight). The
        // pathfinder steers by yaw, so turning to the mob every 250ms walked
        // her sideways off the route until the walk gave up as "stuck".
        // She still swings at a mob in reach.
        const walking = !_pursue && bot._seiActionActive > 0 && bot.pathfinder?.isMoving?.()
        if (!walking && Number.isFinite(live.yaw)) bot.look(live.yaw + Math.PI, 0, true)
        bot.attack(live)
        bot.swingArm()
        noteCombat(bot)
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
    const pursuedId = _pursueTargetId
    // Release the deliberate-target flag so reflex.js resumes its own kiting,
    // and only if it is still OURS (a later engagement's flag must survive).
    if (_pursue && bot._seiOffensiveTarget === _pursueTargetId) bot._seiOffensiveTarget = null
    _pursue = false
    _pursueTargetId = null
    _pursueMovesSet = false // startFollow below puts the follow movements back
    // 261019 (quality pass 19): stop the pathfinder only when the goal is this
    // engagement's own pursuit (or there is none). Retaliation never sets a
    // goal, and its 1s exit used to stop whatever walk was running: a goTo or
    // pickup hit by a zombie on the way failed as "cant_reach (closest=3.4m)"
    // on open ground, and a creeper flee lost its goal the same way.
    const g = bot.pathfinder?.goal
    const ownPursuit = pursuedId != null && g instanceof goals.GoalFollow && g.entity?.id === pursuedId
    const foreign = g != null && !ownPursuit
    if (!foreign) { try { bot.pathfinder?.stop() } catch (_) {} }
    startFollow(bot, config, { keepMovements: foreign })
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

    // Any hit taken counts as fighting (auto-eat holds off, see autoEat.js).
    noteCombat(bot)

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
    // 261030 (pass 31): after a death took her weapon the turn is told to get
    // away, and this loop turning her to the mob every 250ms fought that
    // advice. A bot that never had one still swings back.
    if ((!isPlayer || bot._seiPvp) && !(!isPlayer && lostWeaponUnarmed(bot))) {
      if (_target?.id !== target.id) {
        // 261019 (pass 19): pause the trail but keep who she follows.
        // stopFollow() here forgot the follow target on every mob hit.
        pauseFollow()
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
