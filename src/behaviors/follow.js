import { goTo } from './pathfind.js'
import pkg from 'mineflayer-pathfinder'
const { pathfinder } = pkg

let _followInterval = null

export function startFollow(bot, config) {
  if (!bot.hasPlugin(pathfinder)) bot.loadPlugin(pathfinder)

  _followInterval = setInterval(async () => {
    const owner = bot.players[config.owner_username]
    if (!owner?.entity) return  // owner not in render distance

    const ownerPos = owner.entity.position
    const botPos = bot.entity.position
    const dist = botPos.distanceTo(ownerPos)

    if (dist > config.follow_range) {
      await goTo(bot, ownerPos.x, ownerPos.y, ownerPos.z, config.follow_range, config.pathfinder_timeout_ms)
    }
  }, 1000)  // re-evaluate every 1s
}

export function stopFollow() {
  clearInterval(_followInterval)
  _followInterval = null
}
