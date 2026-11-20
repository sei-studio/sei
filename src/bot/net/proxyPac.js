// Pure halves of the system-proxy routing (261103, T303): PAC answers, the
// local-host bypass and the bot's fork-time snapshot. No undici import, so
// the bot can decide whether it needs a proxy at all without loading undici
// or touching the global dispatcher (src/bot/index.js).

/**
 * Parse Chromium's PAC-style answer ("PROXY host:port; DIRECT") into the
 * ordered entries undici can use, as proxy URIs, with `null` for DIRECT. The
 * list stops at the first DIRECT (nothing after it is ever tried).
 *
 * Schemes, per Chromium's ProxyServer::ToPacString: PROXY = http proxy,
 * HTTPS = TLS to the proxy, SOCKS5, SOCKS (= SOCKS4 in Chromium, which is
 * also what a bare Windows "socks=host:port" proxy setting becomes). undici
 * speaks SOCKS5 only; a SOCKS4 entry is tried as SOCKS5 because the local VPN
 * clients that publish one (Clash/v2ray "mixed" ports) answer both, and the
 * alternative, going direct, is what was already broken. QUIC and anything
 * unknown are skipped.
 *
 * @param {string | null | undefined} result
 * @returns {Array<string | null>}
 */
export function proxyChainFromPac(result) {
  /** @type {Array<string | null>} */
  const chain = []
  if (typeof result !== 'string') return chain
  for (const raw of result.split(';')) {
    const entry = raw.trim()
    if (!entry) continue
    const [schemeRaw, hostPort] = entry.split(/\s+/, 2)
    const scheme = schemeRaw.toUpperCase()
    if (scheme === 'DIRECT') {
      chain.push(null)
      break
    }
    if (!hostPort || !/^[^\s/]+:\d+$/.test(hostPort)) continue
    if (scheme === 'PROXY') chain.push(`http://${hostPort}`)
    else if (scheme === 'HTTPS') chain.push(`https://${hostPort}`)
    else if (scheme === 'SOCKS5' || scheme === 'SOCKS' || scheme === 'SOCKS4') chain.push(`socks5://${hostPort}`)
  }
  return chain
}

/**
 * The first usable proxy URI of a PAC answer, or null for DIRECT.
 * @param {string | null | undefined} result
 * @returns {string | null}
 */
export function proxyUriFromPac(result) {
  return proxyChainFromPac(result)[0] ?? null
}

/**
 * True when the answer holds a SOCKS4 entry ("SOCKS h:p", the form a bare
 * Windows "socks=" setting takes), which is tried as SOCKS5.
 * @param {string | null | undefined} result
 */
export function hasSocks4Entry(result) {
  return typeof result === 'string' && /(^|;)\s*SOCKS4?\s+\S/i.test(result)
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
export function originOf(origin) {
  try {
    return origin instanceof URL ? origin : new URL(String(origin))
  } catch {
    return null
  }
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
