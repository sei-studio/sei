// Minimal Source RCON client for the Factorio headless test harness (scripts/factorio-headless-harness.mjs).
// Test tooling only; the app never uses RCON.
import net from 'node:net'

export async function connectRcon({ host = '127.0.0.1', port, password, timeoutMs = 10_000 }) {
  const sock = net.connect({ host, port })
  let buf = Buffer.alloc(0)
  let nextId = 1
  const waiters = new Map()
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 4) {
      const len = buf.readInt32LE(0)
      if (buf.length < 4 + len) break
      const id = buf.readInt32LE(4)
      const body = buf.subarray(12, 4 + len - 2).toString('utf8')
      buf = buf.subarray(4 + len)
      const w = waiters.get(id)
      if (w) { waiters.delete(id); w.resolve(body) }
      else if (id === -1) for (const [, x] of waiters) x.reject(new Error('rcon auth failed'))
    }
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('rcon connect timeout')), timeoutMs)
    sock.once('connect', () => { clearTimeout(t); resolve() })
    sock.once('error', (e) => { clearTimeout(t); reject(e) })
  })
  function send(type, body) {
    const id = nextId++
    const b = Buffer.from(body, 'utf8')
    const pkt = Buffer.alloc(14 + b.length)
    pkt.writeInt32LE(10 + b.length, 0)
    pkt.writeInt32LE(id, 4)
    pkt.writeInt32LE(type, 8)
    b.copy(pkt, 12)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiters.delete(id); reject(new Error(`rcon timeout: ${body.slice(0, 60)}`)) }, timeoutMs)
      waiters.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
      sock.write(pkt)
    })
  }
  await send(3, password)
  return {
    /** Run a console command; resolves its rcon.print output. */
    cmd: (c) => send(2, c),
    /** Run Lua with /sc and return what it rcon.print()s. */
    lua: (code) => send(2, `/sc ${code.replace(/\n/g, ' ')}`),
    close: () => sock.destroy(),
  }
}
