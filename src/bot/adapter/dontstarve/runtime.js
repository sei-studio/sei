// src/bot/adapter/dontstarve/runtime.js — the Don't Starve Together game
// runtime (game-adapters M2, 260908).
//
// Unlike Minecraft, the BODY lives inside the player's game and the mod
// there can only make outbound HTTP requests to localhost (Klei's 2025
// sandbox), so this runtime is a SERVER: a `node:http` listener on an
// ephemeral 127.0.0.1 port with a per-summon token. It reports {port, token}
// up the port as {type:'dst-listen'}; main's watcher hands them to the mod
// in the next heartbeat response and the mod spawns the survivor, then
// POSTs observations + events here and long-polls GET /cmd for commands.
// Wire contract: native/dst-mod/PROTOCOL.md.
//
// Lifecycle:
//   listen -> dst-listen -> (mod) spawned  => adapter + brain, onConnected
//   heartbeat loss for heartbeat_loss_ms   => terminal GAME_WORLD_NOT_OPEN
//   no contact by the spawn deadline       => terminal GAME_NOT_ANSWERING
//   contact but no spawn by the deadline   => terminal DST_SPAWN_FAILED
//   death                                  => brain turn, then terminal DST_BODY_DIED
//   stop()                                 => despawn command, brain stop, close
//
// The four exports every game runtime provides (see adapter/minecraft/runtime.js):
//   botUsernameFor, adapterConfigFrom, checkJoinTarget, createRuntime.

import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createDontStarveAdapter } from './index.js'
import { classifyConnectError } from './errors.js'
import { createObservationState, createHandleRegistry, CMD_HOLD_MS, CMD_RESULT_TIMEOUT_MS, HEARTBEAT_LOSS_MS } from './protocol.js'

const MAX_BODY_BYTES = 65_536
const REPORT_MARGIN_MS = 3_000
const MIN_SPAWN_WAIT_MS = 5_000
const DEATH_GRACE_MS = 8_000
const DESPAWN_WAIT_MS = 2_500

/**
 * DST shows inst.name over the survivor; spaces and most characters are fine.
 * Trim to 32 (the talker/announce prefix stays readable). MIRROR:
 * src/main/games/dontstarve/index.ts effectiveUsername.
 */
