// src/bot/web/webTools.js
//
// 260909: ultralight web access for every AI surface. Two tools, one loop.
//
//   search(query)        -> a handful of lettered results, ~250 tokens
//   visit(ref, page?)    -> one page of readable text for a lettered result
//                           (or a raw URL), ~600 tokens per page
//
// Design rules, in priority order:
//   1. CONTEXT IS THE COST. The model never sees a URL: results are labelled
//      `a`, `b`, `c`... and the label is the handle it passes to visit(). Titles
//      and snippets are clipped, page text is de-boilerplated and paged.
//   2. NO NEW MACHINERY. Both tools are ordinary synchronous-result tools:
//      each surface's existing tool loop feeds the result back and calls the
//      model again until it stops calling tools. `createWebSession` is the
//      only state (the label table + the per-turn budget).
//   3. ZERO DEPENDENCIES, ZERO KEYS BY DEFAULT. Plain `fetch` + regex. Keyed
//      providers (Brave / Tavily / Serper) are used when a key is configured;
//      otherwise a keyless chain (DuckDuckGo HTML -> Bing HTML -> Wikipedia)
//      is tried in order and the first that yields results wins. Wikipedia is
//      the floor that always answers, even from an IP the scrapers challenge.
//
// This file is pure JS with no Electron / mineflayer imports so the bot
// (raw ESM, asar-unpacked) and Electron main (bundled by electron-vite) can
// both import it. Keep it that way.

const DEFAULT_LIMITS = Object.freeze({
  maxResults: 5,
  titleChars: 70,
  snippetChars: 150,
  pageChars: 2400,
  fetchTimeoutMs: 8000,
  maxBodyBytes: 1_500_000,
  maxCallsPerTurn: 6,
  maxRedirects: 5,
})

export const WEB_PROVIDERS = Object.freeze(['auto', 'brave', 'tavily', 'serper', 'ddg', 'bing', 'wikipedia'])
export const KEYED_PROVIDERS = new Set(['brave', 'tavily', 'serper'])

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export const SEARCH_TOOL_DESCRIPTION =
  'Search the web. Returns a few lettered results (a, b, c...) with a title and a short snippet each. ' +
  'Use it when the player asks about something you are not sure of, or when a fact, a recipe, a date, a price or a name matters and guessing would be worse than checking. ' +
  'Call visit(ref) with a result letter to read the page itself. Search results are private to you; tell the player what you learned in your own words. ' +
  'You may tell the player you are checking in the SAME turn (say() in the game, your reply text in chat); it lands before the results come back. Optional, not required.'

export const VISIT_TOOL_DESCRIPTION =
  'Read a web page as plain text, one page of text at a time. Pass the letter of a search result (for example "b"), or a full URL. ' +
  'Long pages are split into numbered parts; pass page: 2 to read the next part. Read only what you need.'

export const SEARCH_TOOL = Object.freeze({
  name: 'search',
  description: SEARCH_TOOL_DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: 'What to search for, as you would type it into a search engine.' },
    },
    required: ['query'],
  },
})

export const VISIT_TOOL = Object.freeze({
  name: 'visit',
  description: VISIT_TOOL_DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: {
      ref: { type: 'string', minLength: 1, description: 'A result letter from search() (like "a"), or a full URL.' },
      page: { type: 'integer', minimum: 1, description: 'Which part of a long page to read. Defaults to 1.' },
    },
    required: ['ref'],
  },
})

export const WEB_TOOLS = Object.freeze([SEARCH_TOOL, VISIT_TOOL])
export const WEB_TOOL_NAMES = new Set(['search', 'visit'])

// ---------------------------------------------------------------------------
// Text helpers

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•',
  deg: '°', times: '×', euro: '€', pound: '£', yen: '¥',
}

export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s ?? ''
  return s.replace(/&(#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (m, _all, hex, dec, name) => {
    try {
      if (hex) return String.fromCodePoint(parseInt(hex, 16))
      if (dec) return String.fromCodePoint(parseInt(dec, 10))
      const v = NAMED_ENTITIES[name?.toLowerCase()]
      return v !== undefined ? v : m
    } catch {
      return m
    }
  })
}

// A tag may carry `>` inside a quoted attribute (Wikipedia's data-mw JSON
// does), so the naive /<[^>]*>/ leaks attribute text into the page body.
const TAG_RE = /<(?:"[^"]*"|'[^']*'|[^'">])*>/g

