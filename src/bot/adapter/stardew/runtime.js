// src/bot/adapter/stardew/runtime.js — the Stardew Valley game runtime (M1,
// 260908). The composer (src/bot/index.js) dynamic-imports this by
// config.adapter.kind === 'stardew'. It owns the body's link to the SMAPI
// mod: connect + spawn inside the supervisor's deadline, a bounded reconnect
// policy with the same shape as Minecraft's, the adapter + telemetry per
// connection, and the per-connection brain lifecycle through the composer's
// hooks. Contract: RuntimeHooks / RuntimeHandle in src/bot/brain/types.js.
//
// No heavy dependencies: Node 22's WebSocket global does the transport, so
// the Stardew game pack carries the SMAPI mod only.

import { createStardewClient, fetchHello } from './client.js'
import { createStardewAdapter } from './index.js'
import { classifyConnectError } from './errors.js'

/**
 * The companion's in-game name. The mod sanitises it again; here the persona
 * name is kept readable (spaces allowed, 24 chars) since it is a display
 * name, not a login. Falls back to 'Sei'.
 */
export function botUsernameFor(character) {
  const raw = typeof character?.username === 'string' && character.username.trim()
    ? character.username.trim()
    : String(character?.name || '')
  const cleaned = raw.replace(/[^A-Za-z0-9_ \-]/g, '').trim().slice(0, 24)
  return cleaned || 'Sei'
}

/**
 * The `adapter.stardew` block for ConfigSchema (src/bot/config.js
 * StardewAdapterSchema). `joinTarget` is main's StardewJoinTarget:
 * { port, token, label, uniqueId? } (src/shared/stardewIpc.ts).
 */
export function adapterConfigFrom({ joinTarget, botUsername }) {
  return {
    // localhost, not 127.0.0.1: the mod's HttpListener binds `localhost`
    // (the one prefix Windows allows without a URL ACL) and http.sys matches
    // the Host header, so the IP form would be refused there.
    host: 'localhost',
    port: joinTarget?.port ?? undefined,
    token: joinTarget?.token ?? '',
    username: botUsername,
  }
}

/** No port/token means main found no answering mod: nothing to join. */
export function checkJoinTarget(joinTarget) {
  if (joinTarget?.port == null || !joinTarget?.token) {
    return {
      error: 'GAME_WORLD_NOT_OPEN',
      message:
        'Stardew Valley is not answering. Start the game through SMAPI with the Sei companion mod ' +
        'installed, load your farm, and press Launch again.',
    }
  }
  return null
}

export const MAX_CONNECT_ATTEMPTS = 3
export const MAX_RECONNECT_ATTEMPTS = 3
/** Margin kept between our own connect guard and the supervisor's watchdog. */
export const REPORT_MARGIN_MS = 3_000
export const MIN_CONNECT_TIMEOUT_MS = 5_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000

/** Size the connect+spawn guard to land inside the supervisor deadline. */
export function connectTimeoutFor(summonDeadlineAt, now = Date.now()) {
  if (!Number.isFinite(summonDeadlineAt)) return DEFAULT_CONNECT_TIMEOUT_MS
  return Math.max(MIN_CONNECT_TIMEOUT_MS, summonDeadlineAt - now - REPORT_MARGIN_MS)
}

/** Map a mod spawn error code to a tagged terminal message. */
export function spawnErrorMessage(code, detail) {
  switch (code) {
    case 'NO_SAVE':
      return 'GAME_WORLD_NOT_OPEN: Stardew Valley is open but no farm is loaded. Load your save, then press Launch again.'
    case 'NOT_HOST':
      return 'GAME_WORLD_NOT_OPEN: This Stardew Valley game is a farmhand session. The companion can only join a farm you are hosting.'
    case 'FARMHAND_NO_MOD':
      return 'STARDEW_FARMHAND_NO_MOD: A connected farmhand does not have the Sei companion mod, so the companion cannot appear for them. Have them install the mod, or play without them.'
    case 'NAME_TAKEN':
      return `GAME_NOT_ANSWERING: A companion with this name is already in the farm (${detail ?? ''}).`
    default:
      return `GAME_NOT_ANSWERING: The Stardew Valley mod refused the spawn: ${detail ?? code ?? 'unknown error'}.`
  }
}

