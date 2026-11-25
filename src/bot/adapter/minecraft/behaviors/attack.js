// src/behaviors/attack.js — multi-swing attack on an entity (D-22, Pitfall 5)
import pkg from 'mineflayer-pathfinder'
import { resolveEntity, isStaleHandle, nearestNamedEntityBeyondBound, handleForEntity, pickHostileForOwner, ownerEntityOf } from '../observers/targeting.js'
import { HOSTILE_MOBS, NO_AUTO_ENGAGE } from './hostiles.js'
import { isDeadEntity, recentLossByName } from '../observers/entities.js'
import { reason } from '../../../brain/errStrings.js'
import { staleGoneWhy } from '../../../brain/promptLibrary.js'
import { equipBestWeapon } from './weaponSelect.js'
import { companionMovements } from './pathfind.js'
import { followMovements } from './follow.js'
import { noteCombat } from './autoEat.js'

const { goals } = pkg

export const DEFAULT_TIMEOUT_MS = 12000
const REACH = 3.5
// Dynamic GoalFollow range while closing on a MOVING target. Kept below REACH
// (3.5) so pathfinder actually parks the bot inside swing range on a kiting mob.
const PURSUE_FOLLOW_RANGE = 2
const PURSUE_POLL_MS = 100       // pursuit loop cadence: re-check distance / re-assert goal
const SWING_DELAY_MS = 600       // matches mob attack cooldown; faster spams hits without damage
const DEATH_PACKET_WAIT_MS = 250 // after the last swing, before calling the target alive
// A repeat call for the same fight gives the current target a fresh timeout
// window, but one attackEntity never runs past this many windows in total.
const MAX_ACTION_WINDOWS = 3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// At or below this health a mob fight is two hits from death. 261011
// (combat_night eval): at 4hp she kept swinging at a skeleton while the
// player begged her to come back, and died. Critical-HP auto-retreat is off
// on purpose (survival.js, 260707), so the decision stays with the model;
// attackEntity just stops trading hits and says why.
export const CRITICAL_HP = 6
const CRITICAL_ADVICE = 'Get away first (follow the player, or goTo somewhere away from it), eat if you have food, then fight'

