// src/bot/adapter/minecraft/runtime.js — the Minecraft game runtime (M0, 260908).
//
// The composer (src/bot/index.js) dynamic-imports `./adapter/<kind>/runtime.js`
// by config.adapter.kind, so mineflayer and its native dependencies load ONLY
// for a Minecraft session. This module owns everything that used to be the
// Minecraft half of the composer's start(): the version ping, mineflayer
// bring-up, the reconnect policy (bounded attempts, modded-host kick, the
// liveness re-ping that tells a kick from a closed world), adapter + dashboard
// telemetry construction per connection, the `_sei_startChat` hookup, and the
// per-connection brain lifecycle through the composer's hooks.
//
// Contract: RuntimeHooks / RuntimeHandle in src/bot/brain/types.js. The four
// exports every game runtime provides:
//   botUsernameFor(character)            → the in-game name this body logs in as
//   adapterConfigFrom({joinTarget, botUsername}) → the `adapter.<kind>` config block
//   checkJoinTarget(joinTarget)          → {error, message} when nothing to join, else null
//   createRuntime(config, hooks)         → RuntimeHandle
//
// The Electron path hands the bot `version: 'auto'`. createRuntime resolves
// that to an EXPLICIT, supported version via a status ping (resolveServerVersion)
// before the first connect — so the bot matches whatever the player's LAN world
// runs (1.20.6, 1.21.x, …) while staying bounded to minecraft-protocol's
// supported set. Pinning a single version (the old '1.21.1') broke every world
// on a different version; raw mineflayer in-handshake auto-detect was avoided
// because it produced protocol kicks. Ping-then-pass-explicit gets both:
// auto-match without the handshake-detect failure mode.

import { createBotInstance, resolveServerVersion } from './connect.js'
import { createMinecraftAdapter } from './index.js'
import { classifyConnectError } from './errors.js'
import { bootMarks, markBoot } from '../../bootTiming.js'

/**
 * The bot's MC login name must NOT collide with the LAN host's own player
 * (else the server kicks with multiplayer.disconnect.name_taken). Prefer the
 * per-persona character.username (CharacterSchema already enforces the MC
 * regex + 16-char cap); else the persona name sanitized to MC's username
 * constraints: [A-Za-z0-9_], ≤16 chars, non-empty, 'Sei' as the last resort.
 * MIRROR: src/shared/characterSchema.ts effectiveMcUsername() — keep in sync.
 */
export function botUsernameFor(character) {
  if (typeof character?.username === 'string' && character.username.trim()) return character.username.trim()
  const cleaned = String(character?.name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16)
  return cleaned || 'Sei'
}

/**
 * The `adapter.minecraft` block for ConfigSchema. `joinTarget` is main's
 * `{ port, motd, mc_username, skinServerBaseUrl }` (src/shared/gameIpc.ts
 * MinecraftJoinTarget). Sei is same-machine only, so the host is loopback and
 * auth is offline. 'auto' → resolved to the world's actual version by the
 * status ping in createRuntime.
 */
export function adapterConfigFrom({ joinTarget, botUsername }) {
  return {
    host: '127.0.0.1',
    port: joinTarget?.port ?? undefined,
    auth: 'offline',
    username: botUsername,
    version: 'auto',
  }
}

/**
 * Main hands the cached LAN port over (it owns the LAN watcher and revalidates
 * freshness via its 3-second stale window); the bot never re-discovers it.
 * No port means nothing to join — the same LAN_NOT_OPEN the supervisor's own
 * pre-check raises, kept here as the bot-side backstop.
 */
export function checkJoinTarget(joinTarget) {
  if (joinTarget?.port == null) {
    return {
      error: 'LAN_NOT_OPEN',
      message:
        'No LAN broadcast detected. Make sure your Minecraft world is open to LAN ' +
        '(ESC → Open to LAN → Start LAN World) and click Summon again.',
    }
  }
  return null
}

/** Cap reconnects so a stale/wrong LAN port stops hammering the server (and
 *  racking up Anthropic calls from each new brain spawned by bringUp). Reset
 *  on first successful spawn. */
const MAX_RECONNECT_ATTEMPTS = 3

/**
 * @param {object} config  Parsed bot config (config.adapter.kind === 'minecraft').
 * @param {import('../../brain/types.js').RuntimeHooks} hooks
 * @returns {Promise<import('../../brain/types.js').RuntimeHandle>}
 */
