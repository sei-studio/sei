// Route Node's built-in fetch through the OS proxy, the way Chromium does
// (261103, T303).
//
// Node's fetch (undici) ignores the system proxy and PAC settings. A user who
// runs a VPN client in "system proxy" mode (Clash, v2rayN and the like, the
// usual setup in mainland China) had the browser and every Chromium request
// going through the VPN while main and the bot went DIRECT: the Google
// sign-in reached Supabase's /callback in the browser, then the PKCE code
// exchange from main never completed, ChatGPT's token exchange went to
// auth.openai.com from a China IP, and BYOK OpenAI calls were refused.
//
// This module installs one undici global dispatcher that asks a resolver
// (main: Chromium's session.resolveProxy; bot: a snapshot main took at fork)
// which proxy serves each ORIGIN and hands the request to a ProxyAgent /
// Socks5ProxyAgent for that proxy, or to the dispatcher that was in place
// before (unchanged behaviour) for DIRECT. Every caller of the global fetch is
// covered without touching it, including SDKs (supabase-js, Anthropic) that
// look fetch up themselves. Timeouts and aborts stay with the callers: their
// AbortSignals reach the request exactly as before.
//
// Loopback and private-network hosts never consult the resolver. Chromium
// bypasses loopback on its own, and LAN targets (an Ollama box, a Stardew
// client) worked direct before this change, so they keep doing that.

import { Dispatcher, ProxyAgent, Socks5ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

/** How long one origin's resolved proxy is reused before asking again. */
export const PROXY_CACHE_TTL_MS = 60_000

/** Upper bound on one proxy lookup (a PAC script download can hang). */
export const PROXY_RESOLVE_TIMEOUT_MS = 3_000

/**
 * Parse Chromium's PAC-style answer ("PROXY host:port; DIRECT") into the first
 * entry undici can use, as a proxy URI, or null for DIRECT.
 *
 * Schemes, per Chromium's ProxyServer::ToPacString: PROXY = http proxy,
 * HTTPS = TLS to the proxy, SOCKS5, SOCKS (= SOCKS4 in Chromium). undici
 * speaks SOCKS5 only; a SOCKS4 entry is tried as SOCKS5 because the local VPN
 * clients that publish one (Clash/v2ray "mixed" ports) answer both, and the
 * alternative, going direct, is what was already broken. QUIC and anything
 * unknown are skipped in favour of the next entry.
 *
 * @param {string | null | undefined} result
 * @returns {string | null}
 */
export function proxyUriFromPac(result) {
  if (typeof result !== 'string') return null
  for (const raw of result.split(';')) {
    const entry = raw.trim()
    if (!entry) continue
    const [schemeRaw, hostPort] = entry.split(/\s+/, 2)
    const scheme = schemeRaw.toUpperCase()
    if (scheme === 'DIRECT') return null
    if (!hostPort || !/^[^\s/]+:\d+$/.test(hostPort)) continue
    if (scheme === 'PROXY') return `http://${hostPort}`
    if (scheme === 'HTTPS') return `https://${hostPort}`
    if (scheme === 'SOCKS5' || scheme === 'SOCKS' || scheme === 'SOCKS4') return `socks5://${hostPort}`
  }
  return null
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * True for hosts that must never go through the system proxy: loopback,
 * RFC1918 / CGNAT / link-local IPv4, IPv6 loopback / ULA / link-local,
 * `localhost` and `.local` / `.localhost` names, and single-label names.
 *
 * @param {string} hostname  URL.hostname (IPv6 may be bracketed)
 */
export function isLocalHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  const m = IPV4_RE.exec(h)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return (
      a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true // fe80::/10
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
    return mapped ? isLocalHost(mapped[1]) : false
  }
  return !h.includes('.')
}

/** @param {unknown} origin */
function originOf(origin) {
  try {
    const u = origin instanceof URL ? origin : new URL(String(origin))
    return u
  } catch {
    return null
  }
}

/**
 * Hand an error to an undici handler, old or new callback style.
 * @param {any} handler
 * @param {Error} err
 */
function failHandler(handler, err) {
  if (typeof handler.onResponseError === 'function') handler.onResponseError(null, err)
  else if (typeof handler.onError === 'function') handler.onError(err)
}

/**
 * @typedef {object} SystemProxyOptions
 * @property {(url: string) => Promise<string> | string} resolve
 *   Chromium-style answer for a URL ("PROXY h:p; DIRECT", "DIRECT", ...).
 * @property {Dispatcher} [direct]  Dispatcher for DIRECT (default: the current global one).
 * @property {number} [ttlMs]
 * @property {number} [resolveTimeoutMs]
 * @property {() => number} [now]
 * @property {(uri: string) => Dispatcher} [makeAgent]  Test seam.
 * @property {(line: string) => void} [log]
 */

export class SystemProxyDispatcher extends Dispatcher {
  /** @param {SystemProxyOptions} opts */
  constructor(opts) {
    super()
    this.resolveFn = opts.resolve
    this.direct = opts.direct ?? getGlobalDispatcher()
    this.ttlMs = opts.ttlMs ?? PROXY_CACHE_TTL_MS
    this.resolveTimeoutMs = opts.resolveTimeoutMs ?? PROXY_RESOLVE_TIMEOUT_MS
    this.now = opts.now ?? Date.now
    this.makeAgent = opts.makeAgent ?? defaultMakeAgent
    this.log = opts.log ?? (() => {})
    /** @type {Map<string, { proxy: string | null, expires: number }>} */
    this.cache = new Map()
    /** @type {Map<string, Promise<string | null>>} */
    this.inflight = new Map()
    /** @type {Map<string, Dispatcher>} */
    this.agents = new Map()
    /** Last proxy logged per origin, so the log says when routing CHANGES. */
    this.logged = new Map()
  }

  /**
   * The proxy URI (or null = DIRECT) for an origin, cached for ttlMs. A lookup
   * that fails or times out means DIRECT, which is what Node did before.
   * @param {string} origin  e.g. https://api.sei.gg
   * @returns {Promise<string | null>}
   */
  proxyFor(origin) {
    const hit = this.cache.get(origin)
    if (hit && hit.expires > this.now()) return Promise.resolve(hit.proxy)
    const pending = this.inflight.get(origin)
    if (pending) return pending
    let timer
    const p = Promise.race([
      Promise.resolve().then(() => this.resolveFn(`${origin}/`)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.resolveTimeoutMs)
      }),
    ])
      .then(
        (answer) => (answer === undefined ? { proxy: null, ok: false } : { proxy: proxyUriFromPac(answer), ok: true }),
        () => ({ proxy: null, ok: false }),
      )
      .then(({ proxy, ok }) => {
        clearTimeout(timer)
        // A failed lookup is retried on the next request rather than pinned.
        if (ok) this.cache.set(origin, { proxy, expires: this.now() + this.ttlMs })
        if (this.logged.get(origin) !== proxy) {
          this.logged.set(origin, proxy)
          this.log(`[net] ${origin} -> ${proxy ?? 'DIRECT'}${ok ? '' : ' (proxy lookup failed)'}`)
        }
        return proxy
      })
      .finally(() => this.inflight.delete(origin))
    this.inflight.set(origin, p)
    return p
  }

  /** @param {string | null} proxy */
  route(proxy) {
    if (proxy === null) return this.direct
    let agent = this.agents.get(proxy)
    if (!agent) {
      agent = this.makeAgent(proxy)
      this.agents.set(proxy, agent)
    }
    return agent
  }

  /**
   * @param {any} opts
   * @param {any} handler
   */
  dispatch(opts, handler) {
    const url = originOf(opts?.origin)
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || isLocalHost(url.hostname)) {
      return this.direct.dispatch(opts, handler)
    }
    const origin = url.origin
    const hit = this.cache.get(origin)
    if (hit && hit.expires > this.now()) return this.route(hit.proxy).dispatch(opts, handler)
    // undici's fetch tolerates an asynchronous start: an abort that lands
    // while the lookup runs is seen by its handler on connect and cancels
    // the request there.
    this.proxyFor(origin).then((proxy) => {
      try {
        this.route(proxy).dispatch(opts, handler)
      } catch (err) {
        failHandler(handler, /** @type {Error} */ (err))
      }
    })
    return true
  }

  async close() {
    await Promise.all([...this.agents.values()].map((a) => a.close().catch(() => {})))
  }

  /** @param {Error | null} [err] */
  async destroy(err) {
    await Promise.all([...this.agents.values()].map((a) => a.destroy(err ?? null).catch(() => {})))
  }
}