// Anti-stuck movement tuning shared with goTo (pathfind.js): make digging a
// last resort so pursuit routes around obstacles rather than tunnelling.
// Sprinting stays ON here, unlike goTo/follow: a chase has to close distance
// on a mob that is moving away (a skeleton backs off to shoot). With pursuit
// at a walk, the pass-2 combat_night eval had four "couldn't catch ... it
// kept its distance" (pass 1b: none), and one 12s skeleton chase took her
// from 16 to 4 health before she died. The corner wedge that sprint causes
// costs a 3.5s path reset on a walk; on a chase the goal moves every tick.
export function pursuitMovements(bot) {
  const m = companionMovements(bot)
  m.allowSprinting = true
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
 * `deadline` is an epoch ms, or a function returning one (read every poll, so
 * a running attack that is extended mid-chase keeps chasing).
 *
 * Returns 'reached' | 'gone' | 'timeout' | 'aborted'.
 */
async function pursueUntilInReach(bot, entityId, reach, deadline, signal) {
  let goalOwned = false
  let ourGoal = null
  while (true) {
    if (signal?.aborted) return 'aborted'
    if (Date.now() > (typeof deadline === 'function' ? deadline() : deadline)) return 'timeout'
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
    // 261012: re-install when something else replaced or cleared the goal
    // (a pathfinder.stop() from another behavior used to leave the chase
    // parked until its timeout, since the goal was only ever set once).
    if (goalOwned && ourGoal && bot.pathfinder?.goal !== ourGoal) goalOwned = false
    if (!goalOwned) {
      try {
        ourGoal = new goals.GoalFollow(live, PURSUE_FOLLOW_RANGE)
        bot.pathfinder.setGoal(ourGoal, true)
        goalOwned = true
      } catch (_) {}
    }
    await sleep(PURSUE_POLL_MS)
  }
}

// 260708: a mob that survives the whole batch while the bot swings a stick is
// invisible ineffectiveness — the model happily reports "i'm fighting" while
// doing ~1 damage (Lyra fought a zombie and a skeleton with a stick, at 4hp,
// while the player died twice). When the target is still alive and the held
// item is not a real weapon, say so, and point at the better move: equip the
// weapon already in the inventory if there is one, otherwise craft one.
const WEAPON_RE = /sword|_axe|trident|mace/
export function weakWeaponNote(bot) {
  const held = bot.heldItem?.name ?? null
  if (held && WEAPON_RE.test(held)) return ''
  let owned = null
  try {
    owned = (bot.inventory?.items?.() ?? []).find(it => it?.name && WEAPON_RE.test(it.name))?.name ?? null
  } catch { /* inventory unavailable — keep the generic note */ }
  const fix = owned
    ? `equip your ${owned}`
    : 'craft a weapon when you get the chance'
  return `; you're fighting with ${held ?? 'bare hands'}, which is slow: ${fix}`
}

// 261011 (quality pass 2): "the target left the entity table" is not "it
// died". A mob that walks out of tracking range or despawns disappears the
// same way, and the old result called that "killed zombie (3 hits)" (or the
// bare "target gone", which the model also read as a kill): in the
// combat_night eval she told the player a zombie or skeleton was dead five
// times while it was still around. Death is now only what the server says:
// the entity_status death event (mineflayer 'entityDead') for that entity id.
// 261111 (pass 51): a creeper that leaves the entity table mid-fight blew up
// (mobs this close to a player do not despawn, and the tracking range is far
// past a fight). The result said "NOT confirmed dead, it may still be
// around" while the event text for the same creeper said "it most likely
// exploded" (staleGoneWhy), and the judge flagged her "creeper blew up".
export function goneResult(name, hits, died) {
  if (died) return hits ? `killed ${name} (${hits} hits)` : `${name} died before you hit it`
  const lost = name === 'creeper'
    ? `lost sight of creeper: ${staleGoneWhy('creeper')}, so it is gone`
    : `lost sight of ${name}: it moved out of range or despawned, NOT confirmed dead, it may still be around`
  return hits ? `${hits} hits on ${name}, then ${lost}` : lost
}

// 261022 (pass 24): what the fight cost her. After "killed zombie (4 hits)"
// at 20/20 health she kept telling the player "got hit a little" or "it hit
// me", a flag in most quality compares since pass 6. The hp line in her
// snapshot did not stop it; the result of the fight itself now says it.
// `startHp` is her health when the action began. She usually calls
// attackEntity after a mob has already hit her, so a fight that cost nothing
// can still start below 20; the note says so, or "nothing hurt you ... you
// are at 16/20" would read as a contradiction of the hit she was told about.
export function fightHealthNote(taken, hp, startHp) {
  if (!Number.isFinite(hp)) return ''
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const now = `${fmt(Math.max(0, hp))}/20`
  if (taken > 0) return `You took ${fmt(taken)} damage in this fight and are at ${now} health.`
  if (Number.isFinite(startHp) && startHp < 20) {
    return `Nothing hurt you in this fight. You were already at ${fmt(Math.max(0, startHp))}/20 health when it started, and you are at ${now} now.`
  }
  return `Nothing hurt you in this fight: you are at ${now} health.`
}

// 261012: say where the nearest one is when a name lookup comes up empty.
// The name lookup stays bounded at 16 blocks (targeting.js); a #N handle is
// not, so that is the way to go after a mob that is farther out.
export function fartherNote(asked, bot) {
  let far = null
  try { far = nearestNamedEntityBeyondBound(asked, bot) } catch { far = null }
  if (!far) return ''
  const p = far.entity.position
  const at = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
  const tag = handleForEntity(far.entity.id)
  const how = tag
    ? `To go after it, call attackEntity with target "${tag}"; it runs there on its own.`
    : 'To go after it, goTo near it first, then attackEntity.'
  return `. The nearest ${asked} is ${Math.round(far.distance)} blocks away at ${at}. ${how}`
}

// 261019 (pass 18): when a mob of that name died or vanished next to her
// moments ago, say so. In the combat_night eval most "no zombie within 16
// blocks" results came from a turn written while the mob was there (her own
// swings, the chained fight or the player finished it during the model call,
// or a creeper blew up), and the bare result read as a failed attack.
export function justDiedNote(asked, bot) {
  let d = null
  try { d = recentLossByName(bot, asked) } catch { d = null }
  if (!d) return ''
  const s = Math.max(1, Math.round(d.age / 1000))
  return d.died
    ? `: the ${asked} that was near you died ${s}s ago, before this call, so that fight is already over`
    : `: the ${asked} that was near you disappeared ${s}s ago, before this call (${staleGoneWhy(asked)}), so there is nothing there to hit`
}

export async function attackEntityAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const entity = resolveEntity(args, bot)
  if (!entity) {
    if (isStaleHandle(args)) return 'stale target'
    const asked = typeof args?.entity === 'string' ? args.entity : (typeof args?.target === 'string' && !args.target.startsWith('#') ? args.target : null)
    if (!asked) return 'target gone'
    return `no ${asked} within 16 blocks to attack${justDiedNote(asked, bot)}${fartherNote(asked, bot)}`
  }

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
  const mobTarget = !(entity.type === 'player' || entity.username)
  const startHp = bot.health
  if (mobTarget && Number.isFinite(startHp) && startHp <= CRITICAL_HP) {
    return `did not attack ${name}: you are at ${Math.round(startHp)} health, and one or two more hits will kill you. ${CRITICAL_ADVICE}`
  }
  // 261011: hold the best weapon owned before the first swing (mobs only).
  if (mobTarget) {
    try { await equipBestWeapon(bot) } catch {}
    if (signal?.aborted) return 'aborted'
  }
  const times = clampTimes(args.times)
  const timeoutMs = args.timeout_ms ?? config?.attack_timeout_ms ?? DEFAULT_TIMEOUT_MS
  const actionStartedAt = Date.now()
  // 261011 quality pass 2: death is only what the server says (entityDead),
  // tracked per entity id so a follow-on target (below) has its own record.
  const deadIds = new Set()
  const onDead = (e) => { if (e?.id != null) deadIds.add(e.id) }
  try { bot.on?.('entityDead', onDead) } catch (_) {}
  // Health lost during this action, summed per drop so regen mid-fight does
  // not hide a hit (fightHealthNote).
  // minHp catches a death mid-fight: the respawn puts health back to 20, and
  // the note would then read as a fight she walked away from.
  let lastHp = startHp
  let minHp = startHp
  let taken = 0
  const onHealth = () => {
    const hp = bot.health
    if (Number.isFinite(hp) && Number.isFinite(lastHp) && hp < lastHp) taken += lastHp - hp
    if (Number.isFinite(hp) && !(hp >= minHp)) minHp = hp
    lastHp = hp
  }
  try { bot.on?.('health', onHealth) } catch (_) {}
  let currentId = entity.id
  let run = null
  try {
    // Set anti-stuck movements once for the whole engagement (pursueUntilInReach
    // installs GoalFollow against these). goTo resets movements on its next call.
    try { bot.pathfinder?.setMovements?.(pursuitMovements(bot)) } catch (_) {}
    // Owner defense: the first target is a hostile and the owner is known.
    // Then a second hostile near her gets one hit on the way (see tagOther).
    const ownerMode = mobTarget && HOSTILE_MOBS.has(name) && ownerEntityOf(bot) != null
    // 261019 (pass 18): `budget` is the swings this whole action may take
    // (first target plus any it chains to) and `used` the swings so far. Both
    // live on ctx so a repeat call for the same fight can add swings and a
    // fresh time window (extendAttackRun) instead of aborting and restarting.
    const ctx = {
      bot, signal, timeoutMs, startHp, deadIds, ownerMode, tagged: new Set([entity.id]), tags: 0,
      budget: times, used: 0, fightStartedAt: actionStartedAt,
      hardDeadline: actionStartedAt + timeoutMs * MAX_ACTION_WINDOWS,
      currentId,
    }
    run = { open: true, ctx, name, mobTarget }
    bot._seiAttackRun = run
    let result = await fightOne(entity, ctx)
    // 261012 (pass 4a): a kill with swings left over while the player still
    // has a hostile on them goes straight on to that one. In the
    // protect_player eval the turn after the first kill took 1-2s (once it
    // only said "zombie's dead, you good?" and ended), and the second zombie
    // killed the 4 hp player in that gap.
    while (result.died && ctx.used < ctx.budget && HOSTILE_MOBS.has(name) && !signal?.aborted) {
      if (Number.isFinite(bot.health) && bot.health <= CRITICAL_HP) break
      // Past the action's hard cap a next target would time out before its
      // first swing and read as "timeout attacking zombie" on a mob in reach.
      if (Date.now() + SWING_DELAY_MS >= ctx.hardDeadline) break
      const next = pickHostileForOwner(bot, (e) => !NO_AUTO_ENGAGE.has(e.name), {
        ownerRadius: CHAIN_OWNER_RADIUS, excludeIds: deadIds,
      }) ?? nearestTagged(bot, ctx)
      if (!next || next.id === currentId) break
      currentId = next.id
      ctx.currentId = next.id
      ctx.tagged.add(next.id)
      const r = await fightOne(next, ctx)
      result = { ...r, text: `${result.text}. Then went for the next ${next.name ?? 'mob'}: ${r.text}` }
    }
    run.open = false
    if (ctx.tags > 0) {
      const one = ctx.tags === 1
      result = { ...result, text: `${result.text}. You also hit ${one ? 'another hostile' : `${ctx.tags} other hostiles`} once on the way, so ${one ? 'it should be' : 'they should be'} coming after you now` }
    }
    // A mob fight that ran its course says what it cost her. An abort or the
    // critical-health stop (which already names her health) does not.
    // A death during the action gets no note either.
    if (mobTarget && !signal?.aborted && !/^aborted|then stopped: you are down to/.test(result.text)) {
      onHealth()
      if (!bot.on && Number.isFinite(startHp) && Number.isFinite(bot.health)) taken = Math.max(0, startHp - bot.health)
      const died = Number.isFinite(minHp) && minHp <= 0
      const note = died ? '' : fightHealthNote(taken, bot.health, startHp)
      if (note) result = { ...result, text: `${result.text}. ${note}` }
    }
    return result.text
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
    try { bot.pathfinder?.setMovements?.(followMovements(bot)) } catch (_) {}
    if (!bot._seiReflexActive && !bot._seiSurvivalActive && !bot._seiCriticalRetreat) {
      try { bot.pathfinder?.setGoal?.(null) } catch (_) {}
    }
    if (bot._seiOffensiveTarget === currentId) bot._seiOffensiveTarget = null
    if (run) run.open = false
    if (bot._seiAttackRun === run) bot._seiAttackRun = null
    try { bot.removeListener?.('entityDead', onDead) } catch (_) {}
    try { bot.removeListener?.('health', onHealth) } catch (_) {}
  }
}

