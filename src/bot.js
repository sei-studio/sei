import { createBot } from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'
import { startFollow, stopFollow } from './behaviors/follow.js'
import { startChat } from './behaviors/chat.js'
import { startAutoEat } from './behaviors/autoEat.js'
import { startCombat } from './behaviors/combat.js'
import { createDefaultRegistry } from './registry.js'
import { createFSM } from './fsm.js'

let _bot = null
let _reconnectTimer = null
let _stopped = false

/** Plain-English translation of mineflayer disconnect reasons */
function humanizeReason(reason) {
  if (!reason) return 'Unknown reason'
  const r = String(reason).toLowerCase()
  if (r.includes('econnrefused') || r.includes('connect')) return 'Could not reach server — check host/port'
  if (r.includes('timeout')) return 'Connection timed out — server may be unreachable'
  if (r.includes('kicked')) return `Kicked: ${reason}`
  if (r.includes('invalid session') || r.includes('auth')) return 'Authentication failed — check auth mode'
  return String(reason)
}

function logStatus(msg) {
  // Single status channel. Phase 4 will replace this with IPC to renderer.
  console.log(`[sei] ${msg}`)
}

function createBotInstance(config) {
  const botOpts = {
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
  }
  // Only set version if not "auto" — mineflayer auto-detects when version is omitted
  if (config.minecraft_version !== 'auto') {
    botOpts.version = config.minecraft_version
  }

  const bot = createBot(botOpts)

  bot.on('spawn', () => {
    logStatus(`Connected to ${config.host}:${config.port} as ${config.username}`)

    // Load pathfinder plugin (required by follow behavior)
    bot.loadPlugin(pathfinder)

    // Start all reflex behaviors
    startAutoEat(bot)
    startCombat(bot)
    startChat(bot, config)
    startFollow(bot, config)

    // Wire FSM
    const registry = createDefaultRegistry()
    createFSM(bot, config, registry)
  })

  bot.on('error', (err) => {
    logStatus(`Connection error: ${humanizeReason(err.message || err)}`)
  })

  bot.on('kicked', (reason) => {
    logStatus(`Kicked: ${humanizeReason(reason)}`)
  })

  bot.on('end', (reason) => {
    stopFollow()
    logStatus(`Disconnected: ${humanizeReason(reason)}`)
    _bot = null
    if (!_stopped) {
      logStatus(`Reconnecting in ${config.reconnect_delay_ms}ms...`)
      _reconnectTimer = setTimeout(() => {
        if (!_stopped) {
          logStatus('Attempting reconnect...')
          _bot = createBotInstance(config)
        }
      }, config.reconnect_delay_ms)
    }
  })

  return bot
}

export function start(config) {
  _stopped = false
  logStatus(`Starting Sei — connecting to ${config.host}:${config.port}`)
  _bot = createBotInstance(config)
  return _bot
}

export function stop() {
  _stopped = true
  clearTimeout(_reconnectTimer)
  if (_bot) {
    _bot.quit('Sei stopping')
    _bot = null
  }
  logStatus('Bot stopped.')
}

/** Returns current bot instance (null if disconnected). Used by behavior modules. */
export function getBot() {
  return _bot
}