export function botUsernameFor(character) {
  const raw = String(character?.name ?? '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()
  return (raw || 'Sei').slice(0, 32)
}

/**
 * The `adapter.dontstarve` block from main's DstJoinTarget. The join target
 * carries every character's stored survivor pick (main has no character id
 * when it builds it); this body's row is picked by character.id, else the
 * default (Wilson) with its brief.
 */
export function adapterConfigFrom({ joinTarget, botUsername, character }) {
  const jt = joinTarget && typeof joinTarget === 'object' ? joinTarget : {}
  const own = character?.id && jt.survivors && typeof jt.survivors === 'object' ? jt.survivors[character.id] : null
  const prefab = typeof own?.prefab === 'string' && own.prefab ? own.prefab : (typeof jt.defaultPrefab === 'string' && jt.defaultPrefab ? jt.defaultPrefab : 'wilson')
  const survivorBrief = typeof own?.brief === 'string' ? own.brief : (typeof jt.defaultBrief === 'string' ? jt.defaultBrief : '')
  return {
    username: botUsername,
    session: typeof jt.session === 'string' ? jt.session : '',
    label: typeof jt.label === 'string' ? jt.label : '',
    day: Number.isFinite(jt.day) ? jt.day : 1,
    season: typeof jt.season === 'string' ? jt.season : '',
    phase: typeof jt.phase === 'string' ? jt.phase : '',
    caves: jt.caves === true,
    nearUserid: typeof jt.nearUserid === 'string' ? jt.nearUserid : '',
    nearName: typeof jt.nearName === 'string' ? jt.nearName : '',
    prefab,
    survivorBrief,
    announce: jt.announce !== false,
  }
}

/** Main hands over the watcher's latest heartbeat; nothing to join = not open. */
export function checkJoinTarget(joinTarget) {
  if (!joinTarget || typeof joinTarget !== 'object' || typeof joinTarget.session !== 'string') {
    return {
      error: 'GAME_WORLD_NOT_OPEN',
      message: "No Don't Starve Together world is open. Host a world in the game and press Play again.",
    }
  }
  return null
}

function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try { resolve(JSON.parse(text)) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body ?? {})
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * The loopback link the mod talks to. Exported for the fake-mod script and
 * the tests; createRuntime wraps it with the brain lifecycle.
 *
 * @typedef {ReturnType<typeof createDstLink>} Link
 */
export function createDstLink({ dst, logger = console, holdMs = null, resultTimeoutMs = CMD_RESULT_TIMEOUT_MS, token = null }) {
  const events = new EventEmitter()
  events.setMaxListeners(50)
  const state = createObservationState()
  const handles = createHandleRegistry()
  const hold = Number.isFinite(holdMs) ? holdMs : (Number.isFinite(dst?.cmd_hold_ms) ? dst.cmd_hold_ms : CMD_HOLD_MS)
  const tok = token ?? randomBytes(18).toString('base64url')

  const queue = []            // pending commands {seq, id, ...}
  const pending = new Map()   // id -> { resolve, timer }
  let seq = 0
  let waiter = null           // { res, timer, since }
  let lastSeenAt = 0
  let contacted = false
  let paused = false
  let closed = false

  const link = {
    events, state, handles,
    get token() { return tok },
    get port() { return server.address()?.port ?? null },
    get botName() { return dst?.username ?? 'Sei' },
    get prefab() { return dst?.prefab ?? 'wilson' },
    get lastSeenAt() { return lastSeenAt },
    get contacted() { return contacted },
    get paused() { return paused },
    session: dst?.session ?? '',
    body: { fight: true, followLabel: dst?.nearName || null },
    playerName: () => dst?.nearName || null,
    send, say, setPaused, listen, close, flushWaiter, queueLength: () => queue.length,
  }

  function drainTo(since) {
    return queue.filter((c) => c.seq > since)
  }

  function flushWaiter() {
    if (!waiter) return
    const w = waiter
    waiter = null
    clearTimeout(w.timer)
    const cmds = drainTo(w.since)
    // Delivered commands leave the queue; the mod acks by advancing `since`.
    for (const c of cmds) {
      const i = queue.indexOf(c)
      if (i >= 0) queue.splice(i, 1)
    }
    sendJson(w.res, 200, { cmds })
  }

  function send(cmd, { signal = null, timeoutMs = null } = {}) {
    if (closed) return Promise.resolve('the game link is closed')
    const id = randomUUID()
    const entry = { ...cmd, id, seq: ++seq }
    return new Promise((resolve) => {
      const done = (text) => {
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        clearTimeout(p.timer)
        try { signal?.removeEventListener?.('abort', onAbort) } catch {}
        resolve(String(text ?? ''))
      }
      const onAbort = () => {
        // Take the body off the job; the mod answers the stop, the result of
        // the cancelled command (if any) is dropped by done() above.
        const i = queue.indexOf(entry)
        if (i >= 0) queue.splice(i, 1)
        else queue.push({ kind: 'stop', id: randomUUID(), seq: ++seq })
        flushWaiter()
        done('cancelled')
      }
      const wait = Number.isFinite(timeoutMs) ? timeoutMs : resultTimeoutMs
      const timer = setTimeout(() => done('timeout: no result from the game'), wait)
      if (typeof timer.unref === 'function') timer.unref()
      pending.set(id, { resolve: done, timer })
      if (signal?.aborted) { onAbort(); return }
      try { signal?.addEventListener?.('abort', onAbort, { once: true }) } catch {}
      queue.push(entry)
      flushWaiter()
    })
  }

  function say(text) {
    const t = String(text ?? '').trim()
    if (!t) return
    void send({ kind: 'say', text: t, announce: dst?.announce !== false }, { timeoutMs: 5_000 })
  }

  function setPaused(p) {
    paused = p === true
    void send({ kind: 'pause', paused }, { timeoutMs: 5_000 })
  }

  function authed(url) {
    return url.searchParams.get('t') === tok
  }

  const server = http.createServer(async (req, res) => {
    let url
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { return sendJson(res, 400, { error: 'bad url' }) }
    if (!authed(url)) return sendJson(res, 401, { error: 'bad token' })
    lastSeenAt = Date.now()
    if (!contacted) { contacted = true; events.emit('contact') }
    try {
      if (req.method === 'GET' && url.pathname === '/cmd') {
        const since = Number(url.searchParams.get('since') ?? 0) || 0
        // Acknowledge everything delivered up to `since`.
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].seq <= since) queue.splice(i, 1)
        if (queue.length > 0 || hold <= 0) {
          const cmds = queue.splice(0, queue.length)
          return sendJson(res, 200, { cmds })
        }
        // Bounded long-poll: one waiter; a newer poll releases the older one.
        if (waiter) flushWaiter()
        const timer = setTimeout(() => flushWaiter(), hold)
        if (typeof timer.unref === 'function') timer.unref()
        waiter = { res, timer, since }
        res.on('close', () => { if (waiter && waiter.res === res) { clearTimeout(waiter.timer); waiter = null } })
        return
      }
      if (req.method === 'POST' && url.pathname === '/obs') {
        const frame = await readJson(req)
        const ok = state.apply(frame)
        if (ok) events.emit('obs', frame)
        return sendJson(res, 200, { full: !state.hasFull })
      }
      if (req.method === 'POST' && url.pathname === '/event') {
        const ev = await readJson(req)
        const kind = typeof ev?.kind === 'string' ? ev.kind : ''
        if (kind === 'result') {
          const p = pending.get(ev.id)
          if (p) p.resolve(ev.text ?? (ev.ok ? 'ok' : 'failed'))
        } else if (kind) {
          events.emit(kind, ev)
        }
        return sendJson(res, 200, {})
      }
      if (req.method === 'POST' && url.pathname === '/error') {
        const ev = await readJson(req)
        logger.warn?.(`[sei/dst] mod error: ${String(ev?.message ?? '').slice(0, 500)}`)
        events.emit('moderror', ev)
        return sendJson(res, 200, {})
      }
      return sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message ?? err) })
    }
  })
  server.keepAliveTimeout = 30_000

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve(server.address().port)
      })
    })
  }

  function close() {
    closed = true
    flushWaiter()
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve('the game link is closed') }
    pending.clear()
    return new Promise((resolve) => {
      try { server.closeAllConnections?.() } catch {}
      server.close(() => resolve())
    })
  }

  return link
}