/**
 * 261019 (quality pass 18): a repeat attackEntity call for the fight that is
 * already running. In the combat_night eval she aborted her own running
 * attack 27 times in 10 runs by calling attackEntity again from a mid-action
 * turn (a player line or a hit), nearly always on the mob it was already
 * on. Each restart threw away the swing rhythm, and some came back as "no
 * zombie within 16 blocks" because the first call had already killed it.
 *
 * Same fight means the mob the run is on now: by #handle, entity_id, or its
 * name (a player's username in a spar). For that, the running attack gets
 * the new call's swings added (up to the same 10 cap) and a fresh timeout
 * window, and this returns the result line for the repeat call. Anything
 * else returns null, and the new call replaces the running one as before.
 *
 * @returns {string|null}
 */
export function continueAttack(bot, running, use) {
  if (running?.name !== 'attackEntity' || use?.name !== 'attackEntity') return null
  const run = bot?._seiAttackRun
  if (!run?.open) return null
  const ctx = run.ctx
  // An attack that is being torn down (stop, pause, preempt) or is about to
  // hit its hard cap cannot keep going: let the call start a fresh attack
  // instead of answering "it keeps going" for a fight that is ending.
  if (ctx.signal?.aborted) return null
  if (Date.now() + SWING_DELAY_MS >= ctx.hardDeadline) return null
  const live = bot.entities?.[ctx.currentId]
  if (!live || ctx.deadIds.has(ctx.currentId) || isDeadEntity(bot, live)) return null
  const args = use.input ?? {}
  const same = sameFight(bot, live, args)
  if (!same && !sameKindInReach(bot, live, args)) return null
  ctx.budget = Math.max(ctx.budget, ctx.used + clampTimes(args.times))
  ctx.fightStartedAt = Date.now()
  const label = live.username ?? live.name ?? 'mob'
  const left = ctx.budget - ctx.used
  const swings = `${ctx.used} ${ctx.used === 1 ? 'swing' : 'swings'} so far`
  if (same) return `your attackEntity is already on that ${label} (${swings}), so it keeps going with up to ${left} more instead of starting over. Its result comes when the fight ends.`
  const next = attackRunState(bot)?.next
  const owner = ownerLabelOf(bot)
  const after = next && owner ? `, and after this kill it goes on by itself to the next one near ${owner}` : ''
  return `your attackEntity is already swinging at ${aMob(label)} next to you (${swings}), so it keeps going with up to ${left} more instead of switching${after}. To go for one ${label} in particular, call attackEntity with its # handle. Its result comes when the fight ends.`
}

