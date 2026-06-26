import pkg from 'mineflayer-pathfinder'
const { Movements, goals } = pkg

/** @typedef {'reached' | 'cant_reach' | 'timeout' | 'no_bot' | 'aborted'} PathfindResult */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Yield to a reflex-owned pathfinder goal (Plan 01 mutex). While
 * `bot._seiReflexActive` is true a creeper flee owns the goal; installing our
 * own goal would race it tick-for-tick. Park here — non-destructively, we never
 * stop()/abort the action — until the flee releases the goal, the abort signal
 * fires, or the wall-clock budget elapses. The flee restores `bot._seiSavedGoal`
 * (this action's goal) on exit, so the caller resumes its original destination.
 *
 * @param {object} bot
 * @param {AbortSignal} [signal]
 * @param {number} [budgetMs]
 * @returns {Promise<'clear'|'aborted'|'timeout'>}
 */
export async function waitForReflexClear(bot, signal, budgetMs = 12000) {
  if (!bot?._seiReflexActive) return 'clear'
  const deadline = Date.now() + budgetMs
  while (bot._seiReflexActive) {
    if (signal?.aborted) return 'aborted'
    if (Date.now() >= deadline) return 'timeout'
    await sleep(120)
  }
  return 'clear'
}

/**
 * D-09: append `unreachable — try build to Y=N` when pathfinder failure
 * (cant_reach or timeout) is plausibly caused by elevation. Heuristic:
 * target.y > bot.y + 2 (vanilla jump tops at ~1.25 blocks, so >2 above bot
 * is definitively unreachable without scaffolding).
 *
 * 260513-wkd: `aborted` short-circuits too — the LLM gets a clean abort
 * string; vertical hints would be noise on a deliberate interrupt.
 */
export function composeVerticalHint(bot, x, y, z, result) {
  if (result === 'reached' || result === 'no_bot' || result === 'aborted') return result
  const bp = bot?.entity?.position
  if (!bp || typeof bp.y !== 'number') return result
  if (y > bp.y + 2) {
    return `${result} — unreachable — try build to Y=${y}`
  }
  return result
}

/**
 * Navigate bot to (x, y, z) within `range` blocks.
 * Returns a PathfindResult — never throws or hangs.
 * @param {object} bot - mineflayer bot instance
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} range - acceptable distance from target
 * @param {number} timeoutMs - wall-clock timeout in ms
 * @param {AbortSignal} [signal] - 260513-wkd: optional abort signal. On abort
 *   we call `bot.pathfinder.stop()` and resolve to `'aborted'`. Distinct from
 *   `timeout` so the orchestrator can tell deliberate interrupts (loop preempt
 *   / stop tool) from natural wall-clock timeouts.
 * @returns {Promise<PathfindResult>}
 */
export async function goTo(bot, x, y, z, range = 1, timeoutMs = 12000, signal = undefined) {
  if (!bot) return 'no_bot'
  // 260513-wkd: fast-path — if signal is already aborted at entry, do not
  // even call into pathfinder. Avoids burning a setMovements + goal allocation
  // on a guaranteed-abort dispatch.
  if (signal && signal.aborted) return 'aborted'

  const movements = new Movements(bot)
  // 260617 anti-stuck navigation tuning. The bare defaults trap a pickaxe-less
  // bot: digCost=1 lets the planner route THROUGH stone, which the bot cannot
  // mine bare-handed — every such dig times out and the bot reads as frozen (the
  // 260617 "stuck underground" log). Raise digCost so digging is a last resort
  // and an existing route (walk / parkour / drop) wins. maxDropDown already
  // defaults to 4 (a 4-block drop costs ~1 dmg; 1-3 are free), so a "drop down to
  // get out" route was ALWAYS allowed — pathfinder was never the blocker. Set it
  // explicitly and keep it permissive so dropping to escape beats tunnelling.
  movements.digCost = 8
  movements.maxDropDown = 4
  bot.pathfinder.setMovements(movements)
  const goal = new goals.GoalNear(x, y, z, range)

  // Closest-distance hint on cant_reach. The LLM was getting bare
  // 'cant_reach' and either retrying identically or
  // giving up; a one-number hint ("closest=8.4m to target X,Y,Z") tells it
  // whether the destination is plausibly reachable from a different angle or
  // genuinely walled off.
  function cantReachWithDistance() {
    try {
      const bp = bot.entity?.position
      if (!bp || typeof bp.x !== 'number') return 'cant_reach'
      const dx = bp.x - x, dy = bp.y - y, dz = bp.z - z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz).toFixed(1)
      return `cant_reach (closest=${dist}m to target ${x},${y},${z})`
    } catch {
      return 'cant_reach'
    }
  }

  let timeoutHandle = null
  let abortListener = null

  // 17-02: yield to a reflex creeper-flee that owns the goal. We don't install
  // (or re-install, after the flee preempts our goto) our goal while
  // `bot._seiReflexActive` is true — we park and resume rather than race or
  // abort. A GoalChanged rejection while the reflex is active is the flee taking
  // over, NOT a cant_reach: loop and re-issue once it clears so an in-flight
  // goTo pauses and then continues to its original destination.
  const navigate = async () => {
    while (true) {
      if (signal?.aborted) return 'aborted'
      if (bot._seiReflexActive) {
        const w = await waitForReflexClear(bot, signal, timeoutMs)
        if (w === 'aborted') return 'aborted'
        if (w === 'timeout') return cantReachWithDistance()
      }
      try {
        await bot.pathfinder.goto(goal)
        return 'reached'
      } catch {
        if (bot._seiReflexActive) continue // flee took the goal — yield & resume
        return cantReachWithDistance()
      }
    }
  }
  const navigationPromise = navigate()

  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      bot.pathfinder.stop()
      resolve('timeout')
    }, timeoutMs)
  })

  // 260513-wkd: abort race. On signal.abort, call pathfinder.stop() and
  // resolve to 'aborted'. The race with timeoutPromise + navigationPromise
  // stays as-is; whichever resolves first wins.
  const abortPromise = signal
    ? new Promise((resolve) => {
        abortListener = () => {
          try { bot.pathfinder.stop() } catch {}
          resolve('aborted')
        }
        signal.addEventListener('abort', abortListener, { once: true })
      })
    : null

  // Clear the timer when navigation resolves first; otherwise the orphan
  // setTimeout fires `pathfinder.stop()` later and yanks whatever goto the
  // follow tick (or any other consumer) started in the meantime.
  const racers = abortPromise
    ? [navigationPromise, timeoutPromise, abortPromise]
    : [navigationPromise, timeoutPromise]
  const result = await Promise.race(racers)
  if (timeoutHandle != null) clearTimeout(timeoutHandle)
  if (signal && abortListener) {
    try { signal.removeEventListener('abort', abortListener) } catch {}
  }
  return composeVerticalHint(bot, x, y, z, result)
}

export const PathfindResult = /** @type {const} */ ({
  REACHED: 'reached',
  CANT_REACH: 'cant_reach',
  TIMEOUT: 'timeout',
  NO_BOT: 'no_bot',
  ABORTED: 'aborted',
})
