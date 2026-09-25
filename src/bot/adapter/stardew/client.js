// src/bot/adapter/stardew/client.js — the WebSocket client for the Sei
// companion mod (native/stardew-mod/PROTOCOL.md). Node 22's built-in
// WebSocket global; no `ws` package, so the Stardew pack carries no
// node_modules at all.
//
// One instance per connection attempt. Frames are NDJSON text; every request
// carries an id and resolves on the matching `result`; everything else is
// re-emitted as an event named by its `t`.

import { EventEmitter } from 'node:events'

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
/** A verb can run a long time (a 40-swing gather); the mod always answers
 *  eventually, and the brain's own abort cancels sooner. */
export const COMMAND_TIMEOUT_MS = 180_000
/** water / harvest scope "farm" (mod 0.1.3) can cover 200 crops with refills:
 *  a hard cap well past that, plus a no-progress timeout (each crop reports). */
export const FARM_COMMAND_TIMEOUT_MS = 15 * 60_000
export const FARM_COMMAND_IDLE_TIMEOUT_MS = 240_000

/** The timeouts for one `cmd` frame: `{timeoutMs, idleTimeoutMs?}`. */
export function commandTimeouts(name, args) {
  if ((name === 'water' || name === 'harvest') && args?.scope === 'farm') {
    return { timeoutMs: FARM_COMMAND_TIMEOUT_MS, idleTimeoutMs: FARM_COMMAND_IDLE_TIMEOUT_MS }
  }
  return { timeoutMs: COMMAND_TIMEOUT_MS }
}

let _seq = 0
export function nextId() {
  _seq += 1
  return `c${Date.now().toString(36)}-${_seq}`
}

/**
 * @param {{ port: number, token: string, host?: string, logger?: object, WebSocketImpl?: any }} opts
 */
export function createStardewClient({ port, token, host = 'localhost', logger = console, WebSocketImpl = null }) {
  const WS = WebSocketImpl ?? globalThis.WebSocket
  if (typeof WS !== 'function') throw new Error('WebSocket is not available in this Node runtime')
  const url = `ws://${host}:${port}/ws?token=${encodeURIComponent(token ?? '')}`
  const emitter = new EventEmitter()
  emitter.setMaxListeners(50)
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map()
  let socket = null
  let state = 'idle' // idle | connecting | open | closed
  let closeInfo = null
  let welcome = null

  function settleAll(err) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
      pending.delete(id)
    }
  }

  function handleLine(line) {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    if (!frame || typeof frame !== 'object') return
    if (frame.t === 'result' && frame.id != null) {
      const p = pending.get(String(frame.id))
      if (p) {
        clearTimeout(p.timer)
        pending.delete(String(frame.id))
        p.resolve(frame)
      }
      emitter.emit('result', frame)
      return
    }
    // A running command's progress keeps its no-progress timer alive.
    if (frame.t === 'progress' && frame.id != null) pending.get(String(frame.id))?.onProgress?.()
    if (frame.t === 'welcome') welcome = frame
    emitter.emit(frame.t, frame)
    emitter.emit('frame', frame)
  }

  function connect({ timeoutMs = 10_000 } = {}) {
    if (state !== 'idle') return Promise.reject(new Error('client already used'))
    state = 'connecting'
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        try { socket?.close() } catch {}
        state = 'closed'
        reject(new Error(`connect timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      try {
        socket = new WS(url)
      } catch (err) {
        clearTimeout(timer)
        state = 'closed'
        reject(err)
        return
      }
      socket.addEventListener('open', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        state = 'open'
        resolve()
      })
      socket.addEventListener('message', (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '')
        for (const line of text.split('\n')) {
          const t = line.trim()
          if (t) handleLine(t)
        }
      })
      socket.addEventListener('error', (ev) => {
        const message = ev?.message || ev?.error?.message || 'websocket error'
        closeInfo = closeInfo ?? { code: 0, reason: message }
        if (!done) {
          done = true
          clearTimeout(timer)
          state = 'closed'
          reject(new Error(message))
        }
        emitter.emit('socket-error', new Error(message))
      })
      socket.addEventListener('close', (ev) => {
        const wasOpen = state === 'open'
        state = 'closed'
        closeInfo = { code: ev?.code ?? 0, reason: ev?.reason || closeInfo?.reason || '' }
        settleAll(new Error(`connection closed (${closeInfo.code}${closeInfo.reason ? ` ${closeInfo.reason}` : ''})`))
        if (!done) {
          done = true
          clearTimeout(timer)
          reject(new Error(`connection closed before open (${closeInfo.code}${closeInfo.reason ? ` ${closeInfo.reason}` : ''})`))
        }
        emitter.emit('close', { ...closeInfo, wasOpen })
      })
    })
  }

  function send(frame) {
    if (state !== 'open' || !socket) throw new Error('not connected')
    socket.send(JSON.stringify(frame) + '\n')
  }

  /**
   * Send a frame that expects a `result`. Resolves with the raw result frame
   * (never rejects on ok:false — the caller reads `detail`).
   *
   * `timeoutMs` is a hard cap; `idleTimeoutMs` (optional) is the longest gap
   * between the command's `progress` frames. A `cmd` that times out either
   * way is CANCELLED in the mod too, so the body does not keep working on a
   * command the brain has already written off.
   */
  function request(frame, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, idleTimeoutMs = null, signal = null } = {}) {
    const id = frame.id ?? nextId()
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return }
      let idleTimer = null
      const cleanup = () => {
        clearTimeout(timer)
        if (idleTimer) clearTimeout(idleTimer)
        pending.delete(id)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      const cancelInMod = () => {
        if (frame.t !== 'cmd') return
        try { send({ id: nextId(), t: 'cancel', target: id }) } catch {}
      }
      const fail = (message) => {
        if (!pending.has(id)) return
        cleanup()
        cancelInMod()
        reject(new Error(message))
      }
      const label = `${frame.t}${frame.name ? ` ${frame.name}` : ''}`
      const timer = setTimeout(() => fail(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
      const armIdle = () => {
        if (!idleTimeoutMs) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => fail(`${label} made no progress for ${Math.round(idleTimeoutMs / 1000)}s`), idleTimeoutMs)
      }
      function onAbort() {
        if (!pending.has(id)) return
        cleanup()
        try { send({ id: nextId(), t: 'cancel', target: id }) } catch {}
        reject(new Error('aborted'))
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve: (r) => { cleanup(); resolve(r) },
        reject: (e) => { cleanup(); reject(e) },
        onProgress: armIdle,
        timer,
      })
      armIdle()
      try {
        send({ ...frame, id })
      } catch (err) {
        cleanup()
        reject(err)
      }
    })
  }

  function close(reason = 'closing') {
    if (socket && state !== 'closed') {
      try { socket.close(1000, reason.slice(0, 120)) } catch {}
    }
    state = 'closed'
  }

  return {
    url,
    connect,
    request,
    send,
    close,
    on: (...a) => emitter.on(...a),
    once: (...a) => emitter.once(...a),
    off: (...a) => emitter.off(...a),
    get state() { return state },
    get isOpen() { return state === 'open' },
    get closeInfo() { return closeInfo },
    get welcome() { return welcome },
  }
}

/**
 * Liveness probe against the mod's unauthenticated hello (the runtime's
 * "is the world still open" check after a drop). Resolves the hello JSON or
 * throws.
 */
export async function fetchHello({ port, host = 'localhost', timeoutMs = 1500, fetchImpl = null }) {
  const f = fetchImpl ?? globalThis.fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await f(`http://${host}:${port}/hello`, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`hello responded ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}