export async function createRuntime(config, hooks) {
  const { logger, createBrain, onBrainReady, onBrainLost, onConnected, onDisconnected, onError, onDashboard, emitVisionCapability } = hooks
  const mc = config.adapter.minecraft

  let _brain = null
  let _bot = null
  let _adapter = null
  // Minecraft dashboard (260721): telemetry loop, one per mineflayer instance
  // (recreated on reconnect). The renderer's watching flag outlives instances.
  let _dash = null
  let _dashWatching = false
  let _stopped = false
  let _reconnectTimer = null
  // 260508-nkk: only forward the FIRST spawn → onConnected; subsequent
  // reconnect-spawns are normal recovery and must not duplicate summon-ready
  // (the supervisor already gates on summonResolved, but belt-and-suspenders).
  let _readyFired = false
  let _reconnectAttempts = 0

  // Terminal failure → the composer emits the lifecycle error and shuts down.
  const fail = (message) => {
    try { onError({ error: classifyConnectError(message), message }) } catch (cbErr) {
      logger.warn(`onError hook threw: ${cbErr && cbErr.message}`)
    }
  }

  // ─── Resolve the Minecraft protocol version ────────────────────────────────
  // Resolved ONCE here; reconnects reuse it. A ping FAILURE is non-fatal: fall
  // back to mineflayer's own auto-detect (connect.js omits `version` when it
  // sees 'auto'), and let the normal connect / reconnect loop handle a
  // genuinely unreachable world. Only a SUCCESSFUL ping reporting an
  // UNSUPPORTED version aborts, with a clear error.
  if (!mc.version || mc.version === 'auto') {
    try {
      mc.version = await resolveServerVersion({ host: mc.host, port: mc.port, logger })
      logger.info(`Auto-detected Minecraft version: ${mc.version}`)
    } catch (err) {
      if (err && err.code === 'UNSUPPORTED_MC_VERSION') {
        logger.error(`[sei] ${err.message}`)
        fail(String((err && err.message) || err))
        return makeHandle()
      }
      logger.warn(
        `[sei] Version ping failed (${err && err.message}) — ` +
        `falling back to mineflayer auto-detect.`,
      )
      mc.version = 'auto' // connect.js omits version when 'auto' → mineflayer detects in-handshake
    }
  }
  markBoot('version_resolved')

  const bringUp = async () => {
    _bot = createBotInstance({
      host: mc.host,
      port: mc.port,
      auth: mc.auth,
      username: mc.username,
      version: mc.version,
      config,
      logger,
      onSpawn: () => {
        // brain wires session start via adapter.attach onSpawn; this hook is
        // for the surrounding lifecycle (summon-ready emit). Fires onConnected
        // the first time mineflayer's spawn event lands so the supervisor's
        // "Connecting…" → "Online" flip happens at the right moment.
        if (_readyFired) return
        _readyFired = true
        // A successful spawn means the server is reachable; reset the
        // reconnect counter so future drops don't count against the original cap.
        _reconnectAttempts = 0
        try { onConnected() } catch (err) {
          logger.warn(`onConnected hook threw: ${err && err.message}`)
        }
        // 260926: one line with the boot phases (ms since process start), so
        // the rolling log shows where a slow start went. The same marks reach
        // main's diagnostics over the port (bootTiming.js).
        try {
          const m = bootMarks()
          const t0 = m.process_start ?? 0
          logger.info(`boot timings (ms since process start): ${Object.entries(m).map(([k, v]) => `${k}=${v - t0}`).join(' ')}`)
        } catch {}
        // 260926: the render stack is no longer loaded at boot (see
        // behaviors/visualize.js). Warm it shortly after spawn when vision is
        // on, so the first look() does not pay a cold native load inside its
        // render timeout. A failure here only logs: look() degrades to "can't
        // see" and retries the import.
        if (config?.vision?.mode && config.vision.mode !== 'off') {
          setTimeout(() => {
            if (_stopped) return
            import('./behaviors/visualize.js')
              .then(({ loadPovRenderer }) => loadPovRenderer())
              .catch((err) => logger.warn(`vision renderer failed to load: ${err && err.message}`))
          }, 4000)
        }
        // TEMPORARY — Phase 15-01 de-risk spike (REMOVE after the packaged-build
        // checkpoint approves). Behind SEI_VISION_SPIKE=1 so it ships nothing
        // permanent. Proves the native gl/canvas render path loads + renders inside
        // the bot utilityProcess under the Electron 42 ABI (dev AND packaged dist).
        // Dynamic import keeps povRenderer (→ native gl/canvas dlopen) off the normal
        // startup path; only loaded when the flag is set.
        if (process.env.SEI_VISION_SPIKE === '1') {
          // Give chunks ~3s to stream in after spawn before the one-shot render.
          setTimeout(async () => {
            try {
              const { renderPov } = await import('./render/povRenderer.js')
              const result = await renderPov(_bot)
              if (result?.ok) {
                logger.info(`vision spike: rendered ${result.buffer.length} bytes JPEG`)
              } else {
                logger.warn(`vision spike: degraded (${result?.reason ?? 'unknown'}) — render returned no frame`)
              }
            } catch (err) {
              logger.error(`vision spike: render threw — ${(err && err.stack) || err}`)
            }
          }, 3000)
        }
      },
      onEnd: (humanizedReason, info) => {
        if (_stopped) return
        // Tear down adapter listeners before discarding the bot reference.
        // Otherwise the OLD bot's listeners only become GC-eligible when the
        // closure releases, leaving a window where the adapter still has
        // dangling listeners on a dead mineflayer instance.
        try { _adapter?.detach?.() } catch {}
        _adapter = null
        // Dashboard telemetry is bound to the dead instance — a reconnect
        // creates a fresh one (bringUp) with the same watching flag.
        try { _dash?.stop() } catch {}
        _dash = null
        _bot = null
        clearTimeout(_reconnectTimer)

        // MODDED HOST — terminal on the FIRST kick, before either branch below
        // (260806). A Forge/NeoForge world that requires its mods client-side
        // rejects a vanilla client every single time, so the reconnect budget
        // buys nothing: it just spends 15 seconds re-earning the same kick three
        // times. Worse, both branches below end in LAN_NOT_OPEN, so the user was
        // told to re-open a world that was open and reachable the whole time
        // (measured live: five summons, four of them re-opening the world).
        // Placed above the _readyFired split because the answer is the same
        // whether we were kicked during the join handshake or after spawning.
        if (info?.modded) {
          _stopped = true
          logger.error(`[sei] Modded world rejected Sei (${humanizedReason}) — not retrying.`)
          try { onDisconnected({ reason: humanizedReason, willRetry: false }) } catch {}
          fail(`MODDED_HOST_REJECTED: ${humanizedReason}.`)
          return
        }

        // POST-SPAWN drop: the bot was in the world and the socket closed.
        // Historically this was ALWAYS terminal ("the player closed the
        // world"), because the old unconditional reconnect had two bugs:
        //   1. The `_reconnectAttempts = 0` reset was gated on `_readyFired`,
        //      so the counter was wiped on EVERY post-spawn drop and the bot
        //      reconnected FOREVER into a genuinely closed world.
        //   2. The brain from the dead session was never stopped — its
        //      orchestrator loop kept firing idle-tick Anthropic calls into a
        //      detached adapter (phantom chat into a closed socket).
        // 260710: always-terminal overcorrected. Server KICKS with the world
        // still open are real — live case: a chat-signing rejection
        // (multiplayer.disconnect.chat_validation_failed, an nmp 1.66.0
        // chat-checksum bug on 1.21.11) killed the session and told the user
        // to "re-open" a world that was open the whole time. Disambiguate by
        // STATUS-PINGING the LAN port:
        //   - ping answers  → the world is up; this was a kick. Stop the dead
        //     session's brain (fixes historical bug 2), then bounded rejoin.
        //     The attempt counter is deliberately NOT reset on reconnect
        //     spawns (fixes historical bug 1), so a kick loop still gives up
        //     after MAX_RECONNECT_ATTEMPTS for the whole session.
        //   - ping dead → the player really closed the world; terminal
        //     LAN_NOT_OPEN exactly as before.
        if (_readyFired) {
          const deadBrain = _brain
          _brain = null
          try { onBrainLost() } catch {}
          void (async () => {
            try { await deadBrain?.stop() } catch (err) {
              logger.warn(`brain stop after disconnect threw: ${err && err.message}`)
            }
            if (_stopped) return
            let worldStillOpen = false
            try {
              await resolveServerVersion({
                host: mc.host, port: mc.port, timeoutMs: 1500,
                logger: { info: () => {} }, // quiet — this is a liveness probe, not version resolution
              })
              worldStillOpen = true
            } catch { /* closed, unreachable, or version weirdness → terminal path */ }
            if (_stopped) return

            if (worldStillOpen) {
              _reconnectAttempts += 1
              if (_reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                logger.info(
                  `[sei] Kicked from the world but it is still open (${humanizedReason}) — ` +
                  `rejoining in ${mc.reconnect_delay_ms}ms ` +
                  `(attempt ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}).`,
                )
                try { onDisconnected({ reason: humanizedReason, willRetry: true }) } catch {}
                _reconnectTimer = setTimeout(() => {
                  if (_stopped) return
                  logger.info('Attempting to rejoin...')
                  bringUp().catch(err => logger.error(`Rejoin failed: ${err.message}`))
                }, mc.reconnect_delay_ms)
                return
              }
              // Kick loop — the server keeps ejecting us. Give up with an
              // honest message (NOT "re-open your world": it IS open).
              _stopped = true
              logger.error(
                `[sei] Kicked ${MAX_RECONNECT_ATTEMPTS} times by a world that is still open ` +
                `(${humanizedReason}) — giving up.`,
              )
              try { onDisconnected({ reason: humanizedReason, willRetry: false }) } catch {}
              fail(
                `LAN_NOT_OPEN: The world kept kicking Sei (${humanizedReason}). ` +
                `Try summoning again in a moment.`,
              )
              return
            }

            _stopped = true
            logger.info(
              `[sei] Lost connection to the LAN world (${humanizedReason}) — stopping. ` +
              `Re-open the world to LAN and click Summon again.`,
            )
            try { onDisconnected({ reason: humanizedReason, willRetry: false }) } catch {}
            fail(
              `LAN_NOT_OPEN: Lost connection to the LAN world (${humanizedReason}). ` +
              `Re-open the world to LAN in Minecraft and click Summon again.`,
            )
          })()
          return
        }

        // PRE-SPAWN: never reached the world yet (stale/wrong LAN port, or a
        // world that isn't actually open). Bounded reconnect — the counter is
        // correct here because _readyFired is false, so a wrong port gives up
        // after MAX_RECONNECT_ATTEMPTS instead of hammering the server and
        // spawning a fresh brain (+greeting Anthropic call) on every retry.
        _reconnectAttempts += 1
        if (_reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          _stopped = true
          logger.error(
            `[sei] Giving up after ${MAX_RECONNECT_ATTEMPTS} failed connect attempts ` +
            `(${humanizedReason}). Re-open LAN in Minecraft and click Summon again.`,
          )
          try { onDisconnected({ reason: humanizedReason, willRetry: false }) } catch {}
          fail(
            `LAN_NOT_OPEN: Could not reach the LAN world after ${MAX_RECONNECT_ATTEMPTS} attempts ` +
            `(${humanizedReason}). Re-open the world to LAN in Minecraft and click Summon again.`,
          )
          return
        }
        logger.info(
          `Reconnecting in ${mc.reconnect_delay_ms}ms ` +
          `(attempt ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, ${humanizedReason})...`,
        )
        try { onDisconnected({ reason: humanizedReason, willRetry: true }) } catch {}
        _reconnectTimer = setTimeout(() => {
          if (_stopped) return
          logger.info('Attempting reconnect...')
          bringUp().catch(err => logger.error(`Reconnect failed: ${err.message}`))
        }, mc.reconnect_delay_ms)
      },
      onError: (err) => logger.warn(`Connection error: ${err && err.message}`),
      // connect.js's wall-clock connect timeout fires this when mineflayer's
      // 'spawn' never lands within its guard. Surface up so the supervisor
      // sees a structured BOT_START_TIMEOUT lifecycle error instead of waiting
      // the full 30s outer summon timer with no diagnostic signal. Per
      // CLAUDE.md "every external call has a timeout".
      onConnectTimeout: (err) => {
        if (_readyFired || _stopped) return
        fail(String((err && err.message) || err))
      },
    })

    // visionEnabled: true — registration is unconditional here because the
    // provider (and its capabilities.vision) does not exist yet at adapter
    // construction; the AUTHORITATIVE D-10 gate is the orchestrator's
    // tool-list filter (combinedToolsFor), which never offers `look` to
    // a non-VLM provider. Without this flag the action was never registered
    // at all — the filter can only remove tools, not add them (15-VERIFICATION
    // gap, VIS-02).
    _adapter = createMinecraftAdapter({ bot: _bot, config, visionEnabled: true })
    // Minecraft dashboard (260721): telemetry for THIS mineflayer instance.
    // Emits nothing until the renderer flags itself watching (setDashboardWatch
    // below); the flag is re-applied across reconnects.
    if (typeof onDashboard === 'function') {
      try { _dash?.stop() } catch {}
      _dash = _adapter.createTelemetry({ emit: onDashboard, logger })
      if (_dashWatching) _dash.setWatching(true)
    }
    // Keep the brain local until we've confirmed the connection survived the
    // createBrain await. onEnd (a fast-failing reconnect, or the user closing
    // the world) can fire DURING this await — it nulls _bot and _adapter. If
    // we assigned _brain unconditionally and then touched _bot._sei_startChat,
    // we hit "Cannot read properties of null (reading '_sei_startChat')" on
    // every dropped reconnect (observed in the field log).
    const brain = await createBrain(_adapter)
    if (_stopped || !_bot) {
      // The connection dropped (or we were stopped) while createBrain awaited.
      // This brain is already orphaned — tear it down instead of wiring chat
      // onto a dead/null bot. Any reconnect was already scheduled by onEnd.
      try { await brain.stop() } catch {}
      return
    }
    _brain = brain
    try { onBrainReady(brain) } catch (err) {
      logger.warn(`onBrainReady hook threw: ${err && err.message}`)
    }

    // Wire the legacy chat behavior (bot.on('chat') with player/addressed/
    // nearby filtering and sei:chat_received emission) without an
    // orchestrator handle. fsmWires translates sei:chat_received into
    // brain.onChat; the brain priority queue handles player-chat preemption
    // (P1→P0 escalation when a non-P0 action is in flight). Stop-verb
    // fast-path body-cancel was previously a synchronous side-effect of
    // chat.js when given an orchestrator; with the brain↔adapter seam,
    // that fast path runs through the normal queue (one extra Haiku
    // round-trip on "stop").
    try { _bot._sei_startChat?.(null) } catch (err) {
      logger.warn(`startChat hookup failed: ${err && err.message}`)
    }
  }

  function makeHandle() {
    return {
      get adapter() { return _adapter },
      get telemetry() { return _dash },
      async stop() {
        _stopped = true
        clearTimeout(_reconnectTimer)
        try { _dash?.stop() } catch {}
        _dash = null
        if (_brain) {
          const b = _brain
          _brain = null
          try { onBrainLost() } catch {}
          try { await b.stop() } catch {}
        }
        // Same teardown as onEnd to guarantee clean listener disposal on
        // graceful shutdown, not just on reconnect.
        try { _adapter?.detach?.() } catch {}
        _adapter = null
        if (_bot) {
          try { _bot.quit('Sei stopping') } catch {}
          _bot = null
        }
        logger.info('Bot stopped.')
      },
      /**
       * 260618: the roster of OTHER AI companions in this world (never this
       * bot's own name). Written to config._seiCompanions, which chat.js reads
       * (it has no orchestrator handle) to skip interrupts aimed at a sibling.
       * Returns the filtered list for the composer to forward to the brain.
       */
      setCompanions(names) {
        const list = Array.isArray(names)
          ? names.filter(n => typeof n === 'string' && n.trim() && n !== mc.username)
          : []
        try { config._seiCompanions = list } catch {}
        return list
      },
      /**
       * Minecraft dashboard (260721): the renderer's visibility flag. The flag
       * is remembered so a reconnect's fresh telemetry instance resumes in the
       * same state.
       */
      setDashboardWatch(active) {
        _dashWatching = active === true
        try { _dash?.setWatching(_dashWatching) } catch {}
      },
    }
  }

  await bringUp()
  // emitVisionCapability is the composer's; the composer calls it itself once
  // createRuntime resolves (the brain is wired by then). Kept in the hook set
  // so a runtime that rebuilds its provider mid-session can re-publish.
  void emitVisionCapability
  return makeHandle()
}
