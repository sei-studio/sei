import { loader as autoEat } from 'mineflayer-auto-eat'

// When the plugin's own trigger would eat, and what we allow instead.
//
// 261011 quality pass 2 (combat_night eval): the player said "you're fighting
// with bread". mineflayer-auto-eat 5.0.3 checks on EVERY physics tick and eats
// when health < minHealth (default 14) OR food < minHunger. Two things follow:
//  - Below 14 health with a full food bar it equips bread, activates it (the
//    server refuses: you cannot eat at 20 food), times out after 3s, re-equips
//    the old item without awaiting it, and tries again on the next tick. The
//    hand spends the whole fight holding food.
//  - Mid-fight it swaps the weapon out for food at the first missing drumstick.
// So the trigger is ours: never with a full food bar (the server will not
// allow it), never while fighting unless starving or badly hurt
// (FIGHT_EAT_HEALTH), and a failed attempt backs off instead of retrying 20
// times a second.
export const AUTO_EAT_MIN_HUNGER = 17
export const AUTO_EAT_MIN_HEALTH = 14
export const STARVING_FOOD = 6
// Mid-fight, eat anyway at or below this health (when the bar has room).
// Holding the weapon is worth less than not dying: in the pass-2 combat_night
// eval she chased a kiting skeleton from 16 to 4 health with 7 bread and a
// 17/20 food bar, never ate (fighting = no eating), and died.
export const FIGHT_EAT_HEALTH = 10
export const IN_COMBAT_MS = 5000
export const EAT_FAIL_BACKOFF_MS = 10000

/** Fighting right now: a deliberate target, or a hit taken or swung recently. */
export function inCombat(bot, now = Date.now()) {
  if (bot?._seiOffensiveTarget != null) return true
  const last = bot?._seiLastCombatAt
  return Number.isFinite(last) && now - last < IN_COMBAT_MS
}

/** Mark the bot as fighting (a swing, or a hit taken). */
export function noteCombat(bot, now = Date.now()) {
  if (bot) bot._seiLastCombatAt = now
}

/**
 * Should the bot start eating now? Pure, so it can be tested without the plugin.
 * @param {{ food?: number, health?: number }} state
 * @param {{ eating?: boolean, fighting?: boolean, backoffUntil?: number, now?: number }} ctx
 */
export function shouldAutoEat(state, ctx = {}) {
  const food = state?.food
  const health = state?.health
  if (!Number.isFinite(food) || !Number.isFinite(health)) return false
  if (ctx.eating) return false
  if (food >= 20) return false // the server refuses to eat on a full bar
  if (Number.isFinite(ctx.backoffUntil) && (ctx.now ?? Date.now()) < ctx.backoffUntil) return false
  if (ctx.fighting) return food <= STARVING_FOOD || health <= FIGHT_EAT_HEALTH
  return food < AUTO_EAT_MIN_HUNGER || health < AUTO_EAT_MIN_HEALTH
}

export function startAutoEat(bot) {
  bot.loadPlugin(autoEat)
  bot.autoEat.setOpts({
    // saturation > foodPoints so cooked mutton is preferred over raw â€” raw
    // beats hunger but loses on saturation and risks food poisoning.
    priority: 'saturation',
    // Trigger earlier (was 14) so the bot tops up before the player has to
    // ask. 17 = "missing one drumstick" â€” same threshold vanilla regen needs.
    minHunger: AUTO_EAT_MIN_HUNGER,
    minHealth: AUTO_EAT_MIN_HEALTH,
    bannedFood: ['rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato', 'chicken'],
  })
  // Replace the plugin's per-tick trigger before enableAuto binds it (it
  // registers `this.statusCheck`, so pause.js's disable/enable keep working).
  let backoffUntil = 0
  bot.autoEat.statusCheck = async () => {
    const now = Date.now()
    if (!shouldAutoEat(
      { food: bot.food, health: bot.health },
      { eating: bot.autoEat.isEating, fighting: inCombat(bot, now), backoffUntil, now },
    )) return
    try {
      await bot.autoEat.eat()
    } catch {
      backoffUntil = Date.now() + EAT_FAIL_BACKOFF_MS
    }
  }
  bot.autoEat.enableAuto()
}




