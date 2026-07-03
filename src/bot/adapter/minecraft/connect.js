// src/adapter/minecraft/connect.js
//
// Mineflayer bot lifecycle: createBot + plugin loading + reconnect loop +
// reason humanizer. Extracted from the old src/bot.js. This module is the
// only place that imports from `mineflayer` directly. Brain code never sees
// a mineflayer Bot instance — it talks to the Adapter built around it.

import { createBot } from 'mineflayer'
import minecraftProtocol from 'minecraft-protocol'
import minecraftData from 'minecraft-data'
import { pathfinder } from 'mineflayer-pathfinder'

// minecraft-protocol / minecraft-data are CJS (and arrive transitively via
// mineflayer, exactly as the test suite already consumes minecraft-data). Pull
// the version-resolution surface off the default export to stay ESM-safe.
const { ping, supportedVersions } = minecraftProtocol
import { startFollow, stopFollow } from './behaviors/follow.js'
import { startPosHealer, stopPosHealer } from './observers/posHealer.js'
import { startChat } from './behaviors/chat.js'
import { startAutoEat } from './behaviors/autoEat.js'
import { startCombat } from './behaviors/combat.js'
import { startReflex } from './behaviors/reflex.js'

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

// Wall-clock budget for the pre-connect status ping (resolveServerVersion).
// Short — a LAN status query on localhost answers in well under a second; if it
// stalls we fall back to mineflayer's own auto-detect rather than block summon.
const PING_TIMEOUT_MS = 5_000

/**
 * Map a wire protocol number to a version string our networking layer actually
 * implements (minecraft-protocol.supportedVersions). Returns null when none of
 * the supported versions speak that protocol.
 */
function supportedVersionForProtocol(protocol) {
  if (typeof protocol !== 'number') return null
  for (const v of supportedVersions) {
    let data
    try { data = minecraftData(v) } catch { continue }
    if (data && data.version && data.version.version === protocol) return v
  }
  return null
}

/**
 * Pick the supported version string for a pinged server. Prefer the server's
 * self-reported name when we support it verbatim (disambiguates versions that
 * share a protocol number, e.g. 1.20 vs 1.20.1); else fall back to the protocol
 * match. Returns null when the server's version is outside our supported set.
 */
function resolveSupportedVersion(name, protocol) {
  if (typeof name === 'string' && supportedVersions.includes(name)) return name
  return supportedVersionForProtocol(protocol)
}

function pingWithTimeout(options, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const e = new Error(
        `LAN_PING_TIMEOUT: no status response from ${options.host}:${options.port} within ${timeoutMs}ms`,
      )
      e.code = 'LAN_PING_TIMEOUT'
      reject(e)
    }, timeoutMs)
    try {
      ping(options, (err, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          if (!err.code) err.code = 'LAN_PING_FAILED'
          reject(err)
        } else {
          resolve(result)
        }
      })
    } catch (e) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    }
  })
}

/**
 * Status-ping the LAN server and resolve the Minecraft version Sei should
 * connect with, bounded to what our networking deps actually implement. The
 * Electron path passes `version: 'auto'`; this resolves it to an EXPLICIT
 * supported version which is then handed to createBotInstance — deliberately
 * sidestepping mineflayer's in-handshake auto-detect, which historically
 * produced protocol kicks against modern LAN worlds.
 *
 * @returns {Promise<string>} a supported version string (e.g. '1.20.6').
 * @throws  Error with `.code`:
 *   - 'UNSUPPORTED_MC_VERSION' — the server runs a version outside
 *     minecraft-protocol.supportedVersions. The caller surfaces a clean error
 *     and must NOT attempt to connect (it would only earn a protocol kick).
 *   - 'LAN_PING_TIMEOUT' / 'LAN_PING_FAILED' — the ping itself failed. The
 *     caller may fall back to mineflayer's auto-detect; a genuinely unreachable
 *     world is then handled by the normal connect / reconnect path.
 */