// 261106 (quality pass 44): a repeat call by mob name while the running attack
// is swinging at a mob of that name within reach, near the player. In the combat_night eval
// (11-03 scorecard and the 10-31/11-02 compares) 16 of 22 attacks she aborted
// herself were replaced by attackEntity on the same kind of mob, nearly
// always "zombie" while she was already hitting a zombie ("aborted after 1/8
// hits", "after 5/8 hits"). The name resolved to a second zombie nearer the
// player, so the swing rhythm restarted on a mob the running attack would
// have gone on to after the kill anyway. A # handle (or an entity_id) still
// names one mob and switches to it, and so does the name when the mob she is
// hitting is not near the player (she chased it away from them).
const SAME_KIND_NEAR_OWNER = 8
// Swing reach plus the knockback a hit gives a mob between two swings.
const SAME_KIND_REACH = 5
function sameKindInReach(bot, live, args) {
  if (!live || live.username || live.type === 'player') return false
  const asked = typeof args?.entity === 'string' ? args.entity
    : (typeof args?.target === 'string' && !args.target.startsWith('#') ? args.target : null)
  if (!asked || args?.entity_id != null) return false
  if (String(asked).trim().toLowerCase() !== String(live.name ?? '').toLowerCase()) return false
  let d = null
  try { d = bot.entity?.position?.distanceTo?.(live.position) } catch { d = null }
  if (!(typeof d === 'number' && Number.isFinite(d) && d <= SAME_KIND_REACH)) return false
  const owner = ownerEntityOf(bot)
  if (!owner?.position) return true
  let dOwner = null
  try { dOwner = live.position.distanceTo(owner.position) } catch { dOwner = null }
  return typeof dOwner === 'number' && Number.isFinite(dOwner) && dOwner <= SAME_KIND_NEAR_OWNER
}

