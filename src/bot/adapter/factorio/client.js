// src/bot/adapter/factorio/client.js — the localhost UDP client for the Sei
// Companion Factorio mod (native/factorio-mod/PROTOCOL.md).
//
// Factorio started with --enable-lua-udp=<gamePort> opens 127.0.0.1:<gamePort>.
// We bind our own ephemeral port (it must differ from the game's) and send
// framed JSON requests there; the mod reads them once per game tick and
// replies to our source port. UDP can drop a datagram, so a request is resent
// with the SAME id until its reply arrives; the mod answers a repeated id from
// its reply cache, so an action never runs twice.
//
// Long verbs answer `{started:true}` at once and finish later as a `result`
// event in the companion's feed, which we read by polling with a cursor
// (`since`). A lost poll reply is re-delivered by the next poll.
//
// Framing, both directions: "SEI1 <id> <part> <parts>\n<json chunk>".

import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'

export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000
export const RESEND_MS = 400
export const POLL_MS = 300
/** The longest a job verb may run before we give up on it (the mod has its own deadlines, 5 to 15 minutes). */
export const JOB_TIMEOUT_MS = 16 * 60_000
const CHUNK = 60_000
const MAX_PARTS = 32

let _seq = 0
export function nextId() {
  _seq += 1
  return `${Date.now().toString(36)}${_seq.toString(36)}`
}

/** Frame one body into datagrams. */
export function frames(id, body) {
  const buf = Buffer.from(body, 'utf8')
  const parts = []
  let i = 0
  do {
    let end = Math.min(buf.length, i + CHUNK)
    // never split a UTF-8 sequence
    while (end < buf.length && end > i && (buf[end] & 0xc0) === 0x80) end -= 1
    parts.push(buf.subarray(i, end))
    i = end
  } while (i < buf.length)
  return parts.map((p, n) => Buffer.concat([Buffer.from(`SEI1 ${id} ${n + 1} ${parts.length}\n`), p]))
}

/** Parse one datagram: {id, part, parts, body} or null. */
export function parseFrame(msg) {
  const nl = msg.indexOf(0x0a)
  if (nl < 0 || nl > 80) return null
  const head = msg.subarray(0, nl).toString('latin1')
  const m = /^SEI1 ([\w-]+) (\d+) (\d+)$/.exec(head)
  if (!m) return null
  const part = Number(m[2])
  const parts = Number(m[3])
  if (parts < 1 || parts > MAX_PARTS || part < 1 || part > parts) return null
  return { id: m[1], part, parts, body: msg.subarray(nl + 1) }
}

/**
 * @param {{ gamePort: number, host?: string, logger?: object, dgramImpl?: any }} opts
 */
