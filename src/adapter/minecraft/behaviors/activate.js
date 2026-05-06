// src/behaviors/activate.js — activate the held item (right-click) (D-22)
import { reason } from '../../../brain/errStrings.js'

export const DEFAULT_TIMEOUT_MS = 2000

export async function activateItemAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const heldName = bot.heldItem?.name ?? 'nothing'
  if (heldName === 'nothing') return 'cannot activate: holding nothing'

  const timeoutMs = args?.timeout_ms ?? config?.activate_timeout_ms ?? DEFAULT_TIMEOUT_MS

  const op = Promise.resolve()
    .then(() => bot.activateItem())
    .then(() => `activated ${heldName}`)
    .catch((err) => {
      const r = reason(err)
      return r ? `cannot activate ${heldName}: ${r}` : `cannot activate ${heldName}`
    })

  const tmo = new Promise((r) => setTimeout(() => r(`timeout activating ${heldName}`), timeoutMs))

  const abrt = new Promise((r) => {
    if (!signal) return
    signal.addEventListener('abort', () => r('aborted'), { once: true })
  })

  return Promise.race([op, tmo, abrt])
}
