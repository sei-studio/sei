// src/bot/adapter/factorio/runtime.js: the Factorio game runtime. The composer
// (src/bot/index.js) dynamic-imports this by config.adapter.kind ===
// 'factorio'. It owns the link to the sei-companion Lua mod
// (native/factorio-mod/PROTOCOL.md): a localhost UDP socket to the port the
// game opened with --enable-lua-udp, the hello + spawn inside the
// supervisor's deadline, the feed poll, liveness (paused vs closed), and the
// per-connection brain lifecycle through the composer's hooks. Contract:
// RuntimeHooks / RuntimeHandle in src/bot/brain/types.js.
//
// Liveness. Factorio only reads its UDP socket while the game ticks, so a
// single-player game sitting in its menu simply stops answering. That holds
// the brain (no turns on a frozen world) and resumes when replies come back.
// A game that has QUIT closes its socket and the OS reports the port
// unreachable: that ends the session as world_closed. A reloaded save loses
// the mod's state, so she is spawned again; a different save ends the
// session (her memory is per world).

import { createFactorioClient } from './client.js'
import { createFactorioAdapter } from './index.js'
import { classifyConnectError } from './errors.js'
import { createFactorioStats } from './stats.js'
import { stardewNameFromRaw } from '../../names.js'

/** The mod's wire protocol this runtime speaks (api.lua api.PROTOCOL). */
export const PROTOCOL = 1

/** The companion's in-game name: readable, plain letters, 24 chars (the mod clamps too). */
export function botUsernameFor(character) {
  const raw = typeof character?.username === 'string' && character.username.trim()
    ? character.username.trim()
    : String(character?.name || '')
  return stardewNameFromRaw(raw)
}

/**
 * The `adapter.factorio` block for ConfigSchema (src/bot/config.js
 * FactorioAdapterSchema). `joinTarget` is main's FactorioJoinTarget
 * { port, label?, color? } (src/shared/factorioIpc.ts): `port` is the UDP
 * port main launched the game with.
 */
export function adapterConfigFrom({ joinTarget, botUsername }) {
  const color = joinTarget?.color
  return {
    host: '127.0.0.1',
    port: joinTarget?.port ?? undefined,
    username: botUsername,
    ...(typeof joinTarget?.label === 'string' && joinTarget.label ? { label: joinTarget.label } : {}),
    ...(color && typeof color === 'object' ? { color } : {}),
  }
}

/** No port means main has no Factorio it launched with the UDP option. */
export function checkJoinTarget(joinTarget) {
  if (joinTarget?.port == null) {
    return {
      error: 'GAME_WORLD_NOT_OPEN',
      message: 'Factorio is not running with the Sei link. Start Factorio from Sei, load a game, and press Launch again.',
    }
  }
  return null
}

export const MAX_CONNECT_ATTEMPTS = 3
export const MAX_RESPAWNS = 5
export const REPORT_MARGIN_MS = 3_000
export const MIN_CONNECT_TIMEOUT_MS = 5_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
export const STATS_EVERY_MS = 30_000

export function connectTimeoutFor(summonDeadlineAt, now = Date.now()) {
  if (!Number.isFinite(summonDeadlineAt)) return DEFAULT_CONNECT_TIMEOUT_MS
  return Math.max(MIN_CONNECT_TIMEOUT_MS, summonDeadlineAt - now - REPORT_MARGIN_MS)
}

/** The mod's spawn refusal as a tagged terminal message. */
export function spawnErrorMessage(detail) {
  const d = String(detail ?? '')
  if (/already has \d+ companions/.test(d)) {
    return `GAME_NOT_ANSWERING: This Factorio player already has the most companions the mod allows (${d}).`
  }
  return `GAME_NOT_ANSWERING: The Sei companion mod refused the spawn: ${d || 'unknown error'}.`
}

/**
 * @param {object} config  Parsed bot config (config.adapter.kind === 'factorio').
 * @param {import('../../brain/types.js').RuntimeHooks & { postPortMessage?: Function, createClient?: Function, connectTimeoutMs?: number, now?: () => number }} hooks
 * @returns {Promise<import('../../brain/types.js').RuntimeHandle>}
 */
