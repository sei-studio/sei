import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { Agent, ProxyAgent } from 'undici'
import {
  proxyChainFromPac,
  proxyUriFromPac,
  isLocalHost,
  snapshotResolver,
  SystemProxyDispatcher,
  isProxyConnectError,
} from './proxyDispatcher.js'

describe('proxyChainFromPac', () => {
  it('keeps every usable entry in order and stops at the first DIRECT', () => {
    expect(proxyChainFromPac('PROXY a:1; SOCKS5 b:2; DIRECT; PROXY c:3')).toEqual([
      'http://a:1',
      'socks5://b:2',
      null,
    ])
    expect(proxyChainFromPac('HTTPS a:443')).toEqual(['https://a:443'])
    expect(proxyChainFromPac('SOCKS w:1080')).toEqual(['socks5://w:1080'])
    expect(proxyChainFromPac('QUIC q:443; DIRECT')).toEqual([null])
    expect(proxyChainFromPac('')).toEqual([])
    expect(proxyChainFromPac(undefined)).toEqual([])
  })
})

describe('isProxyConnectError', () => {
  it('reads the code anywhere on the cause chain', () => {
    expect(isProxyConnectError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true)
    const wrapped = new TypeError('fetch failed', { cause: Object.assign(new Error('y'), { code: 'ENOTFOUND' }) })
    expect(isProxyConnectError(wrapped)).toBe(true)
    expect(isProxyConnectError(new Error('aborted'))).toBe(false)
    expect(isProxyConnectError(null)).toBe(false)
  })
})