function ownerLabelOf(bot) {
  const o = ownerEntityOf(bot)
  return o?.username ?? null
}

/**
 * 261106 (quality pass 44): the running attackEntity right now, for the
 * snapshot and the defend turn. Null when no attack is running.
 *
 * In the combat_night eval (11-03 scorecard, combat_night-01 02:29) the mob
 * her attack was chasing stood in the river, where the line-of-sight filter
 * hides it from the entity list. Her snapshot showed "in_flight:
 * attackEntity(zombie)", no zombie, "aggro: none" and "recent_events: zombie
 * died", so she told the player "zombies are down" and called goTo back to
 * them ("I'll head back toward them while the swing finishes"). The goTo
 * ended the fight with two zombies 8 blocks from the player.
 *
 * @returns {{ targetId:number|null, kills:number, next:any|null }|null}
 */
export function attackRunState(bot) {
  const run = bot?._seiAttackRun
  if (!run?.open || !run.ctx) return null
  const ctx = run.ctx
  if (ctx.signal?.aborted) return null
  const live = bot.entities?.[ctx.currentId]
  const alive = !!live && !ctx.deadIds.has(ctx.currentId) && !isDeadEntity(bot, live)
  let kills = 0
  for (const id of ctx.tagged) if (ctx.deadIds.has(id)) kills++
  // What the chain after a kill would pick now (see attackEntityAction).
  let next = null
  if (run.mobTarget && HOSTILE_MOBS.has(run.name) && ctx.used < ctx.budget) {
    try {
      next = pickHostileForOwner(bot, (e) => !NO_AUTO_ENGAGE.has(e.name), {
        ownerRadius: CHAIN_OWNER_RADIUS, excludeIds: new Set([...ctx.deadIds, ctx.currentId]),
      })
    } catch { next = null }
  }
  return {
    targetId: alive ? ctx.currentId : null,
    kills,
    next,
  }
}

const blocks = (d) => { const n = Math.round(d); return `${n} ${n === 1 ? 'block' : 'blocks'}` }
const aMob = (label) => `${/^[aeiou]/i.test(String(label)) ? 'an' : 'a'} ${label}`