export async function createRuntime(config, hooks) {
  const {
    logger, summonDeadlineAt, createBrain, onBrainReady, onBrainLost,
    onConnected, onDisconnected, onError, onDashboard,
    postPortMessage = null,
    // Test seams.
    createClient = createFactorioClient,
    connectTimeoutMs: connectTimeoutOverride = null,
    now = () => Date.now(),
    watchIntervalMs = 1_000,
  } = hooks
  const fc = config.adapter.factorio
  const quietMs = fc.quiet_ms ?? 15_000
  const idleEndMs = fc.idle_end_ms ?? 30 * 60_000
  const reconnectDelayMs = fc.reconnect_delay_ms ?? 3000

  const stats = createFactorioStats()
  let _client = null
  let _adapter = null
  let _brain = null
  let _dash = null
  let _dashWatching = false
  let _stopped = false
  let _readyFired = false
  let _cid = null
  let _hello = null
  let _spawnedName = null
  let _watchTimer = null
  let _statsTimer = null
  let _respawning = false
  let _respawns = 0
  let _quietSince = 0

  const fail = (message, end = null) => {
    const extra = end?.endReason ? { endReason: end.endReason } : {}
    try { onError({ error: classifyConnectError(message), message, ...extra }) } catch (cbErr) {
      logger.warn(`onError hook threw: ${cbErr && cbErr.message}`)
    }
  }

  function postStats(force = false) {
    if (!postPortMessage || (!force && !stats.isDirty())) return
    try { postPortMessage({ type: 'factorio-stats', stats: stats.snapshot() }) } catch {}
  }

  async function teardownConnection() {
    clearInterval(_watchTimer)
    _watchTimer = null
    try { _client?.stopPolling() } catch {}
    try { _adapter?.detach?.() } catch {}
    _adapter = null
    try { _dash?.stop() } catch {}
    _dash = null
    if (_brain) {
      const b = _brain
      _brain = null
      try { onBrainLost() } catch {}
      try { await b.stop() } catch (err) { logger.warn(`brain stop threw: ${err && err.message}`) }
    }
  }

  function endSession(message, endReason = null) {
    if (_stopped) return
    _stopped = true
    logger.info(`[sei] Factorio session ending: ${message}`)
    void (async () => {
      postStats(true)
      await teardownConnection()
      try { _client?.close() } catch {}
      _client = null
      try { onDisconnected({ reason: message, willRetry: false }) } catch {}
      fail(message, endReason ? { endReason } : null)
    })()
  }

  /** Spawn (or re-spawn after a reloaded save) and point the feed at her. */
  async function spawn(client, timeoutMs) {
    const req = { op: 'spawn', name: fc.username }
    if (fc.color) req.color = fc.color
    let r
    try {
      r = await client.request(req, { timeoutMs })
    } catch (err) {
      throw new Error(`BOT_START_TIMEOUT: Factorio answered but the companion did not spawn in time (${err?.message ?? err}). Make sure a game is loaded and not paused, then try again.`)
    }
    if (!r?.ok) throw new Error(spawnErrorMessage(r?.error))
    _cid = r.cid
    _spawnedName = fc.username
    client.startPolling(_cid, { since: 0 })
    return r
  }

  /** Paused vs closed vs reloaded, once a second. */
  function watch(client) {
    let checking = false
    _watchTimer = setInterval(async () => {
      if (_stopped || client !== _client || checking) return
      const t = now()
      const lastReply = client.lastReplyAt
      // The OS refused our datagrams after the last answer: the game quit.
      if (client.lastRefusedAt > lastReply && t - client.lastRefusedAt < 5_000) {
        endSession('GAME_WORLD_NOT_OPEN: Factorio was closed. Start it again from Sei and load your game.', 'world_closed')
        return
      }
      const quiet = lastReply > 0 && t - lastReply > quietMs
      if (quiet) {
        if (!_quietSince) {
          _quietSince = lastReply
          logger.info('[sei] Factorio stopped answering (paused, in a menu, or saving); holding the brain.')
          _adapter?.setGameQuiet?.(true)
        }
        if (t - _quietSince > idleEndMs) {
          endSession('GAME_WORLD_NOT_OPEN: Factorio has not answered for a long time (paused or back at the main menu). Load your game and press Launch again.', 'world_closed')
        }
        return
      }
      if (_quietSince) {
        _quietSince = 0
        logger.info('[sei] Factorio is answering again.')
        // Back from a pause, or a save was loaded: is it still our world?
        checking = true
        try {
          const h = await client.request({ op: 'hello' }, { timeoutMs: 4_000 })
          if (_hello?.world && h?.world && h.world !== _hello.world) {
            endSession('GAME_WORLD_NOT_OPEN: A different Factorio save was loaded. Press Launch again to bring her into this one.', 'world_closed')
            return
          }
        } catch {} finally { checking = false }
        _adapter?.setGameQuiet?.(false)
      }
    }, watchIntervalMs)
  }

  async function onPollError(err) {
    const msg = String(err?.message ?? err)
    if (_stopped || _respawning || !/no companion/.test(msg)) return
    // A reloaded save forgot her: spawn her again, same session.
    if (_respawns >= MAX_RESPAWNS) {
      endSession('GAME_NOT_ANSWERING: The companion kept disappearing from the game. Press Launch again.')
      return
    }
    _respawning = true
    _respawns += 1
    stats.respawnedByApp()
    try {
      const client = _client
      const h = await client.request({ op: 'hello' }, { timeoutMs: 4_000 })
      if (_hello?.world && h?.world && h.world !== _hello.world) {
        endSession('GAME_WORLD_NOT_OPEN: A different Factorio save was loaded. Press Launch again to bring her into this one.', 'world_closed')
        return
      }
      await spawn(client, 8_000)
      logger.info('[sei] The save was reloaded; spawned her again.')
      await _adapter?.refreshObservation?.()
    } catch (e) {
      logger.warn(`[sei] respawn after reload failed: ${e?.message ?? e}`)
    } finally {
      _respawning = false
    }
  }

  async function bringUp() {
    const budget = connectTimeoutOverride ?? connectTimeoutFor(summonDeadlineAt)
    const startedAt = now()
    const client = createClient({ gamePort: fc.port, host: fc.host, logger })
    _client = client
    try {
      await client.open()
    } catch (err) {
      throw new Error(`GAME_NOT_ANSWERING: Could not open the local link to Factorio (${err?.message ?? err}).`)
    }

    let hello
    try {
      hello = await client.request({ op: 'hello' }, { timeoutMs: Math.max(2_000, Math.min(budget, 10_000)) })
    } catch (err) {
      const refused = client.lastRefusedAt > 0
      throw new Error(refused
        ? `GAME_WORLD_NOT_OPEN: Factorio is not running with the Sei link on port ${fc.port}. Start it from Sei, load a game, and press Launch again.`
        : `GAME_NOT_ANSWERING: Factorio did not answer on port ${fc.port} (${err?.message ?? err}). Load a game (not the main menu), make sure it is not paused, and check that the Sei companion mod is enabled.`)
    }
    if (!hello?.ok || !hello.mod) {
      throw new Error('GAME_NOT_ANSWERING: Something answered on the Factorio port, but it was not the Sei companion mod.')
    }
    if (Number(hello.protocol) !== PROTOCOL) {
      throw new Error(`GAME_VERSION_UNSUPPORTED: The Sei companion mod in Factorio (version ${hello.mod}) does not match this version of Sei. Start Factorio from Sei once so it can update the mod.`)
    }
    _hello = hello
    client.on('poll-error', (err) => { void onPollError(err) })

    const remaining = Math.max(2_000, budget - (now() - startedAt))
    await spawn(client, remaining)

    _adapter = createFactorioAdapter({ client, cid: _cid, config, botUsername: _spawnedName, hello, stats, logger, now })
    if (typeof onDashboard === 'function') {
      _dash = _adapter.createTelemetry({ emit: onDashboard, logger })
      if (_dashWatching) _dash.setWatching?.(true)
    }
    await _adapter.refreshObservation()

    const brain = await createBrain(_adapter)
    if (_stopped || client !== _client) {
      try { await brain.stop() } catch {}
      return
    }
    _brain = brain
    _adapter.bindBrain?.(brain)
    try { onBrainReady(brain) } catch (err) { logger.warn(`onBrainReady hook threw: ${err && err.message}`) }
    try { _adapter.signalSpawned?.() } catch (err) { logger.warn(`signalSpawned threw: ${err && err.message}`) }
    watch(client)
    _statsTimer = setInterval(() => postStats(false), STATS_EVERY_MS)

    if (!_readyFired) {
      _readyFired = true
      try { onConnected() } catch (err) { logger.warn(`onConnected hook threw: ${err && err.message}`) }
    }
  }

  function makeHandle() {
    return {
      get adapter() { return _adapter },
      get telemetry() { return _dash },
      async stop() {
        const wasStopped = _stopped
        _stopped = true
        clearInterval(_statsTimer)
        postStats(true)
        const client = _client
        _client = null
        const cid = _cid
        await teardownConnection()
        if (client && !wasStopped) {
          try { if (cid) await client.request({ op: 'despawn', cid }, { timeoutMs: 3_000 }) } catch {}
        }
        try { client?.close() } catch {}
        logger.info('Factorio companion stopped.')
      },
      setCompanions(names) {
        const list = Array.isArray(names)
          ? names.filter((n) => typeof n === 'string' && n.trim() && n !== fc.username && n !== _spawnedName)
          : []
        try { config._seiCompanions = list } catch {}
        return list
      },
      setDashboardWatch(active) {
        _dashWatching = active === true
        try { _dash?.setWatching?.(_dashWatching) } catch {}
      },
    }
  }

  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS && !_stopped; attempt++) {
    try {
      await bringUp()
      return makeHandle()
    } catch (err) {
      const message = String(err?.message ?? err)
      await teardownConnection()
      try { _client?.close() } catch {}
      _client = null
      // Only a silent game is worth another try (it may be finishing a load).
      const retryable = message.startsWith('GAME_NOT_ANSWERING: Factorio did not answer')
      const deadlinePassed = Number.isFinite(summonDeadlineAt) && now() + reconnectDelayMs + MIN_CONNECT_TIMEOUT_MS > summonDeadlineAt
      if (!retryable || attempt === MAX_CONNECT_ATTEMPTS || deadlinePassed) {
        logger.error(`[sei] ${message}`)
        try { onDisconnected({ reason: message, willRetry: false }) } catch {}
        fail(message)
        return makeHandle()
      }
      logger.info(`[sei] Connect attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed (${message}); retrying in ${reconnectDelayMs}ms.`)
      try { onDisconnected({ reason: message, willRetry: true }) } catch {}
      await new Promise((r) => setTimeout(r, reconnectDelayMs))
    }
  }
  return makeHandle()
}
