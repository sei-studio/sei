#!/usr/bin/env node
// scripts/fake-terraria-mod.mjs — a fake Sei companion tModLoader mod that
// speaks native/terraria-mod/PROTOCOL.md (the Stardew transport: /hello +
// a token-gated NDJSON WebSocket), so the Terraria runtime's connect, spawn,
// reconnect and stop paths run in CI without the game. The frame codec is
// shared with scripts/fake-stardew-mod.mjs.
//
//   node scripts/fake-terraria-mod.mjs [--port 27460] [--token t] [--no-world]
//                                      [--spawn-error CODE] [--role single|server|client]
//
// Importable: `createFakeTerrariaMod(opts)` returns { ready, port, state,
// sessions, dropClients(), broadcast(frame), close() }.

import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeTextFrame, decodeFrames } from './fake-stardew-mod.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, '..', 'src', 'bot', 'adapter', 'terraria', 'fixtures', 'obs-surface.json')
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function defaultTerrariaObservation() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'))
}

/** A plausible `detail` per verb; a leading '!' marks a failure. */
function fakeDetail(name, args) {
  switch (name) {
    case 'follow': return `following ${args.player ?? 'Ouen'}`
    case 'unfollow': return 'stopped following; staying here'
    case 'come': return `next to ${args.player ?? 'Ouen'}`
    case 'goTo': return args.target ? `next to Blue Slime ${args.target}` : `at (${args.x ?? 0},${args.y ?? 0})`
    case 'stance': return `stance ${args.mode}`
    case 'attack': return 'defeated Blue Slime'
    case 'give': return `gave ${args.item}${args.count > 1 ? ` x${args.count}` : ''} to ${args.player ?? 'Ouen'}`
    case 'take': return 'picked up Gel x3'
    case 'mine': return `mined ${args.count ?? 5}/${args.count ?? 5}: got ${args.block ?? 'Dirt Block'} x${args.count ?? 5}`
    case 'place': return `placed ${args.item} at (${args.x},${args.y})`
    case 'chop': return 'chopped 1/1: got Wood x9, Acorn x1'
    case 'use': return 'drank Lesser Healing Potion (+50 health)'
    case 'equip': return `equipped ${args.item}`
    case 'craft': return args.item === 'Nope' ? `!cannot craft Nope: missing Wood x10` : `crafted ${args.item}`
    default: return null
  }
}

