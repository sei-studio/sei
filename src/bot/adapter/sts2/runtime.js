// src/bot/adapter/sts2/runtime.js: the Slay the Spire 2 game runtime. The
// composer (src/bot/index.js) dynamic-imports this by config.adapter.kind ===
// 'sts2'. It owns the localhost WebSocket server the Sei StS2 mod connects to
// (native/sts2-mod/PROTOCOL.md, the Neuro SDK protocol plus `sei/*`), waits
// for the companion's game window (the seat) inside the supervisor's
// deadline, and runs the brain while a seat is connected. Contract:
// RuntimeHooks / RuntimeHandle in src/bot/brain/types.js.
//
// Co-op design (spike 261115): the companion plays in her OWN game window, a
// second instance main starts with `--force-steam off --clientId N -fastmp
// join`, which joins the player's game over the game's built-in localhost
// ENet transport. The mod in that window is the seat. The player's window
// runs the same mod as the host role (lobby + chat), optional for the brain.
//
// Liveness. A seat that drops (the window closed or crashed) holds the brain;
// a new seat within seat_grace_ms resumes the session (a restarted window),
// otherwise the session ends as world_closed.

import { createWsServer } from './wsServer.js'
import { createSts2Link, GAME_NAME, SEI_PROTOCOL } from './link.js'
import { createSts2Adapter } from './index.js'
import { classifyConnectError } from './errors.js'
import { createSts2Stats } from './stats.js'
import { stardewNameFromRaw } from '../../names.js'

export const LINK_PATH = '/sei-sts2'
export const REPORT_MARGIN_MS = 3_000
export const MIN_CONNECT_TIMEOUT_MS = 5_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 25_000
export const STATS_EVERY_MS = 30_000
/** Turn-based: nothing happens between decision points, so idle ticks stay rare. */
export const STS2_IDLE_FALLBACK_MS = 10 * 60_000

/** The companion's display name: readable, plain letters, 24 chars. */
export function botUsernameFor(character) {
  const raw = typeof character?.username === 'string' && character.username.trim()
    ? character.username.trim()
    : String(character?.name || '')
  return stardewNameFromRaw(raw)
}

/**
 * The `adapter.sts2` block for ConfigSchema (src/bot/config.js Sts2AdapterSchema).
 * `joinTarget` is main's Sts2JoinTarget { port, token, label? } (src/shared/sts2Ipc.ts).
 */
export function adapterConfigFrom({ joinTarget, botUsername }) {
  return {
    host: '127.0.0.1',
    port: joinTarget?.port ?? undefined,
    token: typeof joinTarget?.token === 'string' ? joinTarget.token : null,
    username: botUsername,
    ...(typeof joinTarget?.label === 'string' && joinTarget.label ? { label: joinTarget.label } : {}),
  }
}

export function checkJoinTarget(joinTarget) {
  if (joinTarget?.port == null) {
    return {
      error: 'GAME_WORLD_NOT_OPEN',
      message: 'Slay the Spire 2 is not set up for Sei yet. Open the Slay the Spire 2 panel in Sei, install the mod, and press Launch again.',
    }
  }
  return null
}

export function connectTimeoutFor(summonDeadlineAt, now = Date.now()) {
  if (!Number.isFinite(summonDeadlineAt)) return DEFAULT_CONNECT_TIMEOUT_MS
  return Math.max(MIN_CONNECT_TIMEOUT_MS, summonDeadlineAt - now - REPORT_MARGIN_MS)
}

/**
 * @param {object} config  Parsed bot config (config.adapter.kind === 'sts2').
 * @param {import('../../brain/types.js').RuntimeHooks & { postPortMessage?: Function, createServer?: Function, connectTimeoutMs?: number, now?: () => number, adapterOpts?: object }} hooks
 * @returns {Promise<import('../../brain/types.js').RuntimeHandle>}
 */
