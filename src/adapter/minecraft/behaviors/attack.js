// src/behaviors/attack.js — multi-swing attack on an entity (D-22, Pitfall 5)
import { resolveEntity, isStaleHandle } from '../observers/targeting.js'
import { goTo } from './pathfind.js'
import { reason } from '../../../brain/errStrings.js'

export const DEFAULT_TIMEOUT_MS = 12000
const REACH = 3.5
const PURSUE_RANGE = 2.5         // close to within swing reach before swinging
const PURSUE_BUDGET_MS = 2500    // per-pursuit pathfind cap
const SWING_DELAY_MS = 600       // matches mob attack cooldown; faster spams hits without damage

export async function attackEntityAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const entity = resolveEntity(args, bot)
  if (!entity) return isStaleHandle(args) ? 'stale target' : 'target gone'

  // Refuse Players — REQUIREMENTS Out-of-Scope: Auto-PvP.
  if (entity.type === 'player' || entity.username) return 'cannot attack player'

  const name = entity.name ?? entity.displayName ?? 'entity'
  const times = clampTimes(args.times)
  const timeoutMs = args.timeout_ms ?? config?.attack_timeout_ms ?? DEFAULT_TIMEOUT_MS
  const entityId = entity.id
  const startedAt = Date.now()

  let hits = 0
  for (let i = 0; i < times; i++) {
    if (signal?.aborted) {
      return hits ? `aborted after ${hits}/${times} hits on ${name}` : 'aborted'
    }
    if (Date.now() - startedAt > timeoutMs) {
      return hits ? `timeout after ${hits}/${times} hits on ${name}` : `timeout attacking ${name}`
    }

    let live = bot.entities?.[entityId]
    if (!live) {
      return hits ? `killed ${name} (${hits} hits)` : 'target gone'
    }

    let dist = bot.entity?.position?.distanceTo?.(live.position)
    if (typeof dist === 'number' && dist > REACH) {
      // Pursue: close the gap, then re-check. Built-in follow so the LLM
      // doesn't have to orchestrate follow+attack.
      const remaining = timeoutMs - (Date.now() - startedAt)
      const budget = Math.min(PURSUE_BUDGET_MS, remaining)
      if (budget < 250) {
        return hits ? `timeout after ${hits}/${times} hits on ${name}` : `timeout chasing ${name}`
      }
      await goTo(bot, live.position.x, live.position.y, live.position.z, PURSUE_RANGE, budget)
      if (signal?.aborted) return hits ? `aborted after ${hits}/${times} hits on ${name}` : 'aborted'
      live = bot.entities?.[entityId]
      if (!live) return hits ? `killed ${name} (${hits} hits)` : 'target gone'
      dist = bot.entity?.position?.distanceTo?.(live.position)
      if (typeof dist === 'number' && dist > REACH) {
        // Still out of reach after a chase — burn this iteration and try again.
        // Avoids spinning on a fleeing mob with zero forward progress.
        if (i === times - 1) {
          return hits
            ? `${hits}/${times} hits then lost ${name} (${dist.toFixed(1)}m after chase)`
            : `cant catch ${name} (${dist.toFixed(1)}m after chase)`
        }
        continue
      }
    }

    try {
      bot.lookAt?.(live.position.offset(0, live.height ? live.height * 0.5 : 0.5, 0), true)
      bot.attack(live)
      bot.swingArm?.()
      hits++
    } catch (err) {
      const r = reason(err)
      return hits
        ? `${hits}/${times} hits then attack failed (${name}): ${r ?? 'unknown'}`
        : (r ? `attack failed (${name}): ${r}` : `attack failed (${name})`)
    }

    if (i < times - 1) {
      const waited = await sleepOrAbort(SWING_DELAY_MS, signal)
      if (waited === 'aborted') return `aborted after ${hits}/${times} hits on ${name}`
    }
  }

  return `attacked ${name} ${hits}× (target still alive)`
}

function clampTimes(t) {
  const n = Number.isFinite(t) ? Math.floor(t) : 1
  if (n < 1) return 1
  if (n > 10) return 10
  return n
}

function sleepOrAbort(ms, signal) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve('done') } }, ms)
    if (signal) {
      const onAbort = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve('aborted')
      }
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
