import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { Agent } from 'undici'
import { proxyUriFromPac, isLocalHost, snapshotResolver, SystemProxyDispatcher } from './systemProxy.js'

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
    close: () => Promise.all([new Promise((r) => target.close(r)), new Promise((r) => proxy.close(r))]),
  }
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

  it('treats a hung or failing lookup as DIRECT and does not cache it', async () => {
    h = await harness()
    let calls = 0
    d = new SystemProxyDispatcher({
      resolve: () => {
        calls += 1
        return calls === 1 ? new Promise(() => {}) : h.proxyPac
      },
      direct: new Agent(),
      resolveTimeoutMs: 50,
    })
    await expect(fetch(`${h.url}/`, { dispatcher: d })).rejects.toThrow()
    const res = await fetch(`${h.url}/`, { dispatcher: d })
    expect(res.status).toBe(200)
    await res.text()
    expect(calls).toBe(2)
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
})
