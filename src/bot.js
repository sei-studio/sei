import { createBot } from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'
import { startFollow, stopFollow } from './behaviors/follow.js'
import { startPosHealer, stopPosHealer } from './observers/posHealer.js'
import { startChat } from './behaviors/chat.js'
import { startAutoEat } from './behaviors/autoEat.js'
import { startCombat } from './behaviors/combat.js'
import { createDefaultRegistry } from './registry.js'
import { createFSM } from './fsm.js'
import { createOrchestrator } from './llm/orchestrator.js'

let _bot = null
let _reconnectTimer = null
let _stopped = false

/** Plain-English translation of mineflayer disconnect reasons */
/** Extract human-readable text from mineflayer kick/disconnect reasons,
 *  which are often chat-component objects ({text, translate, extra:[...]})
 *  rather than plain strings. String(obj) yields '[object Object]' which
 *  is useless to the user.
 */
function extractReasonText(reason) {
  if (reason == null) return ''
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object') {
    if (typeof reason.text === 'string' && reason.text.length) return reason.text
    if (typeof reason.translate === 'string' && reason.translate.length) return reason.translate
    if (Array.isArray(reason.extra)) {
      const joined = reason.extra.map(e => (e && typeof e.text === 'string') ? e.text : '').join('')
      if (joined.length) return joined
    }
    try { return JSON.stringify(reason) } catch (_) { return String(reason) }
  }
  return String(reason)
}

function humanizeReason(reason) {
  if (!reason) return 'Unknown reason'
  const text = extractReasonText(reason)
  const r = text.toLowerCase()
  if (r.includes('econnrefused') || r.includes('connect')) return 'Could not reach server — check host/port'
  if (r.includes('timeout')) return 'Connection timed out — server may be unreachable'
  if (r.includes('kicked')) return `Kicked: ${text}`
  if (r.includes('invalid session') || r.includes('auth')) return 'Authentication failed — check auth mode'
  return text || 'Unknown reason'
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

  let _spawned = false
  bot.on('spawn', () => {
    logStatus(`Connected to ${config.host}:${config.port} as ${config.username}`)
    if (!_spawned) {
      _spawned = true
      bot.loadPlugin(pathfinder)
      startPosHealer(bot)
      startAutoEat(bot)
      startCombat(bot, config)
      startChat(bot, config)
      startFollow(bot, config)
      const registry = createDefaultRegistry()
      createFSM(bot, config, registry)
      const orchestrator = createOrchestrator({ bot, config, registry, logger: { info: (m) => logStatus(m), warn: (m) => logStatus(m), error: (m) => logStatus(m) } })
      bot.on('sei:dispatch', ({ event, data, signal }) => { orchestrator.handleDispatch(event, data, signal) })
      bot._seiDebouncer = orchestrator.debouncer
      bot._seiAttackThrottle = orchestrator.throttle
      orchestrator.start().catch(err => logStatus(`Orchestrator start failed: ${err.message}`))
      logStatus(`Sei online. Executor: ${orchestrator.executorStatus}`)
    } else {
      // respawn after death — restart follow only
      startFollow(bot, config)
    }
  })

  bot.on('death', () => {
    logStatus('Sei died — respawning...')
    setTimeout(() => bot.respawn(), 500)
  })

  bot.on('error', (err) => {
    logStatus(`Connection error: ${humanizeReason(err.message || err)}`)
  })

  bot.on('kicked', (reason) => {
    logStatus(`Kicked: ${humanizeReason(reason)}`)
  })

  bot.on('end', (reason) => {
    stopFollow()
    stopPosHealer()
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
