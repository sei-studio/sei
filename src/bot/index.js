// src/bot/index.js — bot entry, dual-mode for Phase 4.
//
// Two startup paths:
//   1. Forked by Electron main (process.parentPort exists)
//      → wait for {type:'init', character, apiKey, lanPort, userDataDir,
//        mc_username, preferred_name} message over MessagePort, build a
//        ConfigSchema-conformant config, and start the bot. Lifecycle events
//        (BotLifecycle vocabulary, src/shared/ipc.ts D-19) are posted back
//        on the same port AND mirrored to stdout for the rolling log file.
//   2. Run directly by CLI (`node src/bot/index.js`) — process.parentPort
//      is undefined → existing behavior preserved: discover LAN, loadConfig
//      from ./config.json, start the bot.
//
// Sources:
//   - RESEARCH §Pattern 1 (bot side) — parentPort message flow
//   - CONTEXT D-15 (mineflayer ONLY in utilityProcess), D-18 (config over
//     MessagePortMain), D-19 (lifecycle vocabulary), D-25 (bot does NOT
//     re-discover LAN during summon — main hands the cached port over)
//   - Pitfall 6 (bot must NOT call discoverLanPort during summon) — the
//     legacy CLI bootstrap is gated behind `!process.parentPort` so the
//     Electron path never reaches the discovery call.

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

// ─── Core start() — config-in, {stop}-out ─────────────────────────────────
// Refactored from the prior CLI-internal helper so both startup paths share
// one entrypoint: the CLI builds `config` via loadConfig+discoverLanPort, the
// Electron path receives `config` over MessagePort. Behavior is identical
// from this function down — connect, attach adapter, start brain.
export async function start(config) {
  const mc = config.adapter.minecraft

  let _brain = null
  let _bot = null
  let _adapter = null
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
        // Plan 03.1-09 (WR-07): tear down adapter listeners before discarding
        // the bot reference. Otherwise the OLD bot's listeners only become
        // GC-eligible when the closure releases, leaving a window where the
        // adapter still has dangling listeners on a dead mineflayer instance.
        try { _adapter?.detach?.() } catch {}
        _adapter = null
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

    _adapter = createMinecraftAdapter({ bot: _bot, config })
    _brain = await startBrain({ config, adapter: _adapter, logger })

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
      // Plan 03.1-09 (WR-07): same teardown as onEnd to guarantee clean
      // listener disposal on graceful shutdown, not just on reconnect.
      try { _adapter?.detach?.() } catch {}
      _adapter = null
      if (_bot) {
        try { _bot.quit('Sei stopping') } catch {}
        _bot = null
      }
      logger.info('Bot stopped.')
    },
  }
}

// ─── Electron utilityProcess path (Phase 4) ───────────────────────────────
// When forked by main, wait for the init message on the transferred
// MessagePort, build a ConfigSchema-conformant config, and bootstrap.
// Lifecycle events go to BOTH parentPort (structured for status row) AND
// stdout (so logRouter sees them and tees to the rolling log file).

let initPort = null
let _running = null         // { stop } returned by start()

function emitLifecycle(payload) {
  // payload conforms to BotLifecycle (src/shared/ipc.ts):
  //   {type:'init-ack'} | {type:'connected'} | {type:'disconnected', reason?}
  // | {type:'error', error:ErrorClass, message} | {type:'chat', from, text}
  // | {type:'summon-ready'} | {type:'summon-stopped'} | {type:'exit', code}
  if (initPort) {
    try { initPort.postMessage(payload) } catch {}
  }
  // Also log to stdout for the rolling log file (logRouter parses these tags)
  console.log(`[lifecycle] ${JSON.stringify(payload)}`)
}