export function createFakeTerrariaMod(opts = {}) {
  const {
    port = 0,
    token = 'test-token',
    worldLoaded = true,
    role = 'single',
    spawnError = null,
    obsHz = 2,
    commandDelayMs = 30,
    observation = null,
  } = opts
  const state = {
    worldLoaded,
    role,
    spawnError,
    commandDelayMs,
    bodies: new Map(),
    frames: [],
    said: [],
    paused: false,
  }
  const sessions = new Set()
  const obsBase = observation ?? defaultTerrariaObservation()

  const world = () => ({
    loaded: state.worldLoaded,
    ...(state.worldLoaded ? { name: 'SeiSpike', uniqueId: 'd8967c12-0000-4121-bda2-207c9a551c95', worldId: 1590924033, hardmode: false, players: ['Ouen'], companions: [...state.bodies.keys()] } : {}),
  })
  let actualPort = () => port
  const hello = () => ({ mod: 'SeiCompanion', version: '0.1.0-fake', protocol: 1, game: 'terraria', terraria: 'v1.4.4.9', tml: '2026.9.3.1', port: actualPort(), role: state.role, world: world(), pid: process.pid })

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
    if (url.searchParams.get('token') !== token) {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: 24\r\n\r\n{"error":"unauthorized"}')
      return
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + WS_MAGIC).digest('base64')
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
    let running = null
    const send = (frame) => {
      if (socket.destroyed) return
      try { socket.write(encodeTextFrame(JSON.stringify(frame) + '\n')) } catch {}
    }
    const result = (reqId, ok, detail, extra = {}) => send({ t: 'result', id: reqId, ok, detail, ...extra })
    const obsFor = () => ({ ...obsBase, self: { ...obsBase.self, name: body?.name ?? obsBase.self.name, paused: state.paused } })

    send({ t: 'welcome', protocol: 1, session: id, hello: hello() })

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const { frames, rest } = decodeFrames(buf)
      buf = rest
      for (const f of frames) {
        if (f.opcode === 0x8) { socket.end(); return }
        if (f.opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, f.payload.length]), f.payload])); continue }
        if (f.opcode !== 0x1) continue
        for (const line of f.payload.toString('utf8').split('\n')) {
          const t = line.trim()
          if (!t) continue
          let msg
          try { msg = JSON.parse(t) } catch { continue }
          state.frames.push(msg)
          handle(msg)
        }
      }
    })

    function handle(msg) {
      const reqId = msg.id ?? null
      switch (msg.t) {
        case 'ping': result(reqId, true, 'pong'); return
        case 'spawn': {
          const name = String(msg.name ?? 'Sei')
          if (!state.worldLoaded) { result(reqId, false, 'no world is loaded', { error: 'NO_WORLD' }); return }
          if (state.role === 'client') { result(reqId, false, 'joined someone else\'s server', { error: 'NOT_HOST' }); return }
          if (state.spawnError) { result(reqId, false, `refused: ${state.spawnError}`, { error: state.spawnError }); return }
          body = { name, appearance: msg.appearance ?? null, owner: msg.owner ?? null }
          state.bodies.set(name, body)
          result(reqId, true, `spawned as ${name}`, { name, npc: 7, x: 2092, y: 208, hp: 100, maxHp: 100, role: state.role })
          send({ t: 'spawned', name, x: 2092, y: 208 })
          if (obsHz > 0) {
            obsTimer = setInterval(() => send({ t: 'obs', obs: obsFor() }), Math.round(1000 / obsHz))
            obsTimer.unref?.()
          }
          return
        }
        case 'despawn':
          if (body) { state.bodies.delete(body.name); body = null; clearInterval(obsTimer); send({ t: 'despawned', reason: 'bot asked' }) }
          result(reqId, true, 'despawned')
          return
        case 'observe':
          if (!body) { result(reqId, false, 'not spawned'); return }
          result(reqId, true, 'ok', { obs: obsFor() })
          return
        case 'say':
          state.said.push(String(msg.text ?? ''))
          result(reqId, true, 'said')
          return
        case 'pause':
          state.paused = msg.paused === true
          result(reqId, true, state.paused ? 'paused' : 'resumed')
          return
        case 'cancel':
          if (running) { clearTimeout(running.timer); result(running.id, false, 'aborted'); running = null }
          result(reqId, true, 'cancelled')
          return
        case 'cmd': {
          if (!body) { result(reqId, false, 'not spawned'); return }
          const name = String(msg.name ?? '')
          const args = msg.args ?? {}
          if (running) { clearTimeout(running.timer); result(running.id, false, 'aborted: superseded by a new command'); running = null }
          const detail = fakeDetail(name, args)
          if (detail == null) { result(reqId, false, `unknown verb ${name}`); return }
          if (name === 'mine' || name === 'chop') send({ t: 'progress', id: reqId, text: `${name === 'mine' ? 'mined' : 'chopped'} 1/${args.count ?? 5}` })
          running = { id: reqId, timer: setTimeout(() => { running = null; result(reqId, !detail.startsWith('!'), detail.replace(/^!/, '')) }, state.commandDelayMs) }
          running.timer.unref?.()
          return
        }
        default:
          result(reqId, false, `unknown message type ${msg.t}`)
      }
    }

    return {
      id,
      close() { clearInterval(obsTimer); if (body) { state.bodies.delete(body.name); body = null } },
      pushEvent(frame) { send(frame) },
      destroy() { try { socket.destroy() } catch {} },
    }
  }

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      const p = server.address().port
      actualPort = () => p
      resolve(p)
    })
  })

  return {
    ready,
    get port() { return actualPort() },
    state,
    sessions,
    dropClients() { for (const s of [...sessions]) s.destroy() },
    broadcast(frame) { for (const s of sessions) s.pushEvent(frame) },
    async close() {
      for (const s of [...sessions]) s.destroy()
      await new Promise((r) => server.close(() => r()))
    },
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
  const mod = createFakeTerrariaMod({
    port: Number(opt('--port', 27460)),
    token: opt('--token', 'test-token'),
    worldLoaded: !args.includes('--no-world'),
    role: opt('--role', 'single'),
    spawnError: opt('--spawn-error', null),
  })
  mod.ready.then((p) => console.log(`[fake-terraria-mod] listening on http://127.0.0.1:${p}/`))
}
