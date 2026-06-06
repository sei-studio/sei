// src/adapter/minecraft/behaviors/drop.js — toss N of an item from inventory
// across all matching slots.
//
// A naive `bot.inventory.items().find(...)` returns the FIRST matching slot
// only; `Math.min(count, invItem.count)` then caps the toss to that single
// slot's stack size. With 1+9 oak_log split across two slots, drop(10) would
// toss 1 instead of 10. We aggregate `totalAvailable` across ALL matching
// slots and issue sequential `bot.toss` calls until the request is satisfied
// or inventory is exhausted, returning "only N available" if undercount.

import { reason } from '../../../brain/errStrings.js'

export const DEFAULT_TIMEOUT_MS = 2000

export async function dropItemAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const { item } = args
  const requested = args.count ?? 1
  const matching = bot.inventory.items().filter((i) => i.name === item)
  if (matching.length === 0) return `no ${item} in inventory`

  const totalAvailable = matching.reduce((s, i) => s + i.count, 0)
  const toDrop = Math.min(requested, totalAvailable)
  const timeoutMs = args.timeout_ms ?? config?.drop_timeout_ms ?? DEFAULT_TIMEOUT_MS

  // Walk slots oldest→newest (mineflayer's items() order); per-slot toss until
  // the running total hits `toDrop`. Each toss is wrapped with the same race
  // against timeout/abort the previous single-call path used; the timeout
  // budget shrinks with each toss so the overall wall-clock cap is preserved.
  let dropped = 0
  const startedAt = Date.now()
  for (const slot of matching) {
    if (dropped >= toDrop) break
    if (signal?.aborted) break
    const remaining = toDrop - dropped
    const fromThisSlot = Math.min(remaining, slot.count)

    const elapsed = Date.now() - startedAt
    const tmoBudget = Math.max(50, timeoutMs - elapsed)

    const op = bot.toss(slot.type, slot.metadata ?? null, fromThisSlot)
      .then(() => 'ok')
      .catch((err) => {
        const r = reason(err)
        return r ? `cannot drop ${item}: ${r}` : `cannot drop ${item}`
      })
    const tmo = new Promise((r) => setTimeout(() => r(`timeout dropping ${item}`), tmoBudget))
    const abrt = new Promise((r) => {
      if (!signal) return
      signal.addEventListener('abort', () => r('aborted'), { once: true })
    })

    const result = await Promise.race([op, tmo, abrt])
    if (result === 'ok') {
      dropped += fromThisSlot
    } else {
      if (dropped > 0) return `dropped ${dropped} ${item} then ${result}`
      return result
    }
  }

  if (dropped < requested) {
    // User asked for N, only had M — surface explicitly so the LLM can react
    // ("only M available") rather than silently leave the residual
    // unaccounted.
    return `dropped ${dropped} ${item} (only ${dropped} available)`
  }
  return `dropped ${dropped} ${item}`
}
