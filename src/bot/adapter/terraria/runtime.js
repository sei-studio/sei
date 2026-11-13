// src/bot/adapter/terraria/runtime.js — the Terraria game runtime. The
// composer (src/bot/index.js) dynamic-imports this by
// config.adapter.kind === 'terraria'. It owns the body's link to the
// tModLoader mod: connect + spawn inside the supervisor's deadline, a bounded
// reconnect policy (the Stardew shape), the adapter + telemetry per
// connection, and the brain lifecycle through the composer's hooks.
// Contract: RuntimeHooks / RuntimeHandle in src/bot/brain/types.js.

import { createTerrariaClient, fetchHello } from './client.js'
import { createTerrariaAdapter } from './index.js'
import { classifyConnectError } from './errors.js'
import { protocolSupported } from './modVersion.js'
import { createTerrariaStats } from './stats.js'

/** How often the session counters go up the port while they change. */
export const STATS_EVERY_MS = 30_000

/** Terraria shows names as typed; the mod trims to 20 characters and drops control characters. */
export const MAX_NAME_CHARS = 20

/**
 * The companion's in-game name: the persona's username or name, trimmed,
 * without characters that would break a chat line. Falls back to 'Sei'.
 */
export function botUsernameFor(character) {
  const raw = typeof character?.username === 'string' && character.username.trim()
    ? character.username.trim()
    : String(character?.name || '')
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f[\]<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS).trim()
  return clean || 'Sei'
}

/**
 * The `adapter.terraria` block for ConfigSchema (src/bot/config.js
 * TerrariaAdapterSchema). `joinTarget` is main's TerrariaJoinTarget:
 * { port, token, label, uniqueId?, owner?, appearance? } (src/shared/terrariaIpc.ts).
 */
export function adapterConfigFrom({ joinTarget, botUsername }) {
  const appearance = joinTarget?.appearance
  return {
    ...(appearance && typeof appearance === 'object' ? { appearance } : {}),
    // localhost, not 127.0.0.1: on Windows the mod's HttpListener can only
    // bind the `localhost` prefix without a URL ACL.
    host: 'localhost',
    port: joinTarget?.port ?? undefined,
    token: joinTarget?.token ?? '',
    username: botUsername,
    ...(typeof joinTarget?.owner === 'string' && joinTarget.owner ? { owner: joinTarget.owner } : {}),
  }
}

/** No port/token means main found no answering mod: nothing to join. */
export function checkJoinTarget(joinTarget) {
  if (joinTarget?.port == null || !joinTarget?.token) {
    return {
      error: 'GAME_WORLD_NOT_OPEN',
      message:
        'Terraria is not answering. Start tModLoader with the Sei companion mod enabled, enter a world, and press Launch again.',
    }
  }
  return null
}

export const MAX_CONNECT_ATTEMPTS = 3
export const MAX_RECONNECT_ATTEMPTS = 3
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
    case 'NO_WORLD':
      return 'GAME_WORLD_NOT_OPEN: tModLoader is open but no world is loaded. Enter your world, then press Launch again.'
    case 'NOT_HOST':
      return 'GAME_WORLD_NOT_OPEN: This Terraria game joined someone else\'s server. The companion can only join a world you play alone or host.'
    case 'NAME_TAKEN':
      return `GAME_NOT_ANSWERING: A companion with this name is already in the world (${detail ?? ''}).`
    case 'NO_SLOT':
      return 'GAME_NOT_ANSWERING: The world has no free slot for another companion.'
    default:
      return `GAME_NOT_ANSWERING: The Terraria mod refused the spawn: ${detail ?? code ?? 'unknown error'}.`
  }
}

/**
 * @param {object} config  Parsed bot config (config.adapter.kind === 'terraria').
 * @param {import('../../brain/types.js').RuntimeHooks & { createClient?: Function, fetchHello?: Function, connectTimeoutMs?: number, postPortMessage?: Function }} hooks
 * @returns {Promise<import('../../brain/types.js').RuntimeHandle>}
 */
