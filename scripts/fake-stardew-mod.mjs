#!/usr/bin/env node
// scripts/fake-stardew-mod.mjs — a fake Sei companion mod that speaks
// native/stardew-mod/PROTOCOL.md over plain node:http + a hand-rolled
// WebSocket server (no `ws` dependency), so the Stardew runtime's connect,
// summon-timeout, reconnect and stop paths run in CI without the game.
//
//   node scripts/fake-stardew-mod.mjs [--port 27431] [--token t] [--no-save]
//                                     [--spawn-delay-ms 0] [--spawn-error CODE]
//                                     [--drop-after-ms N]
//
// Also importable: `createFakeMod(opts)` returns { port, url, close(),
// state, dropClients(), sessions }. Every verb answers with a plausible
// detail string after a short delay; `observe` and the 2 Hz `obs` push
// carry the fixture observation.

import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, '..', 'src', 'bot', 'adapter', 'stardew', 'fixtures', 'obs-farm.json')
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function defaultObservation() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'))
}

/** Encode one text frame (server → client frames are unmasked). */
export function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

function encodeCloseFrame(code = 1000) {
  const b = Buffer.alloc(4)
  b[0] = 0x88; b[1] = 2; b.writeUInt16BE(code, 2)
  return b
}

/**
 * Parse as many complete client frames as `buf` holds. Returns
 * { frames: [{opcode, payload}], rest }.
 */
export function decodeFrames(buf) {
  const frames = []
  let off = 0
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = off + 2
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2 }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8 }
    let mask = null
    if (masked) { if (p + 4 > buf.length) break; mask = buf.subarray(p, p + 4); p += 4 }
    if (p + len > buf.length) break
    const payload = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
    frames.push({ opcode, payload, fin })
    off = p + len
  }
  return { frames, rest: buf.subarray(off) }
}

