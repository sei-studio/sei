import { loader as autoEat } from 'mineflayer-auto-eat'

export function startAutoEat(bot) {
  bot.loadPlugin(autoEat)
  bot.autoEat.setOpts({
    // saturation > foodPoints so cooked mutton is preferred over raw — raw
    // beats hunger but loses on saturation and risks food poisoning.
    priority: 'saturation',
    // Trigger earlier (was 14) so the bot tops up before the player has to
    // ask. 17 = "missing one drumstick" — same threshold vanilla regen needs.
    minHunger: 17,
    bannedFood: ['rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato', 'chicken'],
  })
  bot.autoEat.enableAuto()
}