export async function createRuntime(config, hooks) {
  const {
    logger, summonDeadlineAt, createBrain, onBrainReady, onBrainLost,
    onConnected, onDisconnected, onError, onDashboard, postPortMessage = null,
    createClient = createTerrariaClient,
    fetchHello: hello = fetchHello,
    connectTimeoutMs: connectTimeoutOverride = null,
  } = hooks
  const tc = config.adapter.terraria
  const reconnectDelayMs = tc.reconnect_delay_ms ?? 3000

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
  // One counter set per summon, across reconnects (shape only, stats.js).
  const stats = createTerrariaStats()
  let _statsTimer = null
  const postStats = (force = false) => {
    if (typeof postPortMessage !== 'function') return
    if (!force && !stats.isDirty()) return
    try { postPortMessage({ type: 'terraria-stats', stats: stats.snapshot() }) } catch {}
  }

  const fail = (message, end = null) => {
    // The final counters reach main before the terminal status closes the session.
    if (_readyFired) postStats(true)
    clearInterval(_statsTimer)
    const extra = end?.endReason ? { endReason: end.endReason } : {}
    try { onError({ error: classifyConnectError(message), message, ...extra }) } catch (cbErr) {
      logger.warn(`onError hook threw: ${cbErr && cbErr.message}`)
    }
  }

  /** Is a world still loaded behind the mod's hello? Tells a dropped link from a closed world. */
  async function worldStillOpen() {
    try {
      const h = await hello({ port: tc.port, host: tc.host, timeoutMs: 1500 })
      return !!h && h.world?.loaded === true
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

  async function bringUp() {
    const budget = connectTimeoutOverride ?? connectTimeoutFor(summonDeadlineAt)
    const startedAt = Date.now()
    const client = createClient({ port: tc.port, host: tc.host, token: tc.token, logger })
    _client = client

    client.on('close', (info) => {
      if (_stopped || client !== _client) return
      onConnectionLost(info?.reason ? `connection closed: ${info.reason}` : 'connection closed')
    })
    client.on('despawned', (f) => {
      if (_stopped || client !== _client) return
      // The world closed under the body (the mod despawns everyone on unload).
      onConnectionLost(`despawned: ${f?.reason ?? 'world closed'}`)
    })

    try {
      await client.connect({ timeoutMs: Math.max(2000, Math.min(budget, 10_000)) })
    } catch (err) {
      const reason = String(err?.message ?? err)
      let alive = false
      try { alive = !!(await hello({ port: tc.port, host: tc.host, timeoutMs: 1500 })) } catch { alive = false }
      if (alive || /401|unauthorized/i.test(reason)) {
        throw new Error(`GAME_NOT_ANSWERING: Terraria is running but refused the connection token (${reason}). Run the Terraria setup in Sei again so the mod and the app share a token, then restart tModLoader.`)
      }
      throw new Error(`GAME_NOT_ANSWERING: Could not reach the Sei companion mod on port ${tc.port} (${reason}). Start tModLoader with the mod enabled and enter your world.`)
    }

    const protocol = client.welcome?.hello?.protocol
    if (protocol != null && !protocolSupported(protocol)) {
      throw new Error(`GAME_VERSION_UNSUPPORTED: The Sei mod in Terraria speaks protocol ${protocol}, newer than this app. Update Sei.`)
    }

    const remaining = Math.max(2000, budget - (Date.now() - startedAt))
    let result
    try {
      const spawnFrame = { t: 'spawn', name: tc.username }
      if (tc.appearance) spawnFrame.appearance = tc.appearance
      if (tc.owner) spawnFrame.owner = tc.owner
      result = await client.request(spawnFrame, { timeoutMs: remaining })
    } catch (err) {
      throw new Error(`BOT_START_TIMEOUT: The Terraria mod answered but the companion did not appear in time (${err?.message ?? err}). Make sure you are in a world (not the menu) and try again.`)
    }
    if (!result?.ok) {
      throw new Error(spawnErrorMessage(result?.error, result?.detail))
    }
    _spawnedName = result.name ?? tc.username

    _adapter = createTerrariaAdapter({ client, config, botUsername: _spawnedName, logger, stats })
    if (typeof onDashboard === 'function') {
      _dash = _adapter.createTelemetry({ emit: onDashboard, logger })
      if (_dashWatching) _dash.setWatching(true)
    }
    await _adapter.refreshObservation()

    const brain = await createBrain(_adapter)
    if (_stopped || client !== _client || !client.isOpen) {
      try { await brain.stop() } catch {}
      return
    }
    _brain = brain
    try { onBrainReady(brain) } catch (err) { logger.warn(`onBrainReady hook threw: ${err && err.message}`) }
    try { _adapter.signalSpawned?.() } catch (err) { logger.warn(`signalSpawned threw: ${err && err.message}`) }

    if (!_readyFired) {
      _readyFired = true
      _attempts = 0
      if (!_statsTimer && typeof postPortMessage === 'function') {
        _statsTimer = setInterval(() => postStats(false), STATS_EVERY_MS)
        _statsTimer.unref?.()
      }
      try { onConnected() } catch (err) { logger.warn(`onConnected hook threw: ${err && err.message}`) }
    }
  }

  let _lossHandled = null
  function onConnectionLost(reason) {
    const client = _client
    if (_lossHandled === client) return
    _lossHandled = client
    clearTimeout(_reconnectTimer)
    void (async () => {
      await teardownConnection()
      if (_stopped) return
      if (!_readyFired) return
      try { client?.close('lost') } catch {}
      const open = await worldStillOpen()
      if (_stopped) return
      if (!open) {
        _stopped = true
        logger.info(`[sei] Terraria closed or left the world (${reason}); stopping.`)
        try { onDisconnected({ reason, willRetry: false }) } catch {}
        fail(`GAME_WORLD_NOT_OPEN: Lost the world (${reason}). Enter your world in Terraria and press Launch again.`, { endReason: 'world_closed' })
        return
      }
      _attempts += 1
      if (_attempts > MAX_RECONNECT_ATTEMPTS) {
        _stopped = true
        try { onDisconnected({ reason, willRetry: false }) } catch {}
        fail(`GAME_NOT_ANSWERING: The Terraria mod kept dropping the connection (${reason}). Try launching again in a moment.`)
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
        clearInterval(_statsTimer)
        if (_readyFired) postStats(true)
        const client = _client
        _client = null
        await teardownConnection()
        if (client) {
          try {
            if (client.isOpen) await client.request({ t: 'despawn' }, { timeoutMs: 3000 })
          } catch {}
          try { client.close('Sei stopping') } catch {}
        }
        logger.info('Terraria companion stopped.')
      },
      setCompanions(names) {
        const list = Array.isArray(names)
          ? names.filter((n) => typeof n === 'string' && n.trim() && n !== tc.username && n !== _spawnedName)
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

  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS && !_stopped; attempt++) {
    try {
      await bringUp()
      return makeHandle()
    } catch (err) {
      const message = String(err?.message ?? err)
      await teardownConnection()
      try { _client?.close('retrying') } catch {}
      _client = null
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
