// src/index.js — boot composer.
//
// Three-step boot:
//   1. Load + validate config.
//   2. Construct mineflayer Bot via the adapter's connect helper.
//   3. Wrap the bot in a minecraft Adapter and hand it to the brain.
//
// This is the only file that knows about both the brain and the adapter
// in a directly-imported way. After this module returns, brain code
// receives all game state through the Adapter contract.

import { loadConfig } from './config.js'
import { discoverLanPort } from './adapter/minecraft/lanDiscovery.js'
import { createBotInstance } from './adapter/minecraft/connect.js'
import { createMinecraftAdapter } from './adapter/minecraft/index.js'
import { start as startBrain } from './brain/index.js'

const logger = {
  info:  (m) => console.log(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  warn:  (m) => console.warn(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  error: (m) => console.error(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
}

export async function start() {
  logger.info('Searching for an open LAN world...')
  const { port, motd } = await discoverLanPort({ timeoutMs: 5000 })
  logger.info(`Found LAN world "${motd}" on port ${port}`)

  const config = loadConfig('./config.json', { port })
  const mc = config.adapter.minecraft

  let _brain = null
  let _bot = null
  let _stopped = false
  let _reconnectTimer = null

  const bringUp = async () => {
    _bot = createBotInstance({
      host: mc.host,
      port: mc.port,
      auth: mc.auth,
      username: mc.username,
      version: mc.version,
      config,
      logger,
      onSpawn: () => { /* brain wires session start via adapter.attach onSpawn */ },
      onEnd: (humanizedReason) => {
        if (_stopped) return
        logger.info(`Reconnecting in ${mc.reconnect_delay_ms}ms (${humanizedReason})...`)
        _bot = null
        clearTimeout(_reconnectTimer)
        _reconnectTimer = setTimeout(() => {
          if (_stopped) return
          logger.info('Attempting reconnect...')
          bringUp().catch(err => logger.error(`Reconnect failed: ${err.message}`))
        }, mc.reconnect_delay_ms)
      },
      onError: (err) => logger.warn(`Connection error: ${err && err.message}`),
    })

    const adapter = createMinecraftAdapter({ bot: _bot, config })
    _brain = await startBrain({ config, adapter, logger })

    // Wire the legacy chat behavior (bot.on('chat') with owner/addressed/
    // nearby filtering and sei:chat_received emission) without an
    // orchestrator handle. fsmWires translates sei:chat_received into
    // brain.onChat; the brain priority queue handles owner-chat preemption
    // (P1→P0 escalation when a non-P0 action is in flight). Stop-verb
    // fast-path body-cancel was previously a synchronous side-effect of
    // chat.js when given an orchestrator; with the brain↔adapter seam,
    // that fast path runs through the normal queue (one extra Haiku
    // round-trip on "stop"). Plan 03.1-03 polishes this.
    try { _bot._sei_startChat?.(null) } catch (err) {
      logger.warn(`startChat hookup failed: ${err && err.message}`)
    }
  }

  await bringUp()

  return {
    async stop() {
      _stopped = true
      clearTimeout(_reconnectTimer)
      if (_brain) {
        try { await _brain.stop() } catch {}
      }
      if (_bot) {
        try { _bot.quit('Sei stopping') } catch {}
        _bot = null
      }
      logger.info('Bot stopped.')
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(`[sei] Startup failed: ${err.message}`)
    process.exit(1)
  })
}