/**
 * The text the snapshot's in_flight line gets while attackEntity runs: the
 * kills so far and where the chain goes next. Empty string when there is
 * neither. The mob it is on is in the entity list (pinned there, see
 * snapshot.js). It leaves out the fight's distance and that a new action
 * replaces this one (the reply frame already says that): in the pass 44 probe
 * both made her finish a fight 19 blocks from a hurt player who asked her to
 * come back (goes to them 16/24 on dev, 8/24 with that text, 7/12 without).
 *
 * @param {ReturnType<typeof attackRunState>} state
 * @param {any} bot
 * @param {string|null} ownerLabel  the player's name as the snapshot shows it
 */
export function attackInFlightSuffix(state, bot, ownerLabel) {
  if (!state) return ''
  let text = state.kills > 0 ? `, ${state.kills} killed so far.` : ''
  const nx = state.next
  if (nx?.position && ownerLabel) {
    let d = null
    try { d = nx.position.distanceTo(ownerEntityOf(bot)?.position) } catch { d = null }
    const where = typeof d === 'number' && Number.isFinite(d) ? `${blocks(d)} from ${ownerLabel}` : `near ${ownerLabel}`
    const lead = state.targetId != null ? 'after this kill it' : 'it'
    text += text ? ` ${lead[0].toUpperCase()}${lead.slice(1)}` : `, ${lead}`
    text += ` goes on by itself to the ${nx.name ?? 'mob'} ${where}.`
  }
  return text
}

/**
 * The defend turn's data when the turn is written (index.js eventAddendum):
 * a hit on the player by the mob her running attackEntity is on reads as
 * handled by that action, and says when the attack will go on to another one
 * on them. In the combat_night eval (11-03 scorecard, combat_night-02 02:17)
 * the defend event fired before her attack started and was read 0.1s after:
 * "you are ALREADY swinging at it ... 1 more hostile mob on them that nothing
 * is swinging at ... call attackEntity on another one". She did, which ended
 * the attack after 1 hit, and the next turn did the same again.
 */
export function withAttackRunState(bot, event, data) {
  if (event !== 'sei:attacked' || !data || typeof data !== 'object') return data
  if (data.attackerKind !== 'defend' || data.threat || data.unarmed) return data
  let state = null
  try { state = attackRunState(bot) } catch { state = null }
  if (!state || state.targetId == null) return data
  if (data.attacker?.id !== state.targetId) return data
  return { ...data, engaged: true, actionOnIt: true, runGoesOn: state.next != null }
}

// The repeat call is on the running fight when a fresh attackEntity with the
// same arguments would pick the same mob: same id or #handle, or a name whose
// lookup (owner-threat first, then nearest) lands on it. With two zombies
// around, "zombie" can point at the one on the player; that call still
// switches targets as before.
function sameFight(bot, live, args) {
  let picked = null
  try { picked = resolveEntity(args, bot) } catch { picked = null }
  return !!picked && picked.id === live.id
}

// After a kill, attackEntity moves on to a hostile within this many blocks of
// the player (the owner-threat watch radius, combat.js).
const CHAIN_OWNER_RADIUS = 12

// 261012 (pass 4a): a mob only turns on whoever hits it, so while she fights
// one, a second hostile walks on to the player. In the protect_player eval
// the second zombie reached the 10 hp player in every trial, and the
// successes ended with the player at 1-4 hp. One hit on it on the way moves
// it onto her as well.
const TAG_RADIUS = 6       // only a mob this close to her (a step or two away)
const TAG_CHASE_MS = 2000  // and only if she reaches it this fast

/**
 * Give one hit to a hostile near her that she has not hit yet in this action
 * and that is near the owner (pickHostileForOwner's radius). Returns true when
 * a swing landed. Restores this action's offensive-target flag either way.
 */
async function tagOther(currentId, ctx) {
  const { bot, signal, deadIds, tagged } = ctx
  const me = bot.entity?.position
  if (!me) return false
  const exclude = new Set([...deadIds, ...tagged, currentId])
  const other = pickHostileForOwner(bot, (e) => {
    if (NO_AUTO_ENGAGE.has(e.name)) return false
    try { return e.position.distanceTo(me) <= TAG_RADIUS } catch { return false }
  }, { excludeIds: exclude })
  if (!other) return false
  tagged.add(other.id)
  bot._seiOffensiveTarget = other.id
  try {
    const d = me.distanceTo(other.position)
    if (d > REACH) {
      const res = await pursueUntilInReach(bot, other.id, REACH, Date.now() + TAG_CHASE_MS, signal)
      if (res !== 'reached') return false
    }
    const live = bot.entities?.[other.id]
    if (!live || deadIds.has(other.id)) return false
    bot.lookAt?.(live.position.offset(0, live.height ? live.height * 0.5 : 0.5, 0), true)
    bot.attack(live)
    noteCombat(bot)
    bot.swingArm?.()
    ctx.tags++
    return true
  } catch {
    return false
  } finally {
    // Only restore our own flag: a newer attack may have claimed it meanwhile.
    if (bot._seiOffensiveTarget === other.id) bot._seiOffensiveTarget = currentId
  }
}

