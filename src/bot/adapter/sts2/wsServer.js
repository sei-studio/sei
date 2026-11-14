// src/bot/adapter/sts2/wsServer.js: a minimal WebSocket server (RFC 6455) for
// the link to the Sei Slay the Spire 2 mod. Text frames only, no extensions,
// loopback only. The app ships no `ws` package outside the Minecraft pack, and
// the mod's messages are small JSON lines, so a hundred lines of framing beat
// a new dependency.
//
// Security: binds 127.0.0.1 only, and refuses any handshake that carries an
// Origin header, so a web page in the user's browser cannot open the link (a
// game mod never sends Origin). The path must match, and when a token is set
// the query must carry it (`?token=`); the upstream neuro-sts2 mod sends none,
// so a missing token is allowed only when `requireToken` is false.

import http from 'node:http'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

/** One frame header + payload for a server-to-client message (never masked). */
export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8')
  const len = body.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, body])
}

/**
 * Parse as many complete frames as `buf` holds.
 * @returns {{ frames: Array<{fin:boolean, opcode:number, payload:Buffer}>, rest: Buffer, error?: string }}
 */
export function decodeFrames(buf) {
  const frames = []
  let off = 0
  while (buf.length - off >= 2) {
    const b0 = buf[off]
    const b1 = buf[off + 1]
    const fin = (b0 & 0x80) !== 0
    if (b0 & 0x70) return { frames, rest: Buffer.alloc(0), error: 'reserved bits set' }
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = off + 2
    if (len === 126) {
      if (buf.length - p < 2) break
      len = buf.readUInt16BE(p)
      p += 2
    } else if (len === 127) {
      if (buf.length - p < 8) break
      const big = buf.readBigUInt64BE(p)
      if (big > BigInt(MAX_MESSAGE_BYTES)) return { frames, rest: Buffer.alloc(0), error: 'frame too large' }
      len = Number(big)
      p += 8
    }
    if (len > MAX_MESSAGE_BYTES) return { frames, rest: Buffer.alloc(0), error: 'frame too large' }
    // Client frames must be masked (RFC 6455 5.1).
    if (!masked) return { frames, rest: Buffer.alloc(0), error: 'unmasked client frame' }
    if (buf.length - p < 4 + len) break
    const mask = buf.subarray(p, p + 4)
    p += 4
    const payload = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) payload[i] = buf[p + i] ^ mask[i & 3]
    frames.push({ fin, opcode, payload })
    off = p + len
  }
  return { frames, rest: buf.subarray(off) }
}

/** One accepted connection: emits 'message' (string) and 'close'. */
class WsConnection extends EventEmitter {
  constructor(socket, meta) {
    super()
    this.socket = socket
    this.meta = meta
    this.open = true
    this._buf = Buffer.alloc(0)
    this._parts = []
    this._partsLen = 0
    socket.setNoDelay?.(true)
    socket.on('data', (d) => this._onData(d))
    socket.on('close', () => this._closed())
    socket.on('error', () => this._closed())
  }

  _onData(d) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, d]) : d
    const { frames, rest, error } = decodeFrames(this._buf)
    this._buf = rest
    for (const f of frames) this._onFrame(f)
    if (error) this.close(1002, error)
  }

  _onFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) { this.close(1000, ''); return }
    if (opcode === 0x9) { this._write(encodeFrame(0xA, payload)); return }
    if (opcode === 0xA) return
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      this._parts.push(payload)
      this._partsLen += payload.length
      if (this._partsLen > MAX_MESSAGE_BYTES) { this.close(1009, 'message too large'); return }
      if (!fin) return
      const whole = Buffer.concat(this._parts)
      this._parts = []
      this._partsLen = 0
      this.emit('message', whole.toString('utf8'))
    }
  }

  _write(buf) {
    if (!this.open) return false
    try { this.socket.write(buf); return true } catch { return false }
  }

  send(text) { return this._write(encodeFrame(0x1, String(text))) }

  ping() { return this._write(encodeFrame(0x9, Buffer.alloc(0))) }

  close(code = 1000, reason = '') {
    if (!this.open) return
    const r = Buffer.from(String(reason).slice(0, 100), 'utf8')
    const body = Buffer.alloc(2 + r.length)
    body.writeUInt16BE(code, 0)
    r.copy(body, 2)
    this._write(encodeFrame(0x8, body))
    try { this.socket.end() } catch {}
    this._closed()
  }

  _closed() {
    if (!this.open) return
    this.open = false
    try { this.socket.destroy() } catch {}
    this.emit('close')
  }
}

/**
 * @param {{ port: number, host?: string, path?: string, token?: string|null, requireToken?: boolean, logger?: object }} opts
 * @returns {Promise<EventEmitter & { port: number, close(): Promise<void>, connections: Set<WsConnection> }>}
 *   emits 'connection' (conn: WsConnection) where conn.meta = { token: string|null, query }.
 */
export function createWsServer({ port, host = '127.0.0.1', path = '/', token = null, requireToken = false, logger = null } = {}) {
  const emitter = new EventEmitter()
  const connections = new Set()
  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('Sei game link: WebSocket only')
  })
  server.on('upgrade', (req, socket) => {
    const refuse = (status, why) => {
      logger?.warn?.(`[sei/sts2 ws] refused a connection: ${why}`)
      try { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`) } catch {}
    }
    let url
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { return refuse('400 Bad Request', 'bad url') }
    if (req.headers.origin) return refuse('403 Forbidden', 'browser origin')
    if (path && url.pathname !== path) return refuse('404 Not Found', `path ${url.pathname}`)
    const key = req.headers['sec-websocket-key']
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key) return refuse('400 Bad Request', 'not a websocket upgrade')
    const given = url.searchParams.get('token')
    if (token && given != null && given !== token) return refuse('401 Unauthorized', 'wrong token')
    if (token && requireToken && given == null) return refuse('401 Unauthorized', 'missing token')
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const conn = new WsConnection(socket, { token: given, query: Object.fromEntries(url.searchParams) })
    connections.add(conn)
    conn.on('close', () => connections.delete(conn))
    emitter.emit('connection', conn)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      server.on('error', (err) => logger?.warn?.(`[sei/sts2 ws] server error: ${err?.message ?? err}`))
      emitter.port = server.address().port
      emitter.connections = connections
      emitter.close = () => new Promise((r) => {
        for (const c of connections) { try { c.close(1001, 'going away') } catch {} }
        server.close(() => r())
        // Sockets that never finish closing must not hold the stop.
        setTimeout(r, 1500).unref?.()
      })
      resolve(emitter)
    })
  })
}