export function createFactorioClient({ gamePort, host = '127.0.0.1', logger = console, dgramImpl = null }) {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(50)
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any, resend: any}>} */
  const pending = new Map()
  /** @type {Map<string, {parts: Buffer[], got: number}>} */
  const partial = new Map()
  /** job id -> waiter for its `result` event */
  const jobs = new Map()
  let socket = null
  let state = 'idle' // idle | open | closed
  let pollTimer = null
  let pollInFlight = false
  let cursor = 0
  let lastReplyAt = 0
  let lastRefusedAt = 0

  function onMessage(msg) {
    const f = parseFrame(msg)
    if (!f) return
    let body = f.body
    if (f.parts > 1) {
      const p = partial.get(f.id) ?? { parts: [], got: 0 }
      if (!p.parts[f.part - 1]) { p.parts[f.part - 1] = f.body; p.got += 1 }
      partial.set(f.id, p)
      if (p.got < f.parts) return
      partial.delete(f.id)
      body = Buffer.concat(p.parts)
    }
    const waiter = pending.get(f.id)
    if (!waiter) return
    let reply
    try { reply = JSON.parse(body.toString('utf8')) } catch { reply = { ok: false, error: 'bad reply json' } }
    lastReplyAt = Date.now()
    waiter.resolve(reply)
  }

  function open() {
    if (state !== 'idle') return Promise.reject(new Error('client already used'))
    const d = dgramImpl ?? dgram
    socket = d.createSocket('udp4')
    return new Promise((resolve, reject) => {
      socket.once('error', (err) => { state = 'closed'; reject(err) })
      socket.on('message', onMessage)
      socket.bind(0, host, () => {
        // Connected, so the OS reports a closed game port (ICMP unreachable)
        // as ECONNREFUSED (ECONNRESET on Windows): the game has quit. A
        // paused game keeps its socket and just stops answering.
        socket.connect(gamePort, host, () => {
          state = 'open'
          socket.removeAllListeners('error')
          socket.on('error', (err) => {
            if (err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET') {
              lastRefusedAt = Date.now()
              emitter.emit('unreachable', err)
              return
            }
            emitter.emit('socket-error', err)
          })
          resolve(socket.address().port)
        })
      })
    })
  }

  function sendRaw(id, body) {
    for (const dg of frames(id, body)) socket.send(dg)
  }

  /**
   * One request. Resolves the reply object (never rejects on ok:false). Resent
   * every RESEND_MS with the same id until answered or timed out.
   */
  function request(req, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal = null } = {}) {
    if (state !== 'open') return Promise.reject(new Error('not connected'))
    const id = nextId()
    const body = JSON.stringify(req)
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return }
      const cleanup = () => {
        clearTimeout(timer)
        clearInterval(resend)
        pending.delete(id)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      function onAbort() { cleanup(); reject(new Error('aborted')) }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`${req.op}${req.verb ? ` ${req.verb}` : ''} got no answer from Factorio in ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      const resend = setInterval(() => { try { sendRaw(id, body) } catch {} }, RESEND_MS)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      pending.set(id, { resolve: (r) => { cleanup(); resolve({ ...r, _id: id }) }, reject, timer, resend })
      try { sendRaw(id, body) } catch (err) { cleanup(); reject(err) }
    })
  }

  // A job that ends within a tick can have its result polled before command()
  // has registered its waiter; keep such results for a short while.
  const earlyResults = new Map()
  function rememberEarly(id, ev) {
    const now = Date.now()
    for (const [k, v] of earlyResults) if (now - v.at > 30_000) earlyResults.delete(k)
    if (earlyResults.size < 32) earlyResults.set(id, { ev, at: now })
  }

  // ---------------------------------------------------------------- feed
  function startPolling(cid, { intervalMs = POLL_MS, since = 0 } = {}) {
    stopPolling()
    cursor = since
    const tick = async () => {
      if (pollInFlight || state !== 'open') return
      pollInFlight = true
      try {
        const r = await request({ op: 'poll', cid, since: cursor }, { timeoutMs: 4_000 })
        if (!r.ok) { emitter.emit('poll-error', new Error(r.error || 'poll failed')); return }
        for (const ev of r.ev ?? []) {
          if (typeof ev.seq === 'number' && ev.seq <= cursor) continue
          if (typeof ev.seq === 'number') cursor = ev.seq
          if (ev.t === 'result' && ev.id != null) {
            const w = jobs.get(String(ev.id))
            if (w) { jobs.delete(String(ev.id)); w(ev) }
            else rememberEarly(String(ev.id), ev)
          }
          emitter.emit('event', ev)
          emitter.emit(ev.t, ev)
        }
        // The game lost our companion's feed (a reloaded save): resync the cursor.
        if (typeof r.seq === 'number' && r.seq < cursor) cursor = r.seq
        emitter.emit('alive', r.alive)
      } catch (err) {
        emitter.emit('poll-error', err)
      } finally {
        pollInFlight = false
      }
    }
    pollTimer = setInterval(tick, intervalMs)
    void tick()
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  /**
   * Run one verb to completion. Instant verbs answer in the reply; job verbs
   * answer {started} and finish with a `result` event. Resolves
   * {success, msg}. Aborting cancels the job in the mod.
   */
  async function command(cid, verb, args = {}, { signal = null, timeoutMs = JOB_TIMEOUT_MS } = {}) {
    let r
    try {
      r = await request({ op: 'cmd', cid, verb, args }, { signal })
    } catch (err) {
      // Aborted before the reply landed: the mod may already have started
      // the job, so cancel it anyway (a no-op when nothing runs).
      if (signal?.aborted) void request({ op: 'cancel', cid, reason: 'stopped by the app' }).catch(() => {})
      throw err
    }
    if (!r.ok) return { success: false, msg: r.error || 'the game refused that' }
    if (r.done) return { success: !!r.success, msg: r.msg ?? '' }
    const jobId = String(r.id ?? r._id)
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        jobs.delete(jobId)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      const cancel = (reason) => { void request({ op: 'cancel', cid, reason }).catch(() => {}) }
      function onAbort() { cleanup(); cancel('stopped by the app'); reject(new Error('aborted')) }
      const timer = setTimeout(() => { cleanup(); cancel('timed out'); resolve({ success: false, msg: `${verb} ran too long and was stopped` }) }, timeoutMs)
      if (signal) {
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const finish = (ev) => { cleanup(); resolve({ success: !!ev.ok, msg: ev.detail ?? '' }) }
      const early = earlyResults.get(jobId)
      if (early) { earlyResults.delete(jobId); finish(early.ev); return }
      jobs.set(jobId, finish)
    })
  }

  function close() {
    stopPolling()
    for (const [, p] of pending) { clearTimeout(p.timer); clearInterval(p.resend); p.reject(new Error('closed')) }
    pending.clear()
    for (const [, w] of jobs) w({ ok: false, detail: 'the connection closed' })
    jobs.clear()
    if (socket && state !== 'closed') { try { socket.close() } catch {} }
    state = 'closed'
  }

  return {
    open,
    request,
    command,
    startPolling,
    stopPolling,
    close,
    on: (...a) => emitter.on(...a),
    once: (...a) => emitter.once(...a),
    off: (...a) => emitter.off(...a),
    get state() { return state },
    get cursor() { return cursor },
    get lastReplyAt() { return lastReplyAt },
    /** When the OS last said nothing listens on the game port (0 = never). */
    get lastRefusedAt() { return lastRefusedAt },
    get localPort() { return socket && state === 'open' ? socket.address().port : null },
  }
}
