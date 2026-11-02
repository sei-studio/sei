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
// The dispatcher half; systemProxy.js installs it. Importing this module
// loads the undici package, which claims undici's global dispatcher slot
// with its own Agent when the slot is empty, so only systemProxy.js may
// import it, and only after Node's built-in fetch has made its Agent.
//
// One undici global dispatcher asks a resolver
// (main: Chromium's session.resolveProxy; bot: a snapshot main took at fork)
// which proxies serve each ORIGIN and hands the request to a ProxyAgent /
// Socks5ProxyAgent for that proxy, or for DIRECT to the dispatcher Node's own
// fetch had installed (its built-in Agent, so a DIRECT request takes exactly
// the path it took before). Every caller of the global fetch is covered
// without touching it, including SDKs (supabase-js, Anthropic) that look fetch
// up themselves. Timeouts and aborts stay with the callers: their
// AbortSignals reach the request exactly as before.
//
// A proxy that cannot be reached (refused, reset, unresolvable: a VPN that
// was switched off, the bot's fork-time snapshot gone stale) is marked dead
// for PROXY_DEAD_MS and the request moves to the next PAC entry, ending
// DIRECT. Only a request that never started is moved, so nothing is sent
// twice.
//
// Loopback and private-network hosts never consult the resolver. Chromium
// bypasses loopback on its own, and LAN targets (an Ollama box, a Stardew
// client) worked direct before this change, so they keep doing that.

import { Dispatcher, ProxyAgent, Socks5ProxyAgent, getGlobalDispatcher } from 'undici'
import { hasSocks4Entry, isLocalHost, originOf, proxyChainFromPac } from './proxyPac.js'

export { proxyChainFromPac, proxyUriFromPac, hasSocks4Entry, isLocalHost, snapshotResolver } from './proxyPac.js'

/** How long one origin's resolved proxy list is reused before asking again. */
export const PROXY_CACHE_TTL_MS = 60_000

/** How long a failed or timed-out lookup is remembered as DIRECT, so a slow
 * WPAD / PAC fetch costs one wait, not one per request. */
export const PROXY_FAILED_LOOKUP_TTL_MS = 30_000

/** Upper bound on one proxy lookup (a PAC script download can hang). */
export const PROXY_RESOLVE_TIMEOUT_MS = 3_000

/** How long a proxy that refused a connection is skipped. */
export const PROXY_DEAD_MS = 60_000

/** Errors that mean "could not reach the proxy itself". */
const PROXY_CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** @param {unknown} err */
export function isProxyConnectError(err) {
  let cur = err
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const code = /** @type {{ code?: unknown }} */ (cur).code
    if (typeof code === 'string' && PROXY_CONNECT_ERROR_CODES.has(code)) return true
    cur = /** @type {{ cause?: unknown }} */ (cur).cause
  }
  return false
}

const START_METHODS = new Set(['onConnect', 'onRequestStart', 'onHeaders', 'onResponseStart', 'onUpgrade', 'onRequestUpgrade'])

/**
 * Wrap an undici handler so a proxy connect error that lands BEFORE the
 * request started is handed to `onFail` instead of the caller. Methods the
 * handler does not have stay absent (undici picks the handler API by which
 * methods exist).
 * @param {any} handler
 * @param {(err: Error) => void} onFail
 */
function failoverHandler(handler, onFail) {
  let started = false
  let failedOver = false
  return new Proxy(handler, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      if (typeof prop === 'string' && START_METHODS.has(prop)) {
        return (...args) => {
          started = true
          return value.apply(target, args)
        }
      }
      if (prop === 'onError' || prop === 'onResponseError') {
        return (...args) => {
          const err = prop === 'onError' ? args[0] : args[1]
          if (!started && !failedOver && isProxyConnectError(err)) {
            failedOver = true
            onFail(/** @type {Error} */ (err))
            return undefined
          }
          return value.apply(target, args)
        }
      }
      return value.bind(target)
    },
  })
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
 * @property {number} [failedTtlMs]
 * @property {number} [deadMs]
 * @property {number} [resolveTimeoutMs]
 * @property {() => number} [now]
 * @property {(uri: string) => Dispatcher} [makeAgent]  Test seam.
 * @property {(line: string) => void} [log]
 */

/** @typedef {{ chain: Array<string | null>, expires: number, failed: boolean }} CacheEntry */

export class SystemProxyDispatcher extends Dispatcher {
  /** @param {SystemProxyOptions} opts */
  constructor(opts) {
    super()
    this.resolveFn = opts.resolve
    this.direct = opts.direct ?? getGlobalDispatcher()
    this.ttlMs = opts.ttlMs ?? PROXY_CACHE_TTL_MS
    this.failedTtlMs = opts.failedTtlMs ?? PROXY_FAILED_LOOKUP_TTL_MS
    this.deadMs = opts.deadMs ?? PROXY_DEAD_MS
    this.resolveTimeoutMs = opts.resolveTimeoutMs ?? PROXY_RESOLVE_TIMEOUT_MS
    this.now = opts.now ?? Date.now
    this.makeAgent = opts.makeAgent ?? defaultMakeAgent
    this.log = opts.log ?? (() => {})
    /** @type {Map<string, CacheEntry>} */
    this.cache = new Map()
    /** @type {Map<string, Promise<Array<string | null>>>} */
    this.inflight = new Map()
    /** @type {Map<string, Dispatcher>} */
    this.agents = new Map()
    /** @type {Map<string, number>} proxy URI -> dead until (epoch ms) */
    this.deadUntil = new Map()
    /** Last route logged per origin, so the log says when routing CHANGES. */
    this.logged = new Map()
    this.loggedSocks4 = false
  }

