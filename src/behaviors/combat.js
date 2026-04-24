import { stopFollow, startFollow } from './follow.js'

export function startCombat(bot, config) {
  let _inCombat = false
  let _combatTimer = null

  // mineflayer 4.x uses entityHurt(entity, source) — filter for when the bot itself is hurt
  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity) return
    const attacker = source ?? null
    if (!attacker) return

    bot.emit('sei:attacked', { attacker })

    // Pause follow so it doesn't cancel the attack movement
    if (!_inCombat) {
      _inCombat = true
      stopFollow()
    }

    // Immediate retaliation hit — skip lookAt (async delay causes misses), attack packet works without facing
    const dist = bot.entity.position.distanceTo(attacker.position)
    if (dist <= 4) {
      try { bot.attack(attacker) } catch (_) {}
    }

    // Resume follow 3s after last hit
    clearTimeout(_combatTimer)
    _combatTimer = setTimeout(() => {
      _inCombat = false
      startFollow(bot, config)
    }, 3000)
  })
}
