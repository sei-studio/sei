// src/behaviors/lookAt.js — orient head toward coord/entity (D-22)
import { Vec3 } from 'vec3'
import { resolveEntity, isStaleHandle } from '../observers/targeting.js'

export const DEFAULT_TIMEOUT_MS = 2000

export async function lookAtAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const timeoutMs = args.timeout_ms ?? config?.lookAt_timeout_ms ?? DEFAULT_TIMEOUT_MS

  let opPromise

  if (typeof args.x === 'number' && typeof args.y === 'number' && typeof args.z === 'number') {
    const point = new Vec3(args.x, args.y + 1.6, args.z)
    opPromise = bot.lookAt(point)
      .then(() => 'looked')
      .catch(() => 'cannot look')
  } else if ((typeof args.target === 'string' && args.target.startsWith('#')) || typeof args.entity === 'string') {
    const ent = resolveEntity(args, bot)
    if (!ent) return isStaleHandle(args) ? 'stale target' : 'no target'
    const head = (ent.height ?? 1.6)
    opPromise = bot.lookAt(ent.position.offset(0, head, 0))
      .then(() => 'looked')
      .catch(() => 'cannot look')
  } else {
    // Empty args: refresh-only no-op.
    return 'looked'
  }

  const tmo = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))

  const abrt = new Promise((r) => {
    if (!signal) return
    signal.addEventListener('abort', () => r('aborted'), { once: true })
  })

  return Promise.race([opPromise, tmo, abrt])
}
