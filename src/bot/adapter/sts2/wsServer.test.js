import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { createWsServer, encodeFrame, decodeFrames } from './wsServer.js'

const servers = []
afterEach(async () => { while (servers.length) await servers.pop().close() })

async function start(opts = {}) {
  const s = await createWsServer({ port: 0, path: '/sei-sts2', ...opts })
  servers.push(s)
  return s
}

function mask(opcode, text, fin = true) {
  const body = Buffer.from(text)
  const key = Buffer.from([1, 2, 3, 4])
  const len = body.length
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]) : (() => { const h = Buffer.alloc(4); h[0] = (fin ? 0x80 : 0) | opcode; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); return h })()
  const out = Buffer.alloc(len)
  for (let i = 0; i < len; i++) out[i] = body[i] ^ key[i & 3]
  return Buffer.concat([head, key, out])
}

function upgradeStatus(port, headers) {
  return new Promise((resolve) => {
    const req = http.request({ port, host: '127.0.0.1', path: headers.path ?? '/sei-sts2', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', ...headers.h } })
    req.on('upgrade', (res) => { res.destroy?.(); resolve(101) })
    req.on('response', (res) => resolve(res.statusCode))
    req.on('error', () => resolve('error'))
    req.end()
  })
}

describe('frames', () => {
  it('round-trips masked client frames of every length class', () => {
    for (const n of [0, 5, 125, 126, 65_535]) {
      const text = 'x'.repeat(n)
      const { frames, rest } = decodeFrames(mask(0x1, text))
      if (n < 65536) {
        expect(frames).toHaveLength(1)
        expect(frames[0].payload.toString()).toBe(text)
        expect(rest.length).toBe(0)
      }
    }
    // A 127-length header (64-bit) for big payloads.
    const big = encodeFrame(0x1, 'y'.repeat(70_000))
    expect(big[1]).toBe(127)
  })

  it('waits for a partial frame and refuses unmasked client frames', () => {
    const f = mask(0x1, 'hello')
    expect(decodeFrames(f.subarray(0, 4)).frames).toHaveLength(0)
    expect(decodeFrames(encodeFrame(0x1, 'hi')).error).toBe('unmasked client frame')
  })
})

describe('createWsServer', () => {
  it('talks to a standard WebSocket client both ways', async () => {
    const s = await start()
    const got = []
    s.on('connection', (c) => { c.on('message', (t) => { got.push(t); c.send(`echo:${t}`) }) })
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/sei-sts2`)
    const echo = await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => ws.send('hi there'))
      ws.addEventListener('message', (ev) => resolve(ev.data))
      ws.addEventListener('error', reject)
    })
    expect(echo).toBe('echo:hi there')
    expect(got).toEqual(['hi there'])
    ws.close()
  })

  it('refuses a browser origin, a wrong path and a wrong token', async () => {
    const s = await start({ token: 'secret' })
    expect(await upgradeStatus(s.port, { h: { Origin: 'https://evil.example' } })).toBe(403)
    expect(await upgradeStatus(s.port, { path: '/other' })).toBe(404)
    expect(await upgradeStatus(s.port, { path: '/sei-sts2?token=nope' })).toBe(401)
    expect(await upgradeStatus(s.port, { path: '/sei-sts2?token=secret' })).toBe(101)
    // No token at all is the upstream mod: allowed unless required.
    expect(await upgradeStatus(s.port, { path: '/sei-sts2' })).toBe(101)
  })

  it('requires the token when asked', async () => {
    const s = await start({ token: 'secret', requireToken: true })
    expect(await upgradeStatus(s.port, { path: '/sei-sts2' })).toBe(401)
  })
})
