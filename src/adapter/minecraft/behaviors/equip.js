// src/behaviors/equip.js — equip an item to a slot (D-22)
import { reason } from '../../../brain/errStrings.js'

export const DEFAULT_TIMEOUT_MS = 2000

export async function equipAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const { item, destination } = args
  const invItem = bot.inventory.items().find((i) => i.name === item)
  if (!invItem) return `no ${item} in inventory`

  const dest = destination ?? 'hand'
  const timeoutMs = args.timeout_ms ?? config?.equip_timeout_ms ?? DEFAULT_TIMEOUT_MS

  const op = bot.equip(invItem, destination)
    .then(() => `equipped ${item} to ${dest}`)
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