/**
 * @param {object} config  Parsed bot config (config.adapter.kind === 'dontstarve').
 * @param {import('../../brain/types.js').RuntimeHooks & { postPortMessage?: Function }} hooks
 * @returns {Promise<import('../../brain/types.js').RuntimeHandle>}
 */
export async function createRuntime(config, hooks) {
  const { logger, summonDeadlineAt, createBrain, onBrainReady, onBrainLost, onConnected, onDisconnected, onError, onDashboard, postPortMessage } = hooks
  const dst = config.adapter.dontstarve
  const link = createDstLink({ dst, logger })

  let _brain = null
  let _adapter = null
  let _dash = null
  let _dashWatching = false
  let _stopped = false
  let _readyFired = false
  let _spawned = false
  let _spawnTimer = null
  let _hbTimer = null
  let _deathTimer = null

  const fail = (message) => {
    if (_stopped) return
    _stopped = true
    clearTimers()
    try { onError({ error: classifyConnectError(message), message }) } catch (err) {
      logger.warn(`onError hook threw: ${err && err.message}`)
    }
  }

  function clearTimers() {
    clearTimeout(_spawnTimer); _spawnTimer = null
    clearInterval(_hbTimer); _hbTimer = null
    clearTimeout(_deathTimer); _deathTimer = null
  }

  async function dropBrain() {
    const b = _brain
    _brain = null
    if (b) {
      try { onBrainLost() } catch {}
      try { await b.stop() } catch (err) { logger.warn(`brain stop threw: ${err && err.message}`) }
    }
    try { _adapter?.detach?.() } catch {}
    _adapter = null
    try { _dash?.stop() } catch {}
    _dash = null
  }

  async function bringUp(info) {
    _adapter = createDontStarveAdapter({ link, config })
    if (typeof onDashboard === 'function') {
      _dash = _adapter.createTelemetry({ emit: (s) => onDashboard({ ...s, game: 'dontstarve' }), logger })
      if (_dashWatching) _dash.setWatching(true)
    }
    const brain = await createBrain(_adapter)
    if (_stopped || !_spawned) {
      try { await brain.stop() } catch {}
      return
    }
    _brain = brain
    try { onBrainReady(brain) } catch (err) { logger.warn(`onBrainReady hook threw: ${err && err.message}`) }
    // The wires attached inside createBrain missed the real spawned event;
    // re-emit so the brain runs its spawn path (world identity, greeting).
    link.events.emit('spawned', info)
    if (!_readyFired) {
      _readyFired = true
      try { onConnected() } catch (err) { logger.warn(`onConnected hook threw: ${err && err.message}`) }
    }
  }

  // ── mod events that drive the lifecycle ──────────────────────────────────
  link.events.on('spawned', (info) => {
    if (_spawned || _stopped) return
    _spawned = true
    clearTimeout(_spawnTimer); _spawnTimer = null
    if (typeof info?.session === 'string' && info.session) link.session = info.session
    logger.info(`[sei] DST survivor spawned (${info?.prefab ?? dst.prefab}) as "${info?.name ?? dst.username}"`)
    bringUp(info).catch((err) => {
      logger.error(`[sei] DST bring-up failed: ${err && err.stack || err}`)
      fail(`DST_SPAWN_FAILED: ${err && err.message}`)
    })
    _hbTimer = setInterval(() => {
      if (_stopped) return
      const gap = Date.now() - link.lastSeenAt
      const limit = Number.isFinite(dst.heartbeat_loss_ms) ? dst.heartbeat_loss_ms : HEARTBEAT_LOSS_MS
      if (gap > limit) {
        logger.info(`[sei] DST world stopped answering (${Math.round(gap / 1000)}s) — stopping.`)
        void dropBrain().then(() => {
          try { onDisconnected({ reason: 'heartbeat lost', willRetry: false }) } catch {}
          fail("GAME_WORLD_NOT_OPEN: The Don't Starve Together world closed or stopped answering. Host the world again and press Play.")
        })
      }
    }, 1_000)
    if (typeof _hbTimer.unref === 'function') _hbTimer.unref()
  })
  link.events.on('spawnfailed', (ev) => {
    if (_spawned || _stopped) return
    fail(`DST_SPAWN_FAILED: ${String(ev?.reason ?? 'the mod could not spawn the survivor')}`)
  })
  link.events.on('despawned', () => {
    if (_stopped) return
    logger.info('[sei] DST body despawned by the world.')
    void dropBrain().then(() => {
      try { onDisconnected({ reason: 'despawned', willRetry: false }) } catch {}
      fail("GAME_WORLD_NOT_OPEN: The Don't Starve Together world removed the companion (the world was closed). Host the world again and press Play.")
    })
  })
  link.events.on('death', () => {
    if (_stopped || _deathTimer) return
    // An ownerless survivor has no client to revive it: give the brain one
    // turn to react (the sei:death prompt), then end the session honestly.
    const grace = Number.isFinite(dst.death_grace_ms) ? dst.death_grace_ms : DEATH_GRACE_MS
    _deathTimer = setTimeout(() => {
      _deathTimer = null
      void (async () => {
        await link.send({ kind: 'despawn' }, { timeoutMs: 1_500 })
        await dropBrain()
        try { onDisconnected({ reason: 'died', willRetry: false }) } catch {}
        fail('DST_BODY_DIED: Your companion died in the Constant. Summon them again to bring them back.')
      })()
    }, grace)
  })

  // ── listen + report + spawn deadline ─────────────────────────────────────
  try {
    await link.listen()
  } catch (err) {
    fail(`DST_PORT_IN_USE: could not open a local port for the game link (${err && err.message}).`)
    return makeHandle()
  }
  logger.info(`[sei] DST link listening on 127.0.0.1:${link.port}`)
  try { postPortMessage?.({ type: 'dst-listen', port: link.port, token: link.token }) } catch (err) {
    logger.warn(`postPortMessage threw: ${err && err.message}`)
  }
  const now = Date.now()
  const budget = Number.isFinite(dst.spawn_timeout_ms) ? dst.spawn_timeout_ms : 25_000
  const byDeadline = Number.isFinite(summonDeadlineAt) ? summonDeadlineAt - REPORT_MARGIN_MS - now : Infinity
  const waitMs = Math.max(MIN_SPAWN_WAIT_MS, Math.min(budget, byDeadline))
  _spawnTimer = setTimeout(() => {
    if (_spawned || _stopped) return
    if (!link.contacted) {
      fail("GAME_NOT_ANSWERING: The world is open but Sei's helper mod never contacted Sei. Make sure the helper is installed and enabled (Settings), then host the world again.")
    } else {
      fail('DST_SPAWN_FAILED: the helper mod answered but no survivor appeared in time.')
    }
  }, waitMs)

  function makeHandle() {
    return {
      get adapter() { return _adapter },
      get telemetry() { return _dash },
      async stop() {
        const wasLive = _spawned && !_stopped
        _stopped = true
        clearTimers()
        if (wasLive) {
          const gone = new Promise((r) => {
            const t = setTimeout(r, DESPAWN_WAIT_MS)
            link.events.once('despawned', () => { clearTimeout(t); r() })
          })
          void link.send({ kind: 'despawn' }, { timeoutMs: DESPAWN_WAIT_MS })
          await gone
        }
        await dropBrain()
        await link.close()
        logger.info('Bot stopped.')
      },
      setCompanions(names) {
        const list = Array.isArray(names)
          ? names.filter((n) => typeof n === 'string' && n.trim() && n !== dst.username)
          : []
        try { config._seiCompanions = list } catch {}
        return list
      },
      setDashboardWatch(active) {
        _dashWatching = active === true
        try { _dash?.setWatching(_dashWatching) } catch {}
      },
      /** Test seam: the loopback link (port, token, events). */
      get link() { return link },
    }
  }

  return makeHandle()
}