export function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(TAG_RE, ' ')).replace(/\s+/g, ' ').trim()
}

export function clip(s, n) {
  const t = String(s ?? '').trim()
  if (t.length <= n) return t
  // Cut on a word boundary when one is close, so a clipped title still reads.
  const cut = t.slice(0, n - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…'
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * HTML -> readable text. Deliberately regex-based (no parser dependency):
 * drop the non-content subtrees, prefer <main>/<article> when it carries
 * real text, turn block boundaries into newlines, strip the rest, decode.
 */
export function htmlToText(html) {
  let s = String(html ?? '')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|svg|template|iframe|canvas|video|audio|object)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  // Prefer the main content region when it is substantial.
  const region = pickContentRegion(s)
  s = region ?? s
  s = s.replace(/<(nav|header|footer|aside|form|button|select|dialog|menu)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  s = s.replace(/<(li|dt)\b[^>]*>/gi, '\n- ')
  s = s.replace(/<(h[1-6])\b[^>]*>/gi, '\n\n')
  s = s.replace(/<\/(h[1-6]|p|div|section|article|main|blockquote|pre|tr|table|ul|ol|dl|dd|figure|figcaption|details|summary)\s*>/gi, '\n')
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
  s = s.replace(/<\/(td|th)\s*>/gi, ' | ')
  s = s.replace(TAG_RE, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t ]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function pickContentRegion(s) {
  for (const tag of ['article', 'main']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i')
    const m = re.exec(s)
    if (m && stripTags(m[1]).length >= 400) return m[1]
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(s)
  return body ? body[1] : null
}

export function titleOf(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html ?? ''))
  return m ? stripTags(m[1]) : ''
}

// ---------------------------------------------------------------------------
// Labels: a..z, then aa, ab, ... Session-wide, never reused, so a visit(ref)
// from an earlier turn still resolves.

export function labelFor(index) {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

// ---------------------------------------------------------------------------
// URL safety (visit only): http(s), no credentials, no loopback / link-local
// / RFC1918 literals. Redirects are followed manually so every hop is
// re-checked. DNS rebinding is out of scope for a companion's page reads.

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
]

export function assertPublicHttpUrl(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error('not a valid URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https pages can be read')
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed')
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('local addresses cannot be read')
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_V4.some((re) => re.test(host))) throw new Error('private addresses cannot be read')
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host) || host.startsWith('::ffff:')) {
      throw new Error('private addresses cannot be read')
    }
  }
  return u
}

export function normalizeUserUrl(ref) {
  const t = String(ref ?? '').trim()
  if (/^https?:\/\//i.test(t)) return t
  // "example.com/page" style: no scheme, no spaces, has a dot.
  if (!/\s/.test(t) && /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(t)) return `https://${t}`
  return null
}

// ---------------------------------------------------------------------------
// Fetch with timeout, size cap, manual redirects, and an optional outer signal.

async function fetchCapped(fetchImpl, url, { headers, method = 'GET', body, signal, timeoutMs, maxBytes, maxRedirects, validate } = {}) {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (validate) validate(current)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
    const onOuter = () => ctrl.abort(signal?.reason ?? new Error('aborted'))
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw signal.reason ?? new Error('aborted') }
      signal.addEventListener('abort', onOuter, { once: true })
    }
    try {
      const res = await fetchImpl(current, { method, headers, body, signal: ctrl.signal, redirect: 'manual' })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) throw new Error(`redirect without location (${res.status})`)
        current = new URL(loc, current).toString()
        try { await res.body?.cancel?.() } catch {}
        continue
      }
      const text = await readCapped(res, maxBytes)
      return { res, text, url: current }
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onOuter)
    }
  }
  throw new Error('too many redirects')
}