export async function createRuntime(config, hooks) {
  const {
    logger, summonDeadlineAt, createBrain, onBrainReady, onBrainLost,
    onConnected, onDisconnected, onError, onDashboard,
    postPortMessage = null,
    // Test seams.
    createServer = createWsServer,
    connectTimeoutMs: connectTimeoutOverride = null,
    now = () => Date.now(),
    adapterOpts = {},
  } = hooks
  const sc = config.adapter.sts2
  const seatGraceMs = sc.seat_grace_ms ?? 90_000
  try {
    config.llm = config.llm ?? {}
    if (config.llm.idle_fallback_ms == null) config.llm.idle_fallback_ms = STS2_IDLE_FALLBACK_MS
  } catch {}

  const stats = createSts2Stats({ now })
  let _server = null
  let _link = null
  let _adapter = null
  let _brain = null
  let _dash = null
  let _dashWatching = false
  let _stopped = false
  let _statsTimer = null
  let _graceTimer = null
  let _heldForSeat = false

  const fail = (message, end = null) => {
    const extra = end?.endReason ? { endReason: end.endReason } : {}
    try { onError({ error: classifyConnectError(message), message, ...extra }) } catch (cbErr) {
      logger.warn(`onError hook threw: ${cbErr && cbErr.message}`)
    }
  }

  function postStats(force = false) {
    if (!postPortMessage || (!force && !stats.isDirty())) return
    try { postPortMessage({ type: 'sts2-stats', stats: stats.snapshot() }) } catch {}
  }

  async function teardown() {
    clearTimeout(_graceTimer)
    clearInterval(_statsTimer)
    try { _adapter?.detach?.() } catch {}
    try { _dash?.stop() } catch {}
    _dash = null
    if (_brain) {
      const b = _brain
      _brain = null
      try { onBrainLost() } catch {}
      try { await b.stop() } catch (err) { logger.warn(`brain stop threw: ${err && err.message}`) }
    }
    _adapter = null
    const srv = _server
    _server = null
    try { await srv?.close() } catch {}
  }

  function endSession(message, endReason = null) {
    if (_stopped) return
    _stopped = true
    logger.info(`[sei] Slay the Spire 2 session ending: ${message}`)
    void (async () => {
      postStats(true)
      await teardown()
      try { onDisconnected({ reason: message, willRetry: false }) } catch {}
      fail(message, endReason ? { endReason } : null)
    })()
  }

  function holdBrain(on) {
    try { _brain?.setGamePaused?.(on) } catch (err) { logger.warn(`brain pause threw: ${err?.message ?? err}`) }
  }

  /** Resolves with the first seat that finished its startup, or rejects at the deadline. */
  function waitForSeat(link, ms) {
    if (link.seat) return Promise.resolve(link.seat)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { link.off('seat', on); reject(new Error('timeout')) }, ms)
      const on = (s) => { clearTimeout(t); link.off('seat', on); resolve(s) }
      link.on('seat', on)
    })
  }

  function checkSeat(s) {
    if (s.game && s.game !== GAME_NAME) {
      return `GAME_NOT_ANSWERING: Something connected to the Sei link that is not Slay the Spire 2 (${String(s.game).slice(0, 40)}).`
    }
    if (s.hello && s.hello.protocol !== SEI_PROTOCOL) {
      return `GAME_VERSION_UNSUPPORTED: The Sei mod in Slay the Spire 2 (version ${s.hello.version ?? '?'}) does not match this version of Sei. Open the Slay the Spire 2 panel in Sei and update the mod.`
    }
    return null
  }

  async function bringUp() {
    const budget = connectTimeoutOverride ?? connectTimeoutFor(summonDeadlineAt)
    try {
      _server = await createServer({ port: sc.port, host: sc.host ?? '127.0.0.1', path: LINK_PATH, token: sc.token ?? null, requireToken: sc.require_token === true, logger })
    } catch (err) {
      const busy = err?.code === 'EADDRINUSE'
      throw new Error(busy
        ? `GAME_NOT_ANSWERING: The Sei link port ${sc.port} is taken by another program. Restart Sei and try again.`
        : `GAME_NOT_ANSWERING: Could not open the Sei link for Slay the Spire 2 (${err?.message ?? err}).`)
    }
    const link = createSts2Link({ server: _server, logger, now })
    link.displayName = sc.username
    _link = link

    let seat
    try {
      seat = await waitForSeat(link, budget)
    } catch {
      throw new Error('GAME_WORLD_NOT_OPEN: The companion\'s Slay the Spire 2 window did not connect in time. Start it from the Slay the Spire 2 panel in Sei (it opens a second game window), wait for its main menu, then press Launch again.')
    }
    const bad = checkSeat(seat)
    if (bad) throw new Error(bad)
    stats.setCoop(seat.hello?.coop === true || !!link.host)
    link.on('host', () => { stats.hostSeen(); stats.setCoop(true) })

    _adapter = createSts2Adapter({ link, config, botUsername: sc.username, stats, logger, ...adapterOpts })
    if (typeof onDashboard === 'function') {
      _dash = _adapter.createTelemetry({ emit: onDashboard, logger })
      if (_dashWatching) _dash.setWatching?.(true)
    }

    const brain = await createBrain(_adapter)
    if (_stopped) { try { await brain.stop() } catch {} return }
    _brain = brain
    try { onBrainReady(brain) } catch (err) { logger.warn(`onBrainReady hook threw: ${err && err.message}`) }
    try { _adapter.signalSpawned?.() } catch (err) { logger.warn(`signalSpawned threw: ${err && err.message}`) }

    link.on('seat-lost', () => {
      if (_stopped) return
      stats.seatDropped()
      logger.info('[sei] The companion\'s game window disconnected; holding the brain for a reconnect.')
      _heldForSeat = true
      holdBrain(true)
      clearTimeout(_graceTimer)
      _graceTimer = setTimeout(() => {
        if (!link.seat) endSession('GAME_WORLD_NOT_OPEN: The companion\'s Slay the Spire 2 window closed. Start it again from Sei and press Launch.', 'world_closed')
      }, seatGraceMs)
    })
    link.on('seat', (s) => {
      if (_stopped) return
      const why = checkSeat(s)
      if (why) { endSession(why); return }
      clearTimeout(_graceTimer)
      if (_heldForSeat) {
        _heldForSeat = false
        logger.info('[sei] The companion\'s game window is back.')
        holdBrain(false)
      }
    })
    _statsTimer = setInterval(() => postStats(false), STATS_EVERY_MS)
    try { onConnected() } catch (err) { logger.warn(`onConnected hook threw: ${err && err.message}`) }
  }

  function makeHandle() {
    return {
      get adapter() { return _adapter },
      get telemetry() { return _dash },
      /** Test seam: the live link. */
      get link() { return _link },
      async stop() {
        const was = _stopped
        _stopped = true
        postStats(true)
        // The companion's window closes itself on bye (Sei fork); main also ends the process.
        if (!was) { try { _link?.seat?.send('sei/bye', {}) } catch {} }
        await teardown()
        logger.info('Slay the Spire 2 companion stopped.')
      },
      setCompanions(names) {
        const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim() && n !== sc.username) : []
        try { config._seiCompanions = list } catch {}
        return list
      },
      setDashboardWatch(active) {
        _dashWatching = active === true
        try { _dash?.setWatching?.(_dashWatching) } catch {}
      },
    }
  }

  try {
    await bringUp()
  } catch (err) {
    const message = String(err?.message ?? err)
    _stopped = true
    await teardown()
    logger.error(`[sei] ${message}`)
    try { onDisconnected({ reason: message, willRetry: false }) } catch {}
    fail(message)
  }
  return makeHandle()
}
