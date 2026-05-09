// src/adapter/minecraft/connect.js
//
// Mineflayer bot lifecycle: createBot + plugin loading + reconnect loop +
// reason humanizer. Extracted from the old src/bot.js. This module is the
// only place that imports from `mineflayer` directly. Brain code never sees
// a mineflayer Bot instance — it talks to the Adapter built around it.

import { createBot } from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'
import { startFollow, stopFollow } from './behaviors/follow.js'
import { startPosHealer, stopPosHealer } from './observers/posHealer.js'
import { startChat } from './behaviors/chat.js'
import { startAutoEat } from './behaviors/autoEat.js'
import { startCombat } from './behaviors/combat.js'

/**
 * Extract human-readable text from mineflayer kick/disconnect reasons,
 * which are often chat-component objects ({text, translate, extra:[...]})
 * rather than plain strings. String(obj) yields '[object Object]' which
 * is useless to the user.
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

/**
 * Plain-English translation of mineflayer disconnect reasons. Exposed for
 * the boot composer's status surface.
 */
export function humanizeReason(reason) {
  if (!reason) return 'Unknown reason'
  const text = extractReasonText(reason)
  const r = text.toLowerCase()
  if (r.includes('econnrefused') || r.includes('connect')) return 'Could not reach server — make sure a LAN world is open'
  if (r.includes('timeout')) return 'Connection timed out — server may be unreachable'
  if (r.includes('kicked')) return `Kicked: ${text}`
  if (r.includes('invalid session') || r.includes('auth')) return 'Authentication failed — check auth mode'
  return text || 'Unknown reason'
}

/**
 * 260508-nkk: wall-clock budget for the bot's mineflayer spawn handshake.
 * Mandated by CLAUDE.md "every external call has a timeout". 20s is below
 * the supervisor's 30s outer SUMMON_TIMEOUT_MS so the bot's structured
 * BOT_START_TIMEOUT lifecycle reaches main with ~10s margin before the
 * supervisor would otherwise fire its own generic timeout. mineflayer has
 * no internal connect deadline — without this, a wrong-host / unreachable
 * LAN / stalled auth hangs silently inside its TCP retry loop.
 */
const CONNECT_TIMEOUT_MS = 20_000

/**
 * Construct a mineflayer Bot, wire up the always-on adapter behaviors
 * (pathfinder plugin, posHealer, autoEat, combat, follow, chat) on first
 * spawn, and hand it back. The reconnect loop is owned here too — on `end`,
 * the boot composer's onEnd hook fires and a fresh createBotInstance call
 * is scheduled.
 *
 * @param {Object} opts
 * @param {string} opts.host
 * @param {number} [opts.port]
 * @param {'offline'|'microsoft'} opts.auth
 * @param {string} opts.username
 * @param {string} [opts.version]                  — pass undefined to let mineflayer auto-detect
 * @param {object} opts.config                     — full validated config (passed through to behaviors)
 * @param {{info?:Function,warn?:Function,error?:Function}} [opts.logger]
 * @param {() => void} [opts.onSpawn]              Called once on first spawn (after plugins load).
 * @param {(reason:string) => void} [opts.onEnd]   Called when the connection drops; humanized reason.
 * @param {(err:Error) => void} [opts.onError]     Called on connection-level errors.
 * @param {(err:Error) => void} [opts.onConnectTimeout]
 *   260508-nkk: invoked when CONNECT_TIMEOUT_MS elapses without the bot
 *   firing its first 'spawn' event — i.e. mineflayer is silently stalled
 *   in handshake / TCP retry / Microsoft auth. The bot is also force-quit
 *   so it doesn't keep retrying in the background.
 * @returns {object} mineflayer Bot instance (always-on behaviors already started on spawn).
 */
export function createBotInstance({
  host, port, auth, username, version,
  config,
  logger = console,
  onSpawn,
  onEnd,
  onError,
  onConnectTimeout,
}) {
  const botOpts = { host, port, username, auth }
  // mineflayer auto-detects when version is omitted/undefined.
  if (version && version !== 'auto') botOpts.version = version

  const bot = createBot(botOpts)

  let _spawned = false
  // 260508-nkk: wall-clock guard. Cleared on first 'spawn' or on 'end' /
  // 'error' / 'kicked' (those routes already surface a humanized reason
  // to the boot composer's onEnd/onError, so the timeout would be
  // redundant noise). If it fires, force-quit the bot and notify the
  // boot composer through onConnectTimeout so the lifecycle layer can
  // emit BOT_START_TIMEOUT.
  let _connectTimer = setTimeout(() => {
    if (_spawned) return
    _connectTimer = null
    const err = new Error(
      `BOT_START_TIMEOUT: mineflayer.spawn did not fire within ${CONNECT_TIMEOUT_MS / 1000}s — ` +
      `LAN host/port mismatch, server unreachable at ${host}:${port}, or auth stalled.`,
    )
    logger.error?.(`[sei] ${err.message}`)
    // Stop mineflayer from retrying so the utilityProcess can shut down
    // cleanly after the supervisor receives the lifecycle error.
    try { bot.quit?.('connect timeout') } catch {}
    try { bot.end?.() } catch {}
    try { onConnectTimeout?.(err) } catch (cbErr) {
      logger.warn?.(`[sei/connect] onConnectTimeout hook threw: ${cbErr && cbErr.message}`)
    }
  }, CONNECT_TIMEOUT_MS)
  const _clearConnectTimer = () => {
    if (_connectTimer != null) {
      clearTimeout(_connectTimer)
      _connectTimer = null
    }
  }

  bot.on('spawn', () => {
    logger.info?.(`[sei] Connected to ${host}:${port} as ${username}`)
    if (!_spawned) {
      _spawned = true
      _clearConnectTimer()
      bot.loadPlugin(pathfinder)
      startPosHealer(bot)
      startAutoEat(bot)
      startCombat(bot, config)
      startFollow(bot, config)
      try { onSpawn?.() } catch (err) { logger.warn?.(`[sei/connect] onSpawn hook threw: ${err && err.message}`) }
    } else {
      // respawn after death — restart follow only
      startFollow(bot, config)
    }
  })

  bot.on('death', () => {
    logger.info?.('[sei] Sei died — respawning...')
    setTimeout(() => bot.respawn(), 500)
  })

  bot.on('error', (err) => {
    const reason = humanizeReason(err && (err.message || err))
    logger.warn?.(`[sei] Connection error: ${reason}`)
    // 260508-nkk: surfaced 'error' before spawn means the connection died
    // for a reason mineflayer recognizes (ECONNREFUSED, kicked, etc.) —
    // clear the timer so onConnectTimeout doesn't ALSO fire later.
    if (!_spawned) _clearConnectTimer()
    try { onError?.(err) } catch {}
  })

  bot.on('kicked', (reason) => {
    logger.warn?.(`[sei] Kicked: ${humanizeReason(reason)}`)
    if (!_spawned) _clearConnectTimer()
  })

  bot.on('end', (reason) => {
    stopFollow()
    stopPosHealer()
    if (!_spawned) _clearConnectTimer()
    const humanized = humanizeReason(reason)
    logger.info?.(`[sei] Disconnected: ${humanized}`)
    try { onEnd?.(humanized) } catch {}
  })

  // Expose the chat starter so the brain (which knows the orchestrator) can
  // pass it in after construction. startChat sets up the bot.on('chat')
  // listener and the stop-verb fast path; it requires the orchestrator
  // reference for the abort-on-owner-chat behavior.
  bot._sei_startChat = (orchestrator) => startChat(bot, config, orchestrator)

  return bot
}