export function createFakeMod(opts = {}) {
  const {
    port = 0,
    token = 'test-token',
    saveLoaded = true,
    farmName = 'Sunny',
    uniqueId = '123456789',
    spawnDelayMs = 0,
    spawnError = null,
    dropAfterMs = 0,
    obsHz = 2,
    commandDelayMs = 30,
    observation = null,
    log = () => {},
  } = opts
  const state = {
    saveLoaded,
    farmName,
    uniqueId,
    day: 3,
    season: 'spring',
    year: 1,
    time: 1330,
    spawnError,
    spawnDelayMs,
    dropAfterMs,
    commandDelayMs,
    bodies: new Map(), // name -> { sessionId }
    frames: [],        // every client frame received (for tests)
    said: [],
  }
  const sessions = new Set()
  const obsBase = observation ?? defaultObservation()

  const save = () => ({
    loaded: state.saveLoaded,
    ...(state.saveLoaded ? { farmName: state.farmName, uniqueId: state.uniqueId, day: state.day, season: state.season, year: state.year, time: state.time, isHost: true, companions: [...state.bodies.keys()] } : {}),
  })
  const hello = () => ({ mod: 'SeiCompanion', version: '0.1.0-fake', protocol: 1, game: '1.6.15', smapi: '4.5.2', port: actualPort(), save: save() })

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/hello') {
      const body = JSON.stringify(hello())
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return }
    const auth = req.headers.authorization
    const presented = url.searchParams.get('token') || (auth?.startsWith('Bearer ') ? auth.slice(7) : '')
    if (presented !== token) {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: 22\r\n\r\n{"error":"unauthorized"}')
      return
    }
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const session = makeSession(socket)
    sessions.add(session)
    socket.on('close', () => { sessions.delete(session); session.close() })
    socket.on('error', () => {})
  })

  function makeSession(socket) {
    const id = randomUUID().replace(/-/g, '')
    let buf = Buffer.alloc(0)
    let body = null
    let obsTimer = null
    let dropTimer = null
    const send = (frame) => {
      if (socket.destroyed) return
      try { socket.write(encodeTextFrame(JSON.stringify(frame) + '\n')) } catch {}
    }
    const result = (reqId, ok, detail, extra = {}) => send({ t: 'result', id: reqId, ok, detail, ...extra })
    const obsFor = () => ({ ...obsBase, name: body?.name ?? obsBase.name })

    send({ t: 'welcome', protocol: 1, session: id, hello: hello() })

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const { frames, rest } = decodeFrames(buf)
      buf = rest
      for (const f of frames) {
        if (f.opcode === 0x8) { socket.end(encodeCloseFrame(1000)); return }
        if (f.opcode === 0x9) { const pong = Buffer.from(f.payload); pong[0] = 0x8a; socket.write(Buffer.concat([Buffer.from([0x8a, f.payload.length]), f.payload])); continue }
        if (f.opcode !== 0x1) continue
        for (const line of f.payload.toString('utf8').split('\n')) {
          const t = line.trim()
          if (!t) continue
          let msg
          try { msg = JSON.parse(t) } catch { send({ t: 'error', message: 'bad json' }); continue }
          state.frames.push(msg)
          handle(msg)
        }
      }
    })

    function handle(msg) {
      const reqId = msg.id ?? null
      switch (msg.t) {
        case 'ping':
          result(reqId, true, 'pong', { save: save() })
          return
        case 'spawn': {
          const name = String(msg.name ?? 'Sei')
          const run = () => {
            if (!state.saveLoaded) { result(reqId, false, 'no save is loaded; load your farm first', { error: 'NO_SAVE' }); return }
            if (state.spawnError) { result(reqId, false, `refused: ${state.spawnError}`, { error: state.spawnError }); return }
            if (body) { result(reqId, true, `spawned as ${body.name} in Farm`, { name: body.name, location: 'Farm', x: 62, y: 18 }); return }
            const existing = state.bodies.get(name)
            if (existing && existing.sessionId !== id && sessions.has(existing.session) && !existing.session.closed) {
              result(reqId, false, 'a companion with that name is already in the world', { error: 'NAME_TAKEN' })
              return
            }
            // 260921: the optional farmer look. The real mod clamps every
            // field against the game; the fake only remembers what it got.
            const appearance = msg.appearance && typeof msg.appearance === 'object' ? msg.appearance : null
            body = { name, sessionId: id, session: sessionRef, closed: false, appearance }
            state.bodies.set(name, body)
            result(reqId, true, `spawned as ${name} in Farm`, { name, location: 'Farm', x: 62, y: 18 })
            send({ t: 'spawned', name, location: 'Farm', x: 62, y: 18 })
            if (obsHz > 0) {
              obsTimer = setInterval(() => send({ t: 'obs', obs: obsFor() }), Math.round(1000 / obsHz))
              obsTimer.unref?.()
            }
            if (state.dropAfterMs > 0) {
              dropTimer = setTimeout(() => { try { socket.destroy() } catch {} }, state.dropAfterMs)
              dropTimer.unref?.()
            }
          }
          if (state.spawnDelayMs > 0) setTimeout(run, state.spawnDelayMs).unref?.()
          else run()
          return
        }
        case 'despawn':
          removeBody('bot asked')
          result(reqId, true, 'despawned')
          return
        case 'observe':
          if (!body) { result(reqId, false, 'not spawned'); return }
          result(reqId, true, 'ok', { obs: obsFor() })
          return
        case 'say':
          if (!body) { result(reqId, false, 'not spawned'); return }
          state.said.push(String(msg.text ?? ''))
          result(reqId, true, 'said')
          return
        case 'pause':
          if (!body) { result(reqId, false, 'not spawned'); return }
          state.paused = msg.paused === true
          result(reqId, true, state.paused ? 'paused' : 'resumed')
          return
        case 'cancel':
          if (running && (!msg.target || running.id === msg.target)) {
            clearTimeout(running.timer)
            result(running.id, false, 'aborted')
            running = null
          }
          result(reqId, true, 'cancelled')
          return
        case 'cmd': {
          if (!body) { result(reqId, false, 'not spawned'); return }
          const name = String(msg.name ?? '')
          const args = msg.args ?? {}
          if (running) {
            clearTimeout(running.timer)
            result(running.id, false, 'aborted: superseded by a new command')
            running = null
          }
          const detail = fakeDetail(name, args)
          if (detail == null) { result(reqId, false, `unknown action ${name}`); return }
          const delay = name === 'gather' ? state.commandDelayMs * 4 : state.commandDelayMs
          running = { id: reqId, timer: setTimeout(() => { running = null; result(reqId, !detail.startsWith('!'), detail.replace(/^!/, '')) }, delay) }
          running.timer.unref?.()
          if (name === 'gather') send({ t: 'progress', id: reqId, text: `gathering ${args.kind ?? 'things'}: 1/${args.count ?? 5}` })
          return
        }
        case 'devAppearance':
          // Mirrors the real developer frame's shape (DevCommands.Appearance).
          if (!body) { result(reqId, false, 'not spawned'); return }
          result(reqId, true, 'ok', { appearance: { custom: !!body.appearance, requested: body.appearance, applied: body.appearance } })
          return
        default:
          result(reqId, false, `unknown message type ${msg.t}`)
      }
    }
    let running = null

    function removeBody(reason) {
      if (!body) return
      state.bodies.delete(body.name)
      body.closed = true
      body = null
      clearInterval(obsTimer); obsTimer = null
      send({ t: 'despawned', reason })
    }

    const sessionRef = {
      id,
      get closed() { return socket.destroyed },
      close() {
        clearInterval(obsTimer); obsTimer = null
        clearTimeout(dropTimer)
        if (body) { body.closed = true; state.bodies.delete(body.name); body = null }
      },
      pushEvent(frame) { send(frame) },
      destroy() { try { socket.destroy() } catch {} },
    }
    return sessionRef
  }

  function fakeDetail(name, args) {
    switch (name) {
      case 'goTo': return args.location ? `arrived in ${args.location} at (10,10)` : `at (${args.x ?? 0},${args.y ?? 0})`
      case 'come': return 'next to Ouen'
      case 'follow': return `following ${args.player ?? 'Ouen'}`
      case 'unfollow': return 'stopped following'
      case 'till': return `tilled (${args.x},${args.y})`
      case 'water': return args.x != null ? `watered (${args.x},${args.y})` : 'watered 12 crops (18/40 left in the can)'
      case 'plant': return `planted 1 ${args.seed ?? 'seeds'}`
      case 'harvest': return 'harvested 3 crops: Parsnip'
      case 'chop': return 'chopped (70,12) and picked up 8 items (wood/sap)'
      case 'mine': return 'broke the rock at (66,19) and picked up 2 items'
      case 'gather': return `gathered ${args.count ?? 5} items of ${args.kind ?? 'forage'}`
      case 'attack': return 'Green Slime is down after 3 hits'
      case 'fish': return 'caught Sunfish'
      case 'eat': return 'ate Leek (+40 energy, +18 health)'
      case 'equip': return `holding ${args.item}`
      case 'place': return `placed ${args.item} at (${args.x},${args.y})`
      case 'chest': return args.action === 'take' ? `took 5 ${args.item ?? 'Wood'} from the chest at (64,14)` : `put 5 ${args.item ?? 'Wood'} in the chest at (64,14)`
      case 'buy': return `bought ${args.qty ?? 1} ${args.item} for 20g (480g left)`
      case 'interact': return 'went through to BusStop'
      case 'sleep': return 'in bed at the farmhouse. The day only ends when the player goes to bed too'
      default: return null
    }
  }

  let actualPort = () => port
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    // No host: bind every family so a client dialing `localhost` (::1 on a
    // dual-stack box, 127.0.0.1 elsewhere) reaches it, like the real mod.
    server.listen(port, () => {
      const p = server.address().port
      actualPort = () => p
      resolve(p)
    })
  })

  return {
    ready,
    get port() { return actualPort() },
    get url() { return `http://127.0.0.1:${actualPort()}` },
    state,
    sessions,
    /** Kill every open socket (simulates the game crashing). */
    dropClients() { for (const s of [...sessions]) s.destroy() },
    /** Push an event frame to every open session. */
    broadcast(frame) { for (const s of sessions) s.pushEvent(frame) },
    async close() {
      for (const s of [...sessions]) s.destroy()
      await new Promise((r) => server.close(() => r()))
    },
  }
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
  const mod = createFakeMod({
    port: Number(opt('--port', 27431)),
    token: opt('--token', 'test-token'),
    saveLoaded: !args.includes('--no-save'),
    spawnDelayMs: Number(opt('--spawn-delay-ms', 0)),
    spawnError: opt('--spawn-error', null),
    dropAfterMs: Number(opt('--drop-after-ms', 0)),
    log: console.log,
  })
  mod.ready.then((p) => console.log(`[fake-stardew-mod] listening on http://127.0.0.1:${p}/ (token ${opt('--token', 'test-token')})`))
}
