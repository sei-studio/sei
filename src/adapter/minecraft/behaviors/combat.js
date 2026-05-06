import { stopFollow, startFollow } from './follow.js'

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch',
  'blaze', 'ghast', 'slime', 'phantom', 'drowned', 'husk', 'stray',
  'pillager', 'vindicator', 'evoker', 'ravager', 'enderman', 'endermite',
  'silverfish', 'guardian', 'elder_guardian', 'wither_skeleton', 'hoglin',
  'piglin_brute', 'zoglin',
])

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
    const attackedPayload = {
      attacker: target,
      attackerLabel: target.username ?? target.name ?? 'unknown',
      attackerKind: isPlayer ? 'player' : (HOSTILE_MOBS.has(target.name) ? 'hostile_mob' : 'other'),
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

    // Never auto-retaliate against players (REQUIREMENTS Out-of-Scope: Auto-PvP).
    // The sei:attacked event still fires so the LLM can react verbally.
    if (!isPlayer) {
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