/**
 * @param {object} config  Parsed bot config (config.adapter.kind === 'stardew').
 * @param {import('../../brain/types.js').RuntimeHooks & { createClient?: Function, fetchHello?: Function, connectTimeoutMs?: number }} hooks
 * @returns {Promise<import('../../brain/types.js').RuntimeHandle>}
 */
export async function createRuntime(config, hooks) {
  const {
    logger, summonDeadlineAt, createBrain, onBrainReady, onBrainLost,
    onConnected, onDisconnected, onError, onDashboard,
    // Test seams: a fake client factory / hello probe.
    createClient = createStardewClient,
    fetchHello: hello = fetchHello,
    connectTimeoutMs: connectTimeoutOverride = null,
  } = hooks
  const sd = config.adapter.stardew
  const reconnectDelayMs = sd.reconnect_delay_ms ?? 3000

  let _client = null
  let _adapter = null
  let _brain = null
  let _dash = null
  let _dashWatching = false
  let _stopped = false
  let _readyFired = false
  let _attempts = 0
  let _reconnectTimer = null
  let _spawnedName = null

  const fail = (message) => {
    try { onError({ error: classifyConnectError(message), message }) } catch (cbErr) {
      logger.warn(`onError hook threw: ${cbErr && cbErr.message}`)
    }
  }

  /** Is the mod still answering its hello? Tells a kick/crash from a closed game. */
  async function worldStillOpen() {
    try {
      const h = await hello({ port: sd.port, host: sd.host, timeoutMs: 1500 })
      return !!h && h.save?.loaded === true
    } catch {
      return false
    }
  }

  async function teardownConnection() {
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

  /**
   * One connect + spawn attempt. Resolves when the body is spawned and the
   * brain is up; throws a tagged message on failure.
   */
  async function bringUp() {
    const budget = connectTimeoutOverride ?? connectTimeoutFor(summonDeadlineAt)
    const startedAt = Date.now()
    const client = createClient({ port: sd.port, host: sd.host, token: sd.token, logger })
    _client = client

    client.on('close', (info) => {
      if (_stopped || client !== _client) return
      onConnectionLost(info?.reason ? `connection closed: ${info.reason}` : 'connection closed')
    })

    try {
      await client.connect({ timeoutMs: Math.max(2000, Math.min(budget, 10_000)) })
    } catch (err) {
      const reason = String(err?.message ?? err)
      // The WebSocket error event carries no HTTP status, so a refused
      // upgrade (401: wrong token) looks like a dead port. The hello endpoint
      // needs no token: if it answers, the mod is up and the token is wrong.
      let alive = false
      try { alive = !!(await hello({ port: sd.port, host: sd.host, timeoutMs: 1500 })) } catch { alive = false }
      if (alive || /401|unauthorized/i.test(reason)) {
        throw new Error(`GAME_NOT_ANSWERING: Stardew Valley is running but refused the connection token (${reason}). Run the Stardew setup in Sei again so the mod and the app share a token.`)
      }
      throw new Error(`GAME_NOT_ANSWERING: Could not reach the Sei companion mod on port ${sd.port} (${reason}). Start Stardew Valley through SMAPI with the mod installed and load your farm.`)
    }

    // Spawn inside what is left of the budget.
    const remaining = Math.max(2000, budget - (Date.now() - startedAt))
    let result
    try {
      result = await client.request({ t: 'spawn', name: sd.username }, { timeoutMs: remaining })
    } catch (err) {
      throw new Error(`BOT_START_TIMEOUT: The Stardew Valley mod answered but the companion did not spawn in time (${err?.message ?? err}). Make sure your farm is loaded (not the title screen) and try again.`)
    }
    if (!result?.ok) {
      throw new Error(spawnErrorMessage(result?.error, result?.detail))
    }
    _spawnedName = result.name ?? sd.username

    _adapter = createStardewAdapter({ client, config, botUsername: _spawnedName, logger })
    if (typeof onDashboard === 'function') {
      _dash = _adapter.createTelemetry({ emit: onDashboard, logger })
      if (_dashWatching) _dash.setWatching(true)
    }
    // The brain's first turn needs a snapshot; do not wait for the 2 Hz push.
    await _adapter.refreshObservation()

    const brain = await createBrain(_adapter)
    if (_stopped || client !== _client || !client.isOpen) {
      try { await brain.stop() } catch {}
      return
    }
    _brain = brain
    try { onBrainReady(brain) } catch (err) { logger.warn(`onBrainReady hook threw: ${err && err.message}`) }

    // The mod's `spawned` push went by BEFORE the brain attached its handlers
    // (spawn is awaited above), so raise onSpawn ourselves now that they are
    // wired: that runs the world-identity resolve and the first idle tick.
    try { _adapter.signalSpawned?.() } catch (err) { logger.warn(`signalSpawned threw: ${err && err.message}`) }

    if (!_readyFired) {
      _readyFired = true
      _attempts = 0
      try { onConnected() } catch (err) { logger.warn(`onConnected hook threw: ${err && err.message}`) }
    }
  }

  function onConnectionLost(reason) {
    clearTimeout(_reconnectTimer)
    void (async () => {
      await teardownConnection()
      if (_stopped) return
      if (!_readyFired) {
        // Pre-spawn drop: the initial attempt loop handles retries.
        return
      }
      const open = await worldStillOpen()
      if (_stopped) return
      if (!open) {
        _stopped = true
        logger.info(`[sei] Stardew Valley closed or unloaded the farm (${reason}); stopping.`)
        try { onDisconnected({ reason, willRetry: false }) } catch {}
        fail(`GAME_WORLD_NOT_OPEN: Lost the farm (${reason}). Load your farm in Stardew Valley and press Launch again.`)
        return
      }
      _attempts += 1
      if (_attempts > MAX_RECONNECT_ATTEMPTS) {
        _stopped = true
        try { onDisconnected({ reason, willRetry: false }) } catch {}
        fail(`GAME_NOT_ANSWERING: The Stardew Valley mod kept dropping the connection (${reason}). Try launching again in a moment.`)
        return
      }
      logger.info(`[sei] Lost the mod connection (${reason}); rejoining in ${reconnectDelayMs}ms (attempt ${_attempts}/${MAX_RECONNECT_ATTEMPTS}).`)
      try { onDisconnected({ reason, willRetry: true }) } catch {}
      _reconnectTimer = setTimeout(() => {
        if (_stopped) return
        bringUp().catch((err) => {
          if (_stopped) return
          logger.warn(`Rejoin failed: ${err?.message ?? err}`)
          onConnectionLost(String(err?.message ?? err))
        })
      }, reconnectDelayMs)
    })()
  }

  function makeHandle() {
    return {
      get adapter() { return _adapter },
      get telemetry() { return _dash },
      async stop() {
        _stopped = true
        clearTimeout(_reconnectTimer)
        const client = _client
        _client = null
        await teardownConnection()
        if (client) {
          try {
            if (client.isOpen) await client.request({ t: 'despawn' }, { timeoutMs: 3000 })
          } catch {}
          try { client.close('Sei stopping') } catch {}
        }
        logger.info('Stardew companion stopped.')
      },
      setCompanions(names) {
        const list = Array.isArray(names)
          ? names.filter((n) => typeof n === 'string' && n.trim() && n !== sd.username && n !== _spawnedName)
          : []
        try { config._seiCompanions = list } catch {}
        return list
      },
      setDashboardWatch(active) {
        _dashWatching = active === true
        try { _dash?.setWatching(_dashWatching) } catch {}
      },
    }
  }

  // ── Initial connect: bounded attempts, then a terminal error ────────
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS && !_stopped; attempt++) {
    try {
      await bringUp()
      return makeHandle()
    } catch (err) {
      const message = String(err?.message ?? err)
      await teardownConnection()
      try { _client?.close('retrying') } catch {}
      _client = null
      // A refused spawn (no save, farmhand, name taken) or a bad token will
      // not change in three seconds: report at once.
      const retryable = message.startsWith('GAME_NOT_ANSWERING: Could not reach')
      const deadlinePassed = Number.isFinite(summonDeadlineAt) && Date.now() + reconnectDelayMs + MIN_CONNECT_TIMEOUT_MS > summonDeadlineAt
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
