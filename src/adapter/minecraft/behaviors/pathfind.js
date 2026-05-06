import pkg from 'mineflayer-pathfinder'
const { Movements, goals } = pkg

/** @typedef {'reached' | 'cant_reach' | 'timeout' | 'no_bot'} PathfindResult */

/**
 * Navigate bot to (x, y, z) within `range` blocks.
 * Returns a PathfindResult — never throws or hangs.
 * @param {object} bot - mineflayer bot instance
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} range - acceptable distance from target
 * @param {number} timeoutMs - wall-clock timeout in ms
 * @returns {Promise<PathfindResult>}
 */
export async function goTo(bot, x, y, z, range = 1, timeoutMs = 12000) {
  if (!bot) return 'no_bot'

  const movements = new Movements(bot)
  bot.pathfinder.setMovements(movements)
  const goal = new goals.GoalNear(x, y, z, range)

  const navigationPromise = new Promise((resolve) => {
    bot.pathfinder.goto(goal)
      .then(() => resolve('reached'))
      .catch((err) => {
        const msg = String(err?.message || err).toLowerCase()
        if (msg.includes('timeout') || msg.includes('stop')) resolve('cant_reach')
        else resolve('cant_reach')
      })
  })

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      bot.pathfinder.stop()
      resolve('timeout')
    }, timeoutMs)
  })

  return Promise.race([navigationPromise, timeoutPromise])
}

export const PathfindResult = /** @type {const} */ ({
  REACHED: 'reached',
  CANT_REACH: 'cant_reach',
  TIMEOUT: 'timeout',
  NO_BOT: 'no_bot',
})