/** The nearest living mob she hit in this action (it is coming for her), within 16 blocks. */
function nearestTagged(bot, ctx) {
  const me = bot.entity?.position
  if (!me) return null
  let best = null
  for (const id of ctx.tagged) {
    if (ctx.deadIds.has(id)) continue
    const e = bot.entities?.[id]
    if (!e?.position || isDeadEntity(bot, e)) continue
    let d
    try { d = e.position.distanceTo(me) } catch { continue }
    if (Number.isFinite(d) && d <= 16 && (!best || d < best.d)) best = { e, d }
  }
  return best?.e ?? null
}

/**
 * Swing at one entity until the action's swing budget (ctx.budget) is spent:
 * chase it into reach, swing, stop on
 * death, a lost target, the timeout, an abort or critical health. Returns the
 * result text, the swings landed and whether the server reported its death.
 */
async function fightOne(entity, ctx) {
  const { bot, signal, timeoutMs, startHp, deadIds } = ctx
  const name = entity.name ?? entity.displayName ?? 'entity'
  const mobTarget = !(entity.type === 'player' || entity.username)
  const entityId = entity.id
  const isPlayerTarget = entity.type === 'player' || entity.username != null
  ctx.fightStartedAt = Date.now()
  // Read live: extendAttackRun moves both the budget and the window.
  const deadline = () => Math.min(ctx.fightStartedAt + timeoutMs, ctx.hardDeadline)
  let hits = 0
  // The swings planned for this target: those landed plus what the budget has left.
  const of = () => hits + Math.max(0, ctx.budget - ctx.used)
  const died = () => deadIds.has(entityId)
  const done = (text) => ({ text, hits, died: died() })

  // Mark this mob as the deliberate offensive target so the survival reflex
  // (reflex.js) suppresses its melee circle-strafe while we are actively
  // attacking it — otherwise the reflex fights our own lookAt/positioning.
  // Cleared by the caller's finally (guarded so a newer attack's flag is
  // never clobbered).
  bot._seiOffensiveTarget = entityId
  // Attacking a player IS a PvP exchange — lock them as the reflex opponent
  // (Task 2) so reflex.js kites this player and only this player. The `at`
  // refreshes on each swing below and decays ~10s after the last blow.
  if (isPlayerTarget && bot._seiPvp) bot._seiPvpOpponent = { id: entityId, at: Date.now() }

  while (true) {
    if (ctx.used >= ctx.budget) {
      // The swings are spent. The last one can be the killing one: give the
      // death packet a moment so a kill is not reported as "still alive".
      if (!isPlayerTarget && !died()) await sleepOrAbort(DEATH_PACKET_WAIT_MS, signal)
      if (!isPlayerTarget && (died() || !bot.entities?.[entityId])) return done(goneResult(name, hits, died()))
      if (signal?.aborted) return done(`aborted after ${hits}/${of()} hits on ${name}`)
      // A repeat call for this fight may have added swings during that wait.
      if (ctx.used >= ctx.budget) break
      const waited = await sleepOrAbort(SWING_DELAY_MS - DEATH_PACKET_WAIT_MS, signal)
      if (waited === 'aborted') return done(`aborted after ${hits}/${of()} hits on ${name}`)
    }
    if (signal?.aborted) {
      return done(hits ? `aborted after ${hits}/${of()} hits on ${name}` : 'aborted')
    }
    if (Date.now() > deadline()) {
      return done(hits ? `timeout after ${hits}/${of()} hits on ${name}` : `timeout attacking ${name}`)
    }

    // A dead mob stays in the entity table for its ~1s death animation;
    // stop swinging at the corpse once the server has said it died.
    if (died()) return done(goneResult(name, hits, true))

    let live = bot.entities?.[entityId]
    if (!live) return done(goneResult(name, hits, died()))

    const dist = bot.entity?.position?.distanceTo?.(live.position)
    if (typeof dist === 'number' && dist > REACH) {
      // Chase the LIVE entity with a dynamic follow goal until in reach. The
      // overall timeout (deadline) is the ONLY give-up condition — no more
      // single-budget surrender on a kiting mob.
      const res = await pursueUntilInReach(bot, entityId, REACH, deadline, signal)
      if (res === 'aborted') return done(hits ? `aborted after ${hits}/${of()} hits on ${name}` : 'aborted')
      if (res === 'gone') return done(goneResult(name, hits, died()))
      if (res === 'timeout') {
        return done(hits
          ? `${hits}/${of()} hits, then ${name} kept its distance until time ran out`
          : `couldn't catch ${name} — it kept its distance`)
      }
      // res === 'reached'
      live = bot.entities?.[entityId]
      if (!live) return done(goneResult(name, hits, died()))
    }

    // Owner defense: before the next swing at this mob (it already took one
    // and is after her now), give a second hostile near her one hit too.
    if (hits > 0 && ctx.ownerMode) {
      const tagged = await tagOther(entityId, ctx)
      if (signal?.aborted) return done(`aborted after ${hits}/${of()} hits on ${name}`)
      if (tagged) {
        const waited = await sleepOrAbort(SWING_DELAY_MS, signal)
        if (waited === 'aborted') return done(`aborted after ${hits}/${of()} hits on ${name}`)
        if (died()) return done(goneResult(name, hits, true))
        live = bot.entities?.[entityId]
        if (!live) return done(goneResult(name, hits, died()))
        const d2 = bot.entity?.position?.distanceTo?.(live.position)
        if (typeof d2 === 'number' && d2 > REACH) {
          const res = await pursueUntilInReach(bot, entityId, REACH, deadline, signal)
          if (res === 'aborted') return done(`aborted after ${hits}/${of()} hits on ${name}`)
          if (res === 'gone') return done(goneResult(name, hits, died()))
          if (res === 'timeout') return done(`${hits}/${of()} hits, then ${name} kept its distance until time ran out`)
          live = bot.entities?.[entityId]
          if (!live) return done(goneResult(name, hits, died()))
        }
      }
    }

    // Stop trading hits once this fight has brought her to critical health.
    const hp = bot.health
    if (mobTarget && Number.isFinite(hp) && hp <= CRITICAL_HP && hp < startHp) {
      return done(`${hits}/${of()} hits on ${name}, then stopped: you are down to ${Math.round(hp)} health. ${CRITICAL_ADVICE}`)
    }
    // Re-equip before every swing: auto-eat or a placed block may have
    // changed the hand since the first one (no-op when already held).
    if (mobTarget && !bot.autoEat?.isEating) {
      try { await equipBestWeapon(bot) } catch {}
      if (signal?.aborted) return done(hits ? `aborted after ${hits}/${of()} hits on ${name}` : 'aborted')
    }

    try {
      bot.lookAt?.(live.position.offset(0, live.height ? live.height * 0.5 : 0.5, 0), true)
      bot.attack(live)
      noteCombat(bot)
      bot.swingArm?.()
      hits++
      ctx.used++
      // Refresh the PvP opponent lock on every swing so the reflex keeps
      // kiting this player through the exchange (decays ~10s after the last).
      if (isPlayerTarget && bot._seiPvp) bot._seiPvpOpponent = { id: entityId, at: Date.now() }
    } catch (err) {
      const r = reason(err)
      return done(hits
        ? `${hits}/${of()} hits then attack failed (${name}): ${r ?? 'unknown'}`
        : (r ? `attack failed (${name}): ${r}` : `attack failed (${name})`))
    }

    if (ctx.used < ctx.budget) {
      const waited = await sleepOrAbort(SWING_DELAY_MS, signal)
      if (waited === 'aborted') return done(`aborted after ${hits}/${of()} hits on ${name}`)
    }
  }

  // A spar against a player is a running exchange, not a completed task: frame
  // the result so the model keeps fighting instead of narrating an ending.
  if (isPlayerTarget) return done(`attacked ${name} ${hits}× — they're still standing and the spar is still ON; keep it going (attack again, reposition, trash-talk) until they say stop`)
  return done(`attacked ${name} ${hits}× (target still alive)${weakWeaponNote(bot)}`)
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