describe('proxyUriFromPac', () => {
  it('maps Chromium PAC answers to the first usable proxy URI', () => {
    expect(proxyUriFromPac('DIRECT')).toBeNull()
    expect(proxyUriFromPac('PROXY 127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(proxyUriFromPac('PROXY 127.0.0.1:7890; DIRECT')).toBe('http://127.0.0.1:7890')
    expect(proxyUriFromPac('HTTPS proxy.example:443')).toBe('https://proxy.example:443')
    expect(proxyUriFromPac('SOCKS5 127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
    expect(proxyUriFromPac('SOCKS 127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
    expect(proxyUriFromPac('QUIC q.example:443; PROXY p.example:8080')).toBe('http://p.example:8080')
    expect(proxyUriFromPac('DIRECT; PROXY p.example:8080')).toBeNull()
    expect(proxyUriFromPac('')).toBeNull()
    expect(proxyUriFromPac(undefined)).toBeNull()
    expect(proxyUriFromPac('PROXY nonsense')).toBeNull()
  })
})

describe('isLocalHost', () => {
  it('keeps loopback, private and single-label hosts direct', () => {
    for (const h of ['localhost', 'a.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.5', '169.254.169.254', '100.64.0.1', '[::1]', 'fd12:3456::1', 'fe80::1', 'nas.local', 'ollama', '::ffff:192.168.0.2']) {
      expect(isLocalHost(h), h).toBe(true)
    }
    for (const h of ['api.sei.gg', 'api.openai.com', '8.8.8.8', '172.32.0.1', '[2606:4700::1]']) {
      expect(isLocalHost(h), h).toBe(false)
    }
  })
})

describe('snapshotResolver', () => {
  it('is null when nothing needs a proxy or the JSON is junk', () => {
    expect(snapshotResolver(undefined)).toBeNull()
    expect(snapshotResolver('{nope')).toBeNull()
    expect(snapshotResolver(JSON.stringify({ default: 'DIRECT', origins: { 'https://api.sei.gg': 'DIRECT' } }))).toBeNull()
  })
  it('answers per origin and falls back to the default', () => {
    const r = snapshotResolver(
      JSON.stringify({ default: 'PROXY 127.0.0.1:7890', origins: { 'https://dashscope.aliyuncs.com': 'DIRECT' } }),
    )
    expect(r('https://dashscope.aliyuncs.com/compatible-mode/v1/chat')).toBe('DIRECT')
    expect(r('https://api.openai.com/v1/models')).toBe('PROXY 127.0.0.1:7890')
  })
})

/**
 * A target origin that is unreachable direct (its name does not resolve) but
 * reachable through a CONNECT proxy that maps it to a local server, the shape
 * of "api.sei.gg blocked direct, fine through the VPN's system proxy".
 */
async function harness() {
  const target = http.createServer((req, res) => {
    if (req.url === '/slow') return void setTimeout(() => res.end('late'), 2_000)
    res.end(`hello ${req.headers.host}`)
  })
  await new Promise((r) => target.listen(0, '127.0.0.1', r))
  const targetPort = target.address().port
  const connects = []
  const proxy = http.createServer((_req, res) => res.writeHead(405).end())
  proxy.on('connect', (req, socket, head) => {
    connects.push(req.url)
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  const proxyPort = proxy.address().port
  return {
    url: `http://blocked.invalid:${targetPort}`,
    proxyPac: `PROXY 127.0.0.1:${proxyPort}; DIRECT`,
    connects,
    targetPort,
    close: () => Promise.all([new Promise((r) => target.close(r)), new Promise((r) => proxy.close(r))]),
  }
}

/** A port nothing listens on. */
async function freePort() {
  const srv = net.createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  await new Promise((r) => srv.close(r))
  return port
}

/** DIRECT that reaches the harness target under any hostname (a VPN user's
 * direct route that works once the dead proxy is out of the way). */
function mappedDirect(targetPort) {
  return new Agent({
    connect: (_opts, cb) => {
      const s = net.connect(targetPort, '127.0.0.1')
      s.once('connect', () => cb(null, s))
      s.once('error', (e) => cb(e, null))
    },
  })
}

function countingProxyAgent(uri, dispatched) {
  const a = new ProxyAgent({ uri })
  const dispatch = a.dispatch.bind(a)
  a.dispatch = (o, hd) => {
    dispatched.push(uri)
    return dispatch(o, hd)
  }
  return a
}

describe('SystemProxyDispatcher with the built-in fetch', () => {
  let h
  let d
  afterEach(async () => {
    await d?.close()
    await h?.close()
    h = d = undefined
  })

  it('goes direct (and fails) without a proxy, through the proxy with one', async () => {
    h = await harness()
    d = new SystemProxyDispatcher({ resolve: () => 'DIRECT', direct: new Agent() })
    await expect(fetch(`${h.url}/`, { dispatcher: d })).rejects.toThrow()
    await d.close()

    const asked = []
    d = new SystemProxyDispatcher({
      resolve: (u) => {
        asked.push(u)
        return h.proxyPac
      },
      direct: new Agent(),
    })
    const res = await fetch(`${h.url}/`, { dispatcher: d })
    expect(await res.text()).toMatch(/^hello blocked\.invalid/)
    // Cached per origin: a second request does not ask again.
    await (await fetch(`${h.url}/again`, { dispatcher: d })).text()
    expect(asked).toEqual([`${h.url}/`])
    expect(h.connects.length).toBeGreaterThan(0)
  })

  it('never asks the resolver about loopback hosts', async () => {
    h = await harness()
    const asked = []
    d = new SystemProxyDispatcher({ resolve: (u) => (asked.push(u), h.proxyPac), direct: new Agent() })
    const port = new URL(h.url).port
    const res = await fetch(`http://127.0.0.1:${port}/`, { dispatcher: d })
    expect(res.status).toBe(200)
    await res.text()
    expect(asked).toEqual([])
    expect(h.connects).toEqual([])
  })

  it('treats a hung lookup as DIRECT and remembers that for failedTtlMs', async () => {
    h = await harness()
    let calls = 0
    let clock = 1_000_000
    d = new SystemProxyDispatcher({
      resolve: () => {
        calls += 1
        return calls === 1 ? new Promise(() => {}) : h.proxyPac
      },
      direct: new Agent(),
      resolveTimeoutMs: 50,
      now: () => clock,
    })
    await expect(fetch(`${h.url}/`, { dispatcher: d })).rejects.toThrow()
    // A slow WPAD must not cost resolveTimeoutMs on every request.
    await expect(fetch(`${h.url}/`, { dispatcher: d })).rejects.toThrow()
    expect(calls).toBe(1)
    clock += 31_000
    const res = await fetch(`${h.url}/`, { dispatcher: d })
    expect(res.status).toBe(200)
    await res.text()
    expect(calls).toBe(2)
  })

  it('caches a failing lookup too, and lets a late answer replace the DIRECT stand-in', async () => {
    h = await harness()
    let calls = 0
    d = new SystemProxyDispatcher({
      resolve: () => {
        calls += 1
        return new Promise((r) => setTimeout(() => r(h.proxyPac), 100))
      },
      direct: new Agent(),
      resolveTimeoutMs: 20,
    })
    await expect(fetch(`${h.url}/`, { dispatcher: d })).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 200))
    const res = await fetch(`${h.url}/`, { dispatcher: d })
    expect(await res.text()).toMatch(/^hello/)
    expect(calls).toBe(1)

    await d.close()
    let failing = 0
    d = new SystemProxyDispatcher({
      resolve: () => {
        failing += 1
        throw new Error('pac broke')
      },
      direct: new Agent(),
    })
    await expect(fetch(`${h.url}/`, { dispatcher: d })).rejects.toThrow()
    await expect(fetch(`${h.url}/`, { dispatcher: d })).rejects.toThrow()
    expect(failing).toBe(1)
  })

  it('keeps the caller abort working while the lookup is pending and mid-request', async () => {
    h = await harness()
    let release
    d = new SystemProxyDispatcher({
      resolve: () => new Promise((r) => (release = () => r(h.proxyPac))),
      direct: new Agent(),
    })
    const ac = new AbortController()
    const p = fetch(`${h.url}/`, { dispatcher: d, signal: ac.signal })
    ac.abort(new Error('caller gave up'))
    await expect(p).rejects.toThrow('caller gave up')
    release()
    await new Promise((r) => setTimeout(r, 50))

    const started = Date.now()
    await expect(fetch(`${h.url}/slow`, { dispatcher: d, signal: AbortSignal.timeout(200) })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1_500)
  })
  it('retries a request DIRECT when the proxy refuses the connection, and skips that proxy for deadMs', async () => {
    h = await harness()
    const closedPort = await freePort()
    const dead = `http://127.0.0.1:${closedPort}`
    const dispatched = []
    const lines = []
    let clock = 5_000_000
    d = new SystemProxyDispatcher({
      resolve: () => `PROXY 127.0.0.1:${closedPort}; DIRECT`,
      direct: mappedDirect(h.targetPort),
      makeAgent: (uri) => countingProxyAgent(uri, dispatched),
      now: () => clock,
      log: (m) => lines.push(m),
    })
    const res = await fetch(`${h.url}/`, { dispatcher: d })
    expect(await res.text()).toMatch(/^hello blocked\.invalid/)
    expect(dispatched).toEqual([dead])
    expect(lines.some((l) => l.includes(`proxy ${dead} unreachable (ECONNREFUSED)`))).toBe(true)

    // Dead: the next request goes straight to DIRECT.
    await (await fetch(`${h.url}/again`, { dispatcher: d })).text()
    expect(dispatched).toEqual([dead])

    // After deadMs the proxy is tried again (and fails over again).
    clock += 61_000
    await (await fetch(`${h.url}/later`, { dispatcher: d })).text()
    expect(dispatched).toEqual([dead, dead])
  })

  it('falls back DIRECT once even when the PAC answer names no DIRECT', async () => {
    h = await harness()
    const closedPort = await freePort()
    const dispatched = []
    d = new SystemProxyDispatcher({
      resolve: () => `PROXY 127.0.0.1:${closedPort}`,
      direct: mappedDirect(h.targetPort),
      makeAgent: (uri) => countingProxyAgent(uri, dispatched),
    })
    const res = await fetch(`${h.url}/`, { dispatcher: d })
    expect(res.status).toBe(200)
    await res.text()
    expect(dispatched).toHaveLength(1)
  })

  it('moves to the next proxy in the list before DIRECT', async () => {
    h = await harness()
    const closedPort = await freePort()
    const dispatched = []
    const livePac = h.proxyPac.replace('; DIRECT', '')
    d = new SystemProxyDispatcher({
      resolve: () => `PROXY 127.0.0.1:${closedPort}; ${livePac}; DIRECT`,
      direct: new Agent(),
      makeAgent: (uri) => countingProxyAgent(uri, dispatched),
    })
    const res = await fetch(`${h.url}/`, { dispatcher: d })
    expect(await res.text()).toMatch(/^hello/)
    expect(dispatched).toHaveLength(2)
    expect(h.connects.length).toBe(1)
  })

  it('logs once that a SOCKS (v4) entry is tried as SOCKS5', async () => {
    h = await harness()
    const lines = []
    const made = []
    d = new SystemProxyDispatcher({
      resolve: () => 'SOCKS 127.0.0.1:1; DIRECT',
      direct: mappedDirect(h.targetPort),
      makeAgent: (uri) => {
        made.push(uri)
        return countingProxyAgent(`http://127.0.0.1:${new URL(uri).port}`, [])
      },
      log: (m) => lines.push(m),
    })
    await (await fetch(`${h.url}/`, { dispatcher: d })).text()
    await (await fetch(`http://other.invalid:${h.targetPort}/`, { dispatcher: d })).text()
    expect(made).toEqual(['socks5://127.0.0.1:1'])
    expect(lines.filter((l) => l.includes('tried as SOCKS5'))).toHaveLength(1)
  })
})