  /** @param {string} origin @param {Array<string | null>} chain @param {boolean} failed */
  remember(origin, chain, failed) {
    this.cache.set(origin, { chain, failed, expires: this.now() + (failed ? this.failedTtlMs : this.ttlMs) })
    const shown = chain[0] ?? null
    const key = `${shown}${failed ? '!' : ''}`
    if (this.logged.get(origin) !== key) {
      this.logged.set(origin, key)
      this.log(`[net] ${origin} -> ${shown ?? 'DIRECT'}${failed ? ' (proxy lookup failed)' : ''}`)
    }
  }

  /** @param {string} origin @returns {Array<string | null> | null} */
  cached(origin) {
    const hit = this.cache.get(origin)
    return hit && hit.expires > this.now() ? hit.chain : null
  }

  /**
   * The proxy list (ending DIRECT) for an origin. A lookup that fails or
   * takes longer than resolveTimeoutMs means DIRECT, remembered for
   * failedTtlMs; a late answer still lands in the cache when it arrives.
   * @param {string} origin  e.g. https://api.sei.gg
   * @returns {Promise<Array<string | null>>}
   */
  proxyFor(origin) {
    const hit = this.cached(origin)
    if (hit) return Promise.resolve(hit)
    const pending = this.inflight.get(origin)
    if (pending) return pending
    const lookup = Promise.resolve()
      .then(() => this.resolveFn(`${origin}/`))
      .then(
        (answer) => {
          if (hasSocks4Entry(answer) && !this.loggedSocks4) {
            this.loggedSocks4 = true
            this.log(`[net] SOCKS (v4) proxy entry for ${origin} is tried as SOCKS5`)
          }
          const chain = proxyChainFromPac(answer)
          if (chain[chain.length - 1] !== null) chain.push(null)
          return chain
        },
        () => null,
      )
    let timer
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.resolveTimeoutMs)
    })
    const p = Promise.race([lookup, timedOut])
      .then((chain) => {
        clearTimeout(timer)
        if (chain === undefined) {
          // Slow: go DIRECT now, and let the real answer replace the
          // failed entry when it lands.
          void lookup.then((late) => {
            if (late) this.remember(origin, late, false)
          })
          this.remember(origin, [null], true)
          return [null]
        }
        if (chain === null) {
          this.remember(origin, [null], true)
          return [null]
        }
        this.remember(origin, chain, false)
        return chain
      })
      .finally(() => this.inflight.delete(origin))
    this.inflight.set(origin, p)
    return p
  }

  /** @param {string | null} proxy */
  isDead(proxy) {
    if (proxy === null) return false
    const until = this.deadUntil.get(proxy)
    if (until === undefined) return false
    if (until > this.now()) return true
    this.deadUntil.delete(proxy)
    return false
  }

  /** @param {string} proxy @param {Error} err @param {string} origin */
  markDead(proxy, err, origin) {
    this.deadUntil.set(proxy, this.now() + this.deadMs)
    const code = /** @type {{ code?: string }} */ (err)?.code ?? /** @type {any} */ (err)?.cause?.code ?? 'error'
    this.log(`[net] proxy ${proxy} unreachable (${code}) for ${origin}; skipping it for ${Math.round(this.deadMs / 1000)}s`)
  }

  /** @param {string} proxy */
  agentFor(proxy) {
    let agent = this.agents.get(proxy)
    if (!agent) {
      agent = this.makeAgent(proxy)
      this.agents.set(proxy, agent)
    }
    return agent
  }

  /**
   * Dispatch through the first live entry of `chain` at or after `from`; a
   * connect error on a proxy moves the request to the next entry.
   * @param {Array<string | null>} chain
   * @param {string} origin
   * @param {any} opts
   * @param {any} handler
   * @param {number} [from]
   */
  dispatchVia(chain, origin, opts, handler, from = 0) {
    let i = from
    while (i < chain.length && chain[i] !== null && this.isDead(chain[i])) i++
    const proxy = i < chain.length ? chain[i] : null
    if (proxy === null) return this.direct.dispatch(opts, handler)
    const wrapped = failoverHandler(handler, (err) => {
      this.markDead(proxy, err, origin)
      try {
        this.dispatchVia(chain, origin, opts, handler, i + 1)
      } catch (e) {
        failHandler(handler, /** @type {Error} */ (e))
      }
    })
    return this.agentFor(proxy).dispatch(opts, wrapped)
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
    const hit = this.cached(origin)
    if (hit) return this.dispatchVia(hit, origin, opts, handler)
    // undici's fetch tolerates an asynchronous start: an abort that lands
    // while the lookup runs is seen by its handler on connect and cancels
    // the request there.
    this.proxyFor(origin).then((chain) => {
      try {
        this.dispatchVia(chain, origin, opts, handler)
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