async function bootstrapWithInit(initData) {
  const {
    character,
    apiKey,
    lanPort,
    userDataDir,
    mc_username,         // BLOCKER-4: Minecraft username collected in onboarding
    preferred_name,      // BLOCKER-1: seeds owner_username for owner-recognition
  } = initData

  // BLOCKER-1 fix: build a config shape that satisfies ConfigSchema.parse
  // (see src/bot/config.js — adapter.minecraft requires {host, auth, username}
  // and `version` must be a string, not boolean). v1 hardcodes
  // `auth: 'microsoft'` per CONN-02. Username comes from onboarding's
  // UserConfig (NOT from character.id — characters are personas, not
  // Minecraft accounts). owner_username is seeded from preferred_name so
  // the bot recognises the owner from the first owner-chat.
  //
  // BLOCKER-2 fix: memory paths follow Phase-3 D-59 schema explicitly
  // (owner_md_path / diary_md_path / affect_md_path). A `memory.dir`
  // wrapper is NOT part of ConfigSchema — passing one would be silently
  // stripped by Zod, leaving the defaults (./memory/...) which EROFS in
  // the read-only packaged Sei.app bundle. Plan 03's saveCharacter
  // pre-creates the parent dir so atomic-write helpers find it.
  const memDir = `${userDataDir}/memory/${character.id}`
  const config = {
    chat_mode: 'chat',  // default for v1; renderer can flip in a later phase
    owner_username: typeof preferred_name === 'string' && preferred_name.trim()
      ? preferred_name.trim()
      : 'Player',                                     // fallback for safety
    persona: {
      name: character.name,
      backstory: character.persona_prompt,
      tone: 'curious',  // tone preset retained for back-compat with Phase 2 prompts
    },
    anthropic: { api_key: apiKey },
    adapter: {
      kind: 'minecraft',
      minecraft: {
        host: 'localhost',                            // LAN host always loopback from same machine
        port: lanPort,
        auth: 'microsoft',                            // v1: Microsoft auth only (CONN-02)
        username: mc_username,                        // from onboarding UserConfig
        // `version` deliberately omitted — Zod fills 'auto' default per
        // src/bot/config.js MinecraftAdapterSchema.
      },
    },
    memory: {
      owner_md_path:  `${memDir}/OWNER.md`,
      diary_md_path:  `${memDir}/DIARY.md`,
      affect_md_path: `${memDir}/AFFECT.md`,
    },
    llm: {},  // existing defaults
  }

  emitLifecycle({ type: 'init-ack' })

  try {
    _running = await start(config)  // shared core start() — config-in
    emitLifecycle({ type: 'summon-ready' })
  } catch (err) {
    emitLifecycle({
      type: 'error',
      error: 'BOT_CRASH',
      message: String((err && err.message) || err),
    })
  }
}

async function gracefulShutdown() {
  try {
    if (_running && typeof _running.stop === 'function') await _running.stop()
  } catch {}
  emitLifecycle({ type: 'summon-stopped' })
  // Give the lifecycle message a tick to flush before exiting
  setTimeout(() => process.exit(0), 100)
}

if (process.parentPort) {
  // Electron forked path
  process.parentPort.once('message', (msg) => {
    const ports = msg.ports || []
    if (!ports.length) return
    initPort = ports[0]
    initPort.start()
    initPort.on('message', (e) => {
      const data = (e && e.data !== undefined) ? e.data : e
      if (data && data.type === 'init') {
        bootstrapWithInit(data)
      } else if (data && data.type === 'stop') {
        gracefulShutdown()
      }
    })
  })
}

// ─── CLI path (existing behavior, gated behind !parentPort) ──────────────
// Pitfall 6: `discoverLanPort` is reachable ONLY when this guard holds —
// never when summoned by Electron main (which posts the cached lanPort
// over MessagePort per CONTEXT D-25).
if (!process.parentPort) {
  // Pitfall 6 lexical guard: `discoverLanPort` is reachable ONLY here.
  // The Electron path (`if (process.parentPort)` above) never falls through.
  if (import.meta.url === `file://${process.argv[1]}`) {
    ;(async () => {
      logger.info('Searching for an open LAN world...')
      const { port, motd } = await discoverLanPort({ timeoutMs: 5000 })
      logger.info(`Found LAN world "${motd}" on port ${port}`)
      const config = loadConfig('./config.json', { port })
      await start(config)
    })().catch((err) => {
      console.error(`[sei] Startup failed: ${err.message}`)
      process.exit(1)
    })
  }
}