async function readCapped(res, maxBytes) {
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len && len > maxBytes * 4) throw new Error('page too large')
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text()
    return t.length > maxBytes ? t.slice(0, maxBytes) : t
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total >= maxBytes) {
      try { await reader.cancel() } catch {}
      break
    }
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  const ct = res.headers.get('content-type') ?? ''
  const cs = /charset=([\w-]+)/i.exec(ct)?.[1]
  try {
    return new TextDecoder(cs || 'utf-8', { fatal: false }).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

// ---------------------------------------------------------------------------
// Search providers. Each: (query, ctx) -> [{ title, url, snippet }]. Throw on
// anything that is not a real answer (challenge page, HTTP error, empty
// scrape of a page that clearly has results) so the chain moves on.

const providers = {
  async brave(q, ctx) {
    const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${ctx.limits.maxResults}`
    const { res, text } = await ctx.get(u, { headers: { Accept: 'application/json', 'X-Subscription-Token': ctx.apiKey } })
    if (!res.ok) throw new Error(`brave http ${res.status}`)
    const j = JSON.parse(text)
    return (j?.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: stripTags(r.description) }))
  },

  async tavily(q, ctx) {
    const { res, text } = await ctx.post('https://api.tavily.com/search', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
      body: JSON.stringify({ query: q, max_results: ctx.limits.maxResults, include_answer: false }),
    })
    if (!res.ok) throw new Error(`tavily http ${res.status}`)
    const j = JSON.parse(text)
    return (j?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }))
  },

  async serper(q, ctx) {
    const { res, text } = await ctx.post('https://google.serper.dev/search', {
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': ctx.apiKey },
      body: JSON.stringify({ q, num: ctx.limits.maxResults }),
    })
    if (!res.ok) throw new Error(`serper http ${res.status}`)
    const j = JSON.parse(text)
    return (j?.organic ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }))
  },

  async ddg(q, ctx) {
    const { res, text } = await ctx.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    })
    if (!res.ok && res.status !== 202) throw new Error(`ddg http ${res.status}`)
    const out = parseDdgHtml(text)
    if (out.length === 0) throw new Error(/bots use DuckDuckGo|challenge|anomaly/i.test(text) ? 'ddg challenge' : 'ddg no results')
    return out
  },

  async bing(q, ctx) {
    const { res, text } = await ctx.get(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    })
    if (!res.ok) throw new Error(`bing http ${res.status}`)
    const out = parseBingHtml(text)
    if (out.length === 0) throw new Error('bing no results')
    return out
  },

  async wikipedia(q, ctx) {
    const u = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srprop=snippet&srlimit=${ctx.limits.maxResults}&srsearch=${encodeURIComponent(q)}`
    const { res, text } = await ctx.get(u, { headers: { Accept: 'application/json', 'User-Agent': 'SeiCompanion/1.0 (https://sei.gg)' } })
    if (!res.ok) throw new Error(`wikipedia http ${res.status}`)
    const j = JSON.parse(text)
    return (j?.query?.search ?? []).map((r) => ({
      title: r.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, '_'))}`,
      snippet: stripTags(r.snippet),
    }))
  },
}

export function parseDdgHtml(html) {
  const out = []
  const s = String(html ?? '')
  // One block per organic result; ads carry a different class and no result__a.
  const blocks = s.split(/<div class="result results_links/i).slice(1)
  for (const blk of blocks) {
    const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(blk) ??
      /<a[^>]*href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i.exec(blk)
    if (!a) continue
    let url = decodeEntities(a[1])
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) {
      try { url = decodeURIComponent(uddg[1]) } catch {}
    } else if (url.startsWith('//')) {
      url = `https:${url}`
    }
    if (!/^https?:\/\//i.test(url)) continue
    if (/duckduckgo\.com\/y\.js/i.test(url)) continue // ad slot
    const sn = /<(a|div)[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/\1>/i.exec(blk)
    out.push({ title: stripTags(a[2]), url, snippet: sn ? stripTags(sn[2]) : '' })
    if (out.length >= 10) break
  }
  return out
}

export function parseBingHtml(html) {
  const out = []
  const s = String(html ?? '')
  const blocks = s.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) ?? []
  for (const blk of blocks) {
    const h = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(blk)
    if (!h) continue
    let url = decodeEntities(h[1])
    const packed = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(url)
    if (packed) {
      try {
        url = Buffer.from(packed[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      } catch {}
    }
    if (!/^https?:\/\//i.test(url)) {
      const cite = /<cite>([\s\S]*?)<\/cite>/i.exec(blk)
      const c = cite ? stripTags(cite[1]) : ''
      if (/^https?:\/\//i.test(c)) url = c
      else continue
    }
    const p = /<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(blk) ?? /<p[^>]*>([\s\S]*?)<\/p>/i.exec(blk)
    out.push({ title: stripTags(h[2]), url, snippet: p ? stripTags(p[1]) : '' })
    if (out.length >= 10) break
  }
  return out
}

/**
 * Scraped engines occasionally answer a DIFFERENT query than the one sent
 * (Bing from a flagged egress returned dictionary entries for "latent" when
 * asked about the Latent Space podcast). API providers do not do this, so the
 * gate applies to ddg/bing only: with two or more significant query words, at
 * least one result must carry two of them, else the scrape is treated as a
 * miss and the chain moves on.
 */
export function looksRelevant(results, query) {
  const words = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])]
  if (words.length < 2) return results.length > 0
  return results.some((r) => {
    const hay = `${r.title ?? ''} ${r.snippet ?? ''} ${r.url ?? ''}`.toLowerCase()
    let hits = 0
    for (const w of words) if (hay.includes(w)) hits++
    return hits >= 2
  })
}

const SCRAPED_PROVIDERS = new Set(['ddg', 'bing'])

export function providerChain(provider, apiKey) {
  const p = WEB_PROVIDERS.includes(provider) ? provider : 'auto'
  const keyless = ['ddg', 'bing', 'wikipedia']
  if (KEYED_PROVIDERS.has(p)) return apiKey ? [p, ...keyless] : keyless
  if (p === 'auto') return keyless
  return p === 'wikipedia' ? ['wikipedia'] : [p, 'wikipedia']
}

// ---------------------------------------------------------------------------
// The session: label table + per-turn budget + the two tool bodies.

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   provider?: string,
 *   apiKey?: string,
 *   logger?: { info?: Function, warn?: Function, debug?: Function } | null,
 *   limits?: Partial<typeof DEFAULT_LIMITS>,
 * }} [opts]
 */
export function createWebSession({ fetchImpl, provider = 'auto', apiKey = '', logger = null, limits = {} } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits }
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('createWebSession: no fetch available')
  const refs = new Map() // label -> { url, title, host }
  let callsThisTurn = 0
  let lastProvider = null

  const ctx = {
    limits: L,
    apiKey,
    get(url, opts = {}) {
      return fetchCapped(doFetch, url, { ...opts, timeoutMs: L.fetchTimeoutMs, maxBytes: L.maxBodyBytes, maxRedirects: L.maxRedirects })
    },
    post(url, opts = {}) {
      return fetchCapped(doFetch, url, { ...opts, method: 'POST', timeoutMs: L.fetchTimeoutMs, maxBytes: L.maxBodyBytes, maxRedirects: 0 })
    },
  }

  function addRef(r) {
    const label = labelFor(refs.size)
    refs.set(label, { url: r.url, title: r.title, host: hostOf(r.url) })
    return label
  }

  function beginTurn() {
    callsThisTurn = 0
  }

  function overBudget() {
    return L.maxCallsPerTurn > 0 && callsThisTurn >= L.maxCallsPerTurn
  }

  async function search(query, { signal } = {}) {
    const q = String(query ?? '').trim().replace(/\s+/g, ' ').slice(0, 200)
    if (!q) return { content: 'search: empty query', is_error: true }
    const chain = providerChain(provider, apiKey)
    const errors = []
    for (const name of chain) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      try {
        const raw = await providers[name](q, { ...ctx, signal })
        if (SCRAPED_PROVIDERS.has(name) && !looksRelevant(raw, q)) throw new Error(`${name} answered a different query`)
        const seen = new Set()
        const results = []
        for (const r of raw) {
          if (!r?.url || !/^https?:\/\//i.test(r.url)) continue
          const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '')
          if (seen.has(key)) continue
          seen.add(key)
          results.push(r)
          if (results.length >= L.maxResults) break
        }
        if (results.length === 0) throw new Error(`${name} no results`)
        lastProvider = name
        const lines = results.map((r) => {
          const label = addRef(r)
          const host = hostOf(r.url)
          const snippet = clip(r.snippet, L.snippetChars)
          return `${label}. ${clip(r.title || host || r.url, L.titleChars)}${host ? ` (${host})` : ''}${snippet ? ` - ${snippet}` : ''}`
        })
        return { content: `results for "${q}":\n${lines.join('\n')}`, is_error: false }
      } catch (err) {
        if (signal?.aborted) throw err
        errors.push(`${name}: ${err?.message ?? err}`)
        logger?.debug?.(`[sei/web] search via ${name} failed: ${err?.message ?? err}`)
      }
    }
    logger?.warn?.(`[sei/web] search failed on every provider: ${errors.join('; ')}`)
    return { content: 'search failed: no search service answered. Tell the player you could not look it up right now.', is_error: true }
  }

  function resolveRef(ref) {
    const t = String(ref ?? '').trim()
    const label = t.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
    if (refs.has(label)) return { ...refs.get(label), label }
    const url = normalizeUserUrl(t)
    if (url) return { url, title: '', host: hostOf(url), label: null }
    return null
  }

  async function visit(ref, { page = 1, signal } = {}) {
    let target = resolveRef(ref)
    if (!target) {
      const known = [...refs.keys()]
      return {
        content: known.length
          ? `visit: unknown ref "${ref}". Use a result letter (${known.slice(-L.maxResults).join(', ')}) or a full URL.`
          : `visit: unknown ref "${ref}". Call search() first, then pass a result letter, or pass a full URL.`,
        is_error: true,
      }
    }
    let url
    try {
      url = assertPublicHttpUrl(target.url).toString()
    } catch (err) {
      return { content: `visit: ${err.message}`, is_error: true }
    }
    const pageNo = Math.max(1, Math.floor(Number(page) || 1))
    let fetched
    try {
      fetched = await ctx.get(url, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' },
        signal,
        validate: (u) => assertPublicHttpUrl(u),
      })
    } catch (err) {
      if (signal?.aborted) throw err
      const msg = /timeout/i.test(String(err?.message)) ? 'timed out' : (err?.message ?? 'fetch failed')
      return { content: `visit: could not load ${target.host || url} (${msg})`, is_error: true }
    }
    const { res, text } = fetched
    // Name the page by where it actually landed (a redirect to a docs host or
    // a mirror is the honest answer), never by the pre-redirect URL.
    if (fetched.url && fetched.url !== url) target = { ...target, host: hostOf(fetched.url) || target.host }
    if (!res.ok) return { content: `visit: ${target.host || url} answered HTTP ${res.status}`, is_error: true }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    let body
    let title = target.title
    if (ct.includes('html') || ct === '' || /^\s*<(!doctype|html)/i.test(text.slice(0, 200))) {
      body = htmlToText(text)
      title = titleOf(text) || title
    } else if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml')) {
      body = String(text).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    } else {
      return { content: `visit: ${target.host || url} is ${ct.split(';')[0] || 'binary'}, not a readable page.`, is_error: true }
    }
    if (!body) return { content: `visit: ${target.host || url} has no readable text.`, is_error: true }
    if (body.length < 600 && /client challenge|just a moment|enable javascript|access denied|verify you are human|are you a robot/i.test(body)) {
      return { content: `visit: ${target.host || url} blocks automated readers. Try another result.`, is_error: true }
    }
    const totalPages = Math.max(1, Math.ceil(body.length / L.pageChars))
    if (pageNo > totalPages) return { content: `visit: ${target.host || url} has only ${totalPages} page${totalPages === 1 ? '' : 's'}.`, is_error: true }
    const slice = body.slice((pageNo - 1) * L.pageChars, pageNo * L.pageChars)
    const head = `${target.label ? `[${target.label}] ` : ''}${target.host || url}${title ? ` - ${clip(title, L.titleChars)}` : ''}` +
      (totalPages > 1 ? ` (part ${pageNo}/${totalPages}${pageNo < totalPages ? `, page: ${pageNo + 1} for more` : ''})` : '')
    return { content: `${head}\n${slice}`, is_error: false }
  }

  /**
   * One entry point for every surface: dispatch a tool_use by name and get
   * back { content, is_error } ready to wrap in a tool_result block. Enforces
   * the per-turn budget so a curious model cannot spin the loop forever.
   */
  async function runTool(name, input, { signal } = {}) {
    if (!WEB_TOOL_NAMES.has(name)) throw new Error(`webSession.runTool: not a web tool: ${name}`)
    if (overBudget()) {
      return { content: `${name}: no more web lookups this turn. Answer with what you have.`, is_error: true }
    }
    callsThisTurn++
    if (name === 'search') return search(input?.query, { signal })
    return visit(input?.ref, { page: input?.page, signal })
  }

  return {
    tools: WEB_TOOLS,
    search,
    visit,
    runTool,
    beginTurn,
    overBudget,
    refs,
    get lastProvider() { return lastProvider },
    get callsThisTurn() { return callsThisTurn },
  }
}

export function isWebTool(name) {
  return WEB_TOOL_NAMES.has(name)
}
