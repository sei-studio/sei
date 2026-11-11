// src/behaviors/equip.js — equip an item to a slot (D-22)
import { reason } from '../../../brain/errStrings.js'
import { armorSlotFor, wornArmor } from './armor.js'

export const DEFAULT_TIMEOUT_MS = 2000

// 261111 (user feedback ae9a758e, "won't put on what I give her"): armor goes
// to its own slot whatever destination the model passed (it is not useful in
// a hand), and a piece she already wears answers "already wearing" instead of
// "no X in inventory": worn armor is not in bot.inventory.items().
export async function equipAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const { item } = args
  const armorSlot = armorSlotFor(item)
  const dest = armorSlot ?? args.destination ?? 'hand'
  const invItem = bot.inventory.items().find((i) => i.name === item)
  if (!invItem) {
    if (armorSlot && wornArmor(bot).some((w) => w.slot === armorSlot && w.item.name === item)) {
      return `already wearing ${item}`
    }
    return `no ${item} in inventory`
  }

  const timeoutMs = args.timeout_ms ?? config?.equip_timeout_ms ?? DEFAULT_TIMEOUT_MS
  const done = armorSlot ? `put on ${item}` : `equipped ${item} to ${dest}`

  const op = bot.equip(invItem, dest)
    .then(() => done)
    .catch((err) => {
      const r = reason(err)
      return r ? `cannot equip ${item} to ${dest}: ${r}` : `cannot equip ${item} to ${dest}`
    })

  const tmo = new Promise((r) => setTimeout(() => r(`timeout equipping ${item}`), timeoutMs))

  const abrt = new Promise((r) => {
    if (!signal) return
    signal.addEventListener('abort', () => r('aborted'), { once: true })
  })

  return Promise.race([op, tmo, abrt])
}