export async function resolveServerVersion({ host, port, timeoutMs = PING_TIMEOUT_MS, logger = console }) {
  const status = await pingWithTimeout({ host, port }, timeoutMs)
  const name = status && status.version && status.version.name
  const protocol = status && status.version && status.version.protocol
  const resolved = resolveSupportedVersion(name, protocol)
  if (!resolved) {
    const reported = name || (typeof protocol === 'number' ? `protocol ${protocol}` : 'an unknown version')
    const err = new Error(
      `UNSUPPORTED_MC_VERSION: This world is running Minecraft ${reported}, which Sei can't join yet. ` +
      `Sei supports Java ${supportedVersions[0]}–${supportedVersions[supportedVersions.length - 1]}. ` +
      `Switch your world to a supported version and click Summon again.`,
    )
    err.code = 'UNSUPPORTED_MC_VERSION'
    throw err
  }
  logger.info?.(
    `[sei] Server ping: version "${name ?? '?'}" (protocol ${protocol ?? '?'}) → connecting as ${resolved}`,
  )
  return resolved
}

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

  // Isolate each spawn-setup step so ONE throwing behavior can never strand the
  // summon. Reaching 'spawn' means the bot IS in the world, so onSpawn (which
  // fires summon-ready) must run regardless — otherwise the connect timer is
  // already cleared and the session hangs on "Connecting…" until the
  // supervisor's 30s timeout. A failed behavior degrades that one feature only.
  const safeStart = (label, fn) => {
    try { fn() } catch (err) { logger.warn?.(`[sei/connect] ${label} failed on spawn: ${err && err.message}`) }
  }

  bot.on('spawn', () => {
    logger.info?.(`[sei] Connected to ${host}:${port} as ${username}`)
    if (!_spawned) {
      _spawned = true
      _clearConnectTimer()
      safeStart('loadPlugin(pathfinder)', () => bot.loadPlugin(pathfinder))
      safeStart('startPosHealer', () => startPosHealer(bot))
      safeStart('startAutoEat', () => startAutoEat(bot))
      safeStart('startCombat', () => startCombat(bot, config))
      safeStart('startReflex', () => startReflex(bot, config))
      safeStart('startFollow', () => startFollow(bot, config))
      try { onSpawn?.() } catch (err) { logger.warn?.(`[sei/connect] onSpawn hook threw: ${err && err.message}`) }
    } else {
      // respawn after death — restart follow + re-arm the reflex loop (Plan 01's
      // disposer tears the loop down on death, so respawn must re-arm it).
      safeStart('startReflex(respawn)', () => startReflex(bot, config))
      safeStart('startFollow(respawn)', () => startFollow(bot, config))
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
    // Log RAW reason text BEFORE humanization. The 'connect' substring match
    // in humanizeReason has previously masked protocol-handshake kicks (e.g.
    // "Outdated client/server", "Failed to verify username") as the generic
    // "Could not reach server" — burning multiple debug iterations chasing
    // a TCP issue that wasn't there. Always emit the raw text so future-us
    // can tell a real ECONNREFUSED apart from a server-sent kick packet.
    logger.warn?.(`[sei] Kicked (raw): ${extractReasonText(reason)}`)
    logger.warn?.(`[sei] Kicked: ${humanizeReason(reason)}`)
    if (!_spawned) _clearConnectTimer()
  })

  bot.on('end', (reason) => {
    stopFollow()
    stopPosHealer()
    if (!_spawned) _clearConnectTimer()
    const humanized = humanizeReason(reason)
    logger.info?.(`[sei] Disconnected (raw): ${extractReasonText(reason)}`)
    logger.info?.(`[sei] Disconnected: ${humanized}`)
    try { onEnd?.(humanized) } catch {}
  })

  // Expose the chat starter so the brain (which knows the orchestrator) can
  // pass it in after construction. startChat sets up the bot.on('chat')
  // listener and the stop-verb fast path; it requires the orchestrator
  // reference for the abort-on-player-chat behavior.
  bot._sei_startChat = (orchestrator) => startChat(bot, config, orchestrator)

  return bot
}