/** @param {string} uri */
function defaultMakeAgent(uri) {
  if (uri.startsWith('socks5://')) return new Socks5ProxyAgent(uri)
  return new ProxyAgent({ uri })
}

/**
 * Install the system-proxy dispatcher as undici's global dispatcher, which the
 * built-in fetch reads on every request. Idempotent: a second call returns the
 * dispatcher already installed.
 *
 * @param {SystemProxyOptions} opts
 * @returns {SystemProxyDispatcher}
 */
export function installSystemProxy(opts) {
  const current = getGlobalDispatcher()
  if (current instanceof SystemProxyDispatcher) return current
  const d = new SystemProxyDispatcher({ direct: current, ...opts })
  setGlobalDispatcher(d)
  return d
}

/**
 * Resolver over a snapshot main took when it forked the bot (the bot's
 * utilityProcess has no session to ask). Shape: { default?: string,
 * origins?: Record<origin, string> }, values in Chromium's PAC format. An
 * origin main did not resolve uses `default` (what main got for the proxy
 * base, the bot's main destination).
 *
 * @param {string | undefined} raw  JSON from SEI_SYSTEM_PROXY
 * @returns {((url: string) => string) | null}  null when there is nothing to route
 */
export function snapshotResolver(raw) {
  if (!raw) return null
  let snap
  try {
    snap = JSON.parse(raw)
  } catch {
    return null
  }
  if (!snap || typeof snap !== 'object') return null
  const origins = snap.origins && typeof snap.origins === 'object' ? snap.origins : {}
  const fallback = typeof snap.default === 'string' ? snap.default : 'DIRECT'
  const anyProxy = [fallback, ...Object.values(origins)].some((v) => proxyUriFromPac(v) !== null)
  if (!anyProxy) return null
  return (url) => {
    const u = originOf(url)
    const v = u ? origins[u.origin] : undefined
    return typeof v === 'string' ? v : fallback
  }
}
