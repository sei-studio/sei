// src/bot/adapter/minecraft/lanDiscovery.js
//
// One-shot LAN discovery used by the CLI (src/bot/cli/index.js cmdStart) and
// the CLI bot bootstrap path in src/bot/index.js (when process.parentPort is
// undefined). The Electron main process uses src/main/lanWatcher.ts (a
// long-lived watcher); the bot child does NOT call discoverLanPort during
// summon — main hands the cached port over MessagePort (CONTEXT D-25,
// Pitfall 6). A small dedicated implementation here keeps the bot adapter from
// importing the main-process module tree (it mirrors src/main/mcPing.ts +
// src/main/listeningPorts.ts).
//
// Loopback edition: dropped Minecraft's multicast beacon (224.0.2.60:4445)
// because macOS 26 silently drops custom multicast for signed apps without the
// restricted multicast entitlement (which bricks launch). Instead we enumerate
// local listening TCP ports and Minecraft-status-ping them over loopback — Sei
// is same-machine only, so 127.0.0.1 is all we ever need, and loopback is
// exempt from Local Network privacy. The LAN port is random per session; the
// live socket table gives us the current one directly.

import net from 'node:net'
import { execFile } from 'node:child_process'

// ---- listening-port enumeration (lsof on mac/linux, netstat on win) ---------

function runTool(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) reject(err)
      else resolve(stdout ?? '')
    })
  })
}

function parseLsof(out) {
  const ports = new Map()
  for (const line of out.split('\n')) {
    if (!line || line.startsWith('COMMAND')) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 9) continue
    const command = parts[0]
    const m = parts[8].match(/:(\d+)$/)
    if (!m) continue
    const port = Number(m[1])
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    if (!ports.has(port) || (ports.get(port) === '' && command)) ports.set(port, command)
  }
  return [...ports.entries()].map(([port, command]) => ({ port, command }))
}

function parseNetstat(out) {
  const ports = new Set()
  for (const line of out.split('\n')) {
    if (!/LISTENING/i.test(line)) continue
    const m = (line.trim().split(/\s+/)[1] ?? '').match(/:(\d+)$/)
    if (!m) continue
    const port = Number(m[1])
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port)
  }
  return [...ports].map((port) => ({ port, command: '' }))
}

async function listeningPorts() {
  if (process.platform === 'win32') return parseNetstat(await runTool('netstat', ['-ano', '-p', 'TCP']))
  return parseLsof(await runTool('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']))
}

// ---- raw Minecraft Server List Ping ----------------------------------------

function writeVarInt(value) {
  const bytes = []
  let v = value >>> 0
  do {
    let temp = v & 0x7f
    v >>>= 7
    if (v !== 0) temp |= 0x80
    bytes.push(temp)
  } while (v !== 0)
  return Buffer.from(bytes)
}

function readVarInt(buf, offset) {
  let numRead = 0
  let result = 0
  let byte
  do {
    if (offset + numRead >= buf.length) return null
    byte = buf[offset + numRead]
    result |= (byte & 0x7f) << (7 * numRead)
    numRead++
    if (numRead > 5) throw new Error('VarInt too big')
  } while ((byte & 0x80) !== 0)
  return { value: result >>> 0, size: numRead }
}

function mkPacket(...parts) {
  const data = Buffer.concat(parts)
  return Buffer.concat([writeVarInt(data.length), data])
}

function motdToText(desc) {
  if (desc == null) return ''
  if (typeof desc === 'string') return desc
  if (typeof desc === 'object') {
    let out = typeof desc.text === 'string' ? desc.text : ''
    if (Array.isArray(desc.extra)) out += desc.extra.map(motdToText).join('')
    return out
  }
  return ''
}

function mcPing(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port })
    let chunks = Buffer.alloc(0)
    let done = false
    const finish = (err, val) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      err ? reject(err) : resolve(val)
    }
    const timer = setTimeout(() => finish(new Error('LAN_PING_TIMEOUT')), timeoutMs)
    sock.on('error', (e) => finish(e))
    sock.on('connect', () => {
      const addr = Buffer.from(host, 'utf8')
      const handshake = mkPacket(
        writeVarInt(0x00),
        writeVarInt(0),
        writeVarInt(addr.length), addr,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1),
      )
      sock.write(Buffer.concat([handshake, mkPacket(writeVarInt(0x00))]))
    })
    sock.on('data', (d) => {
      chunks = Buffer.concat([chunks, d])
      let lenRes
      try { lenRes = readVarInt(chunks, 0) } catch (e) { return finish(e) }
      if (!lenRes) return
      if (chunks.length < lenRes.size + lenRes.value) return
      try {
        let off = lenRes.size
        const idRes = readVarInt(chunks, off); off += idRes.size
        if (idRes.value !== 0x00) return finish(new Error('not a status response'))
        const strLen = readVarInt(chunks, off); off += strLen.size
        const parsed = JSON.parse(chunks.slice(off, off + strLen.value).toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || (!parsed.version && parsed.description == null)) {
          return finish(new Error('not minecraft'))
        }
        finish(null, { port, motd: motdToText(parsed.description) })
      } catch (e) { finish(e) }
    })
  })
}

async function firstMcWorld(ports) {
  if (ports.length === 0) return null
  try { return await Promise.any(ports.map((p) => mcPing(p.port))) } catch { return null }
}

/**
 * One-shot: resolve { port, motd } for the first locally-listening Minecraft
 * world, or reject within timeoutMs. Used by the CLI only — Electron uses
 * watchLan() in src/main/lanWatcher.ts.
 */
export async function discoverLanPort({ timeoutMs = 5000 } = {}) {
  const deadline = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`No Minecraft LAN world found within ${timeoutMs}ms`)), timeoutMs),
  )
  const discover = (async () => {
    let ports
    try {
      ports = await listeningPorts()
    } catch (err) {
      throw new Error(`Could not list local ports for LAN discovery: ${err.message}`)
    }
    const java = ports.filter((p) => /java/i.test(p.command))
    const rest = ports.filter((p) => !/java/i.test(p.command))
    const world = (await firstMcWorld(java)) ?? (await firstMcWorld(rest))
    if (!world) throw new Error('No Minecraft "open to LAN" world found on this machine')
    return world
  })()
  return Promise.race([discover, deadline])
}
