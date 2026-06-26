// src/behaviors/activateBlock.js — activate a world block: door / gate /
// trapdoor / button / lever (MCRAFT-05, D-09).
//
// Clones activate.js's handler shell (signal guard → timeout race → reason()
// formatting) but swaps the core call to bot.activateBlock(target). This uses
// the block-interact packet, NOT use_item, so it is unaffected by mineflayer
// #3742 (the broken bot.activateItem on MC 1.21+). The target is resolved via
// resolveBlock + a reach check, mirroring container.js.
import { resolveBlock, isStaleHandle } from '../observers/targeting.js'
import { reason } from '../../../brain/errStrings.js'

export const DEFAULT_TIMEOUT_MS = 2000
const REACH = 4

export async function activateBlockAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const target = await resolveBlock(args, bot)
  if (!target) return isStaleHandle(args) ? 'stale target' : 'no target'

  const dist = bot.entity?.position?.distanceTo?.(target.position)
  if (typeof dist === 'number' && dist > REACH) {
    return `target out of reach (${dist.toFixed(1)}m, need ≤${REACH})`
  }

  const targetName = target.name ?? 'block'
  const timeoutMs = args?.timeout_ms ?? config?.activateBlock_timeout_ms ?? DEFAULT_TIMEOUT_MS

  const op = Promise.resolve()
    .then(() => bot.activateBlock(target))
    .then(() => `opened ${targetName}`)
    .catch((err) => {
      const r = reason(err)
      return r ? `cannot open ${targetName}: ${r}` : `cannot open ${targetName}`
    })

  const tmo = new Promise((r) => setTimeout(() => r(`timeout opening ${targetName}`), timeoutMs))

  const abrt = new Promise((r) => {
    if (!signal) return
    signal.addEventListener('abort', () => r('aborted'), { once: true })
  })

  return Promise.race([op, tmo, abrt])
}
