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
   */
  function request(frame, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal = null } = {}) {
    const id = frame.id ?? nextId()
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return }
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${frame.t}${frame.name ? ` ${frame.name}` : ''} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      const onAbort = () => {
        clearTimeout(timer)
        pending.delete(id)
        try { send({ id: nextId(), t: 'cancel', target: id }) } catch {}
        reject(new Error('aborted'))
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve: (r) => { if (signal) signal.removeEventListener('abort', onAbort); resolve(r) },
        reject: (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(e) },
        timer,
      })
      try {
        send({ ...frame, id })
      } catch (err) {
        clearTimeout(timer)
        pending.delete(id)
        if (signal) signal.removeEventListener('abort', onAbort)
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
