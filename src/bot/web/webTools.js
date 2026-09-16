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
// This file has no mineflayer import and no static Electron import: the only
// Electron touch is the OPTIONAL dynamic `import('electron')` inside
// `electronFetchProvider`, which fails soft under plain Node. That keeps it
// importable by the bot (raw ESM, asar-unpacked), Electron main (bundled by
// electron-vite) and the test runner alike. Keep it that way.

const DEFAULT_LIMITS = Object.freeze({
  maxResults: 5,
  titleChars: 70,
  snippetChars: 150,
  pageChars: 2400,
  fetchTimeoutMs: 8000,
  // The keyless search chain (DDG -> Bing -> Wikipedia) runs SEQUENTIALLY,
  // so on a network that blackholes the scrapers every search used to wait
  // fetchTimeoutMs per engine (~16 s). Search endpoints get a shorter clock;
  // visit keeps fetchTimeoutMs (a page read is one fetch, and worth waiting).
  searchTimeoutMs: 4000,
  maxBodyBytes: 1_500_000,
  maxCallsPerTurn: 6,
  maxRedirects: 5,
})

export const WEB_PROVIDERS = Object.freeze(['auto', 'brave', 'tavily', 'serper', 'ddg', 'bing', 'wikipedia'])
export const KEYED_PROVIDERS = new Set(['brave', 'tavily', 'serper'])

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * Which transport to use. Electron's `net` rides the Chromium network stack:
 * browser TLS fingerprint (so Cloudflare-fronted wikis and DuckDuckGo answer
 * where Node's undici gets a 403 / challenge page, measured 260909), OS proxy
 * honored. It is available in main AND in the bot's utilityProcess.
 *
 * 260917: this used to hand back `net.fetch` with redirects FOLLOWED and the
 * final `res.url` gated. Two things made that a hole: `net.fetch` returns a
 * constructed Response whose `.url` is '' (electron.d.ts documents `.url` as
 * incorrect), so the post-fetch gate compared '' to the request URL and never
 * ran; and `net.fetch` cannot do `redirect: 'manual'` (it attaches no
 * 'redirect' listener, so a manual redirect is cancelled). A public URL that
 * 302'd to 127.0.0.1 / 169.254.169.254 / a LAN host had its body returned to
 * the model. The provider is now built on `net.request({redirect:'manual'})`,
 * whose 'redirect' event lets the caller's URL gate run on EVERY hop before
 * `followRedirect()` (see `createNetRequester`). Plain Node (tests, scripts)
 * falls back to global fetch with the manual-redirect loop in `fetchCapped`.
 *
 * Shape: `{ request, kind }` (Electron) or `{ fetch, manualRedirects, kind }`
 * (Node). `fetchCapped` accepts either.
 */
export async function electronFetchProvider() {
  try {
    const m = await import('electron')
    const net = m?.net ?? m?.default?.net
    if (net && typeof net.request === 'function') return { request: createNetRequester(net), kind: 'electron' }
  } catch {}
  return { fetch: globalThis.fetch, manualRedirects: true, kind: 'node' }
}

/**
 * A `request(url, init, guard)` over Electron's `net.request` (ClientRequest,
 * https://electronjs.org/docs/api/client-request). Exported so tests can
 * drive it with a fake `net`. Contract, mirroring `fetchCapped`'s Node path:
 *   - `guard.validate(url)` runs on the initial URL and, in the 'redirect'
 *     event, on every redirect target BEFORE `followRedirect()`. A throwing
 *     gate aborts the request; nothing past the redirect is ever read.
 *   - hops are counted against `guard.maxRedirects` (too many = reject).
 *   - `followRedirect()` is called SYNCHRONOUSLY inside the event, which is
 *     what Electron requires (an unanswered 'redirect' cancels the request).
 *   - the body is collected up to `guard.maxBytes` then the request is
 *     aborted; `guard.timeoutMs` and `guard.signal` both abort it and reject
 *     with 'timeout' / the signal's reason, the same errors the Node path
 *     surfaces.
 * Resolves `{ res: { status, ok, headers.get() }, text, url }` where `url` is
 * where the chain actually landed.
 */
export function createNetRequester(net) {
  return function request(url, { method = 'GET', headers = {}, body } = {}, { validate, maxRedirects = 5, maxBytes = Infinity, signal, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      try { if (validate) validate(url) } catch (err) { reject(err); return }
      if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
      let settled = false
      let hops = 0
      let current = url
      let req = null
      const chunks = []
      let total = 0
      const onOuter = () => fail(signal?.reason ?? new Error('aborted'))
      const timer = timeoutMs > 0 ? setTimeout(() => fail(new Error('timeout')), timeoutMs) : null
      if (signal) signal.addEventListener('abort', onOuter, { once: true })
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onOuter)
      }
      const abortReq = () => { try { req?.abort() } catch {} }
      const fail = (err) => {
        if (settled) return
        settled = true
        cleanup()
        abortReq()
        reject(err)
      }
      try {
        req = net.request({ url, method, redirect: 'manual' })
      } catch (err) {
        fail(err)
        return
      }
      for (const [k, v] of Object.entries(headers ?? {})) {
        if (v === undefined || v === null) continue
        try { req.setHeader(k, String(v)) } catch {}
      }
      req.on('redirect', (_status, _method, redirectUrl) => {
        if (settled) return
        hops += 1
        if (hops > maxRedirects) { fail(new Error('too many redirects')); return }
        let next
        try {
          next = new URL(redirectUrl, current).toString()
          if (validate) validate(next)
        } catch (err) {
          fail(err)
          return
        }
        current = next
        try { req.followRedirect() } catch (err) { fail(err) }
      })
      req.on('error', (err) => fail(err ?? new Error('request failed')))
      req.on('response', (res) => {
        if (settled) return
        const status = Number(res.statusCode)
        const get = headerGetter(res.headers)
        const len = Number(get('content-length') ?? 0)
        if (len && len > maxBytes * 4) { fail(new Error('page too large')); return }
        const done = () => {
          if (settled) return
          settled = true
          cleanup()
          const buf = concatChunks(chunks, total)
          const text = decodeBody(buf, get('content-type'))
          resolve({ res: { status, ok: status >= 200 && status < 300, headers: { get } }, text, url: current })
          // Past the cap: stop the transfer now that the promise has its bytes.
          if (total >= maxBytes) abortReq()
        }
        res.on('data', (chunk) => {
          if (settled) return
          const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
          chunks.push(u8)
          total += u8.byteLength
          if (total >= maxBytes) done()
        })
        res.on('end', done)
        res.on('error', (err) => fail(err ?? new Error('response failed')))
        res.on('aborted', () => fail(new Error('aborted')))
      })
      if (body !== undefined && body !== null) req.end(typeof body === 'string' ? body : Buffer.from(body))
      else req.end()
    })
  }
}

/** Electron's `IncomingMessage.headers` is a lowercase record of string | string[]. */
function headerGetter(headers) {
  const h = headers ?? {}
  return (name) => {
    const v = h[String(name).toLowerCase()]
    if (v === undefined || v === null) return null
    return Array.isArray(v) ? v.join(', ') : String(v)
  }
}

/**
 * Game wikis searched DIRECTLY through their MediaWiki API when the query
 * names the game (and always for `alwaysWikiHosts`, e.g. the Minecraft bot).
 * The API answers from any network (the HTML pages sit behind Cloudflare),
 * ranks by the wiki's own index, and `visit` on these hosts reads the page
 * through `action=parse`, which is cleaner than the rendered HTML. Fextralife
 * (Elden Ring etc.) is not MediaWiki and is deliberately absent.
 */
export const GAME_WIKIS = Object.freeze([
  { name: 'Minecraft Wiki', host: 'minecraft.wiki', articlePath: '/w/', apiPath: '/api.php', match: /\bminecraft\b|\bmc\b|\bnether(ite)?\b|\bredstone\b|\bcreeper\b|\bender(man| dragon)?\b/i },
  { name: 'VALORANT Wiki', host: 'valorant.fandom.com', articlePath: '/wiki/', apiPath: '/api.php', match: /\bvalorant\b|\bvandal\b|\bphantom\b|\bradiant\b|\bagents?\b.*\b(riot|valorant)\b/i },
  { name: 'League of Legends Wiki', host: 'wiki.leagueoflegends.com', articlePath: '/en-us/', apiPath: '/en-us/api.php', match: /\bleague of legends\b|\blol\b|\bsummoner'?s rift\b/i },
  { name: 'Terraria Wiki', host: 'terraria.wiki.gg', articlePath: '/wiki/', apiPath: '/api.php', match: /\bterraria\b/i },
  { name: 'Stardew Valley Wiki', host: 'stardewvalleywiki.com', articlePath: '/', apiPath: '/mediawiki/api.php', match: /\bstardew\b/i },
  { name: 'Old School RuneScape Wiki', host: 'oldschool.runescape.wiki', articlePath: '/w/', apiPath: '/api.php', match: /\bosrs\b|\bold ?school runescape\b/i },
  { name: 'RuneScape Wiki', host: 'runescape.wiki', articlePath: '/w/', apiPath: '/api.php', match: /\brunescape\b(?!.*old ?school)/i },
  { name: 'Fortnite Wiki', host: 'fortnite.fandom.com', articlePath: '/wiki/', apiPath: '/api.php', match: /\bfortnite\b/i },
  { name: 'Genshin Impact Wiki', host: 'genshin-impact.fandom.com', articlePath: '/wiki/', apiPath: '/api.php', match: /\bgenshin\b/i },
  { name: 'Honkai: Star Rail Wiki', host: 'honkai-star-rail.fandom.com', articlePath: '/wiki/', apiPath: '/api.php', match: /\bstar rail\b|\bhsr\b/i },
  { name: 'Hollow Knight Wiki', host: 'hollowknight.wiki', articlePath: '/w/', apiPath: '/api.php', match: /\bhollow knight\b|\bsilksong\b/i },
  { name: 'Bulbapedia', host: 'bulbapedia.bulbagarden.net', articlePath: '/wiki/', apiPath: '/w/api.php', match: /\bpok[eé]mon\b/i },
  { name: 'Zelda Wiki', host: 'zeldawiki.wiki', articlePath: '/wiki/', apiPath: '/api.php', match: /\bzelda\b|\btears of the kingdom\b|\bbreath of the wild\b/i },
  { name: 'Factorio Wiki', host: 'wiki.factorio.com', articlePath: '/', apiPath: '/api.php', match: /\bfactorio\b/i },
  { name: 'Roblox Wiki', host: 'roblox.fandom.com', articlePath: '/wiki/', apiPath: '/api.php', match: /\broblox\b/i },
  { name: 'Counter-Strike Wiki', host: 'counterstrike.fandom.com', articlePath: '/wiki/', apiPath: '/api.php', match: /\bcounter-?strike\b|\bcs2\b|\bcs:?go\b/i },
  { name: 'Overwatch Wiki', host: 'overwatch.fandom.com', articlePath: '/wiki/', apiPath: '/api.php', match: /\boverwatch\b/i },
  { name: 'Apex Legends Wiki', host: 'apexlegends.fandom.com', articlePath: '/wiki/', apiPath: '/api.php', match: /\bapex legends\b|\bapex\b.*\blegend/i },
  { name: 'Deep Rock Galactic Wiki', host: 'deeprockgalactic.wiki.gg', articlePath: '/wiki/', apiPath: '/api.php', match: /\bdeep rock\b/i },
  { name: 'Wikipedia', host: 'en.wikipedia.org', articlePath: '/wiki/', apiPath: '/w/api.php', match: null },
])

export function wikiFor(host) {
  const h = String(host ?? '').toLowerCase().replace(/^www\./, '')
  return GAME_WIKIS.find((w) => w.host === h) ?? null
}

/** Registry entries whose `match` fires on the query (Wikipedia never does). */
export function wikisForQuery(query) {
  const q = String(query ?? '')
  return GAME_WIKIS.filter((w) => w.match && w.match.test(q))
}

/** Page title from a wiki article URL, or null when the path is not an article. */
export function wikiTitleFromUrl(url, wiki) {
  let u
  try { u = new URL(url) } catch { return null }
  const paths = wiki ? [wiki.articlePath] : ['/wiki/', '/w/']
  for (const ap of paths) {
    if (ap === '/' ) {
      const seg = u.pathname.slice(1)
      if (!seg || seg.includes('/') || seg.endsWith('.php')) continue
      return safeDecode(seg).replace(/_/g, ' ')
    }
    if (u.pathname.startsWith(ap) && u.pathname.length > ap.length) {
      const rest = u.pathname.slice(ap.length)
      if (rest.endsWith('.php') || rest.startsWith('Special:')) return null
      return safeDecode(rest).replace(/_/g, ' ')
    }
  }
  return null
}

function safeDecode(s) {
  try { return decodeURIComponent(s) } catch { return s }
}

export function wikiArticleUrl(wiki, title) {
  return `https://${wiki.host}${wiki.articlePath}${encodeURIComponent(String(title).replace(/ /g, '_')).replace(/%3A/g, ':').replace(/%2F/g, '/')}`
}

export const SEARCH_TOOL_DESCRIPTION =
  'Search the web. Returns a few lettered results (a, b, c...) with a title and a short snippet each. ' +
  'Use it when the player asks about something you are not sure of, or when a fact, a recipe, a date, a price or a name matters and guessing would be worse than checking. ' +
  'Call visit(ref) with a result letter to read the page itself. Search results are private to you; tell the player what you learned in your own words. ' +
  'Name the game in the query ("valorant vandal damage", "minecraft tame fox"): known game wikis are searched directly. ' +
  'For anything recent (latest version, patch notes, current holder of a role) visit a result; snippets can be stale. ' +
  'Before searching, let the player know (say() in the game, your reply text in chat).'

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

/**
 * 260909: on an Anthropic-backed session (cloud proxy or Anthropic BYOK) the
 * search is Anthropic's own server-side tool instead of ours: Brave-backed,
 * runs inside the same response (the model searches, reads, and answers in
 * one turn), no scraping, no key, and no network dependence on the user's
 * machine. `web_search_20250305` is the variant Haiku 4.5 supports. Our
 * `visit` still rides along for reading a specific page. Every other
 * provider gets our `search` + `visit` pair. Per-request cap of 3 searches
 * (each is billed by Anthropic at their per-search rate on top of tokens).
 */
export const SERVER_WEB_SEARCH_TOOL = Object.freeze({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 })

export function isServerWebBlock(type) {
  return type === 'server_tool_use' || type === 'web_search_tool_result'
}

/** Tools for a surface: native server search when the provider has it, else ours. */
export function webToolsFor({ serverWebSearch }) {
  return serverWebSearch ? [SERVER_WEB_SEARCH_TOOL, VISIT_TOOL] : [...WEB_TOOLS]
}

/**
 * Split a response's text around a server-side search: what the model wrote
 * BEFORE its first web_search call ("lemme check") versus after (the answer).
 * Text blocks joined with a space, trimmed. Empty strings when absent.
 */
export function splitTextAroundServerSearch(content) {
  const blocks = Array.isArray(content) ? content : []
  const first = blocks.findIndex((b) => b?.type === 'server_tool_use')
  const textOf = (arr) => arr.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text.trim()).filter(Boolean).join(' ').trim()
  if (first < 0) return { before: '', after: textOf(blocks), searched: false }
  return { before: textOf(blocks.slice(0, first)), after: textOf(blocks.slice(first)), searched: true }
}

// The "Before searching, let the player know" cue lives as literal text in
// both surface baselines (promptLibrary.js CHAT_BASELINE / MINECRAFT_BASELINE):
// that module must stay import-free for scripts/lib/promptLibraryEdit.

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
  // Reference chrome that survives tag stripping and reads as noise to the
  // model: MediaWiki "[ edit ]" links, "[ 12 ]" citation markers, and the
  // bare "|" cell separators an infobox leaves behind.
  s = s.replace(/\[ ?(edit|citation needed) ?\]/gi, '')
  s = s.replace(/\[ ?\d{1,3} ?\]/g, '')
  s = s.replace(/\u200b/g, '')
  s = s.replace(/^\|\s*$/gm, '')
  s = s.replace(/ *\| *\n/g, '\n')
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
// / RFC1918 literals. Every redirect hop is re-checked before it is followed
// (Electron: the 'redirect' event in createNetRequester; Node: the manual
// loop in fetchCapped). DNS rebinding is out of scope for a companion's page
// reads.

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
// `impl` is a transport object: `{ request }` (Electron net.request, every
// hop gated inside the request) or `{ fetch, manualRedirects }` (Node: this
// loop is the redirect follower). A bare function is treated as a manual-
// redirect fetch.

async function fetchCapped(impl, url, { headers, method = 'GET', body, signal, timeoutMs, maxBytes, maxRedirects, validate, manualRedirects } = {}) {
  if (typeof impl === 'function') impl = { fetch: impl, manualRedirects: true }
  if (typeof impl?.request === 'function') {
    return impl.request(url, { method, headers, body }, { validate, maxRedirects, maxBytes, signal, timeoutMs })
  }
  const fetchImpl = impl?.fetch
  if (typeof fetchImpl !== 'function') throw new Error('no fetch available')
  const manual = manualRedirects ?? impl.manualRedirects ?? true
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
      const res = await fetchImpl(current, { method, headers, body, signal: ctrl.signal, redirect: manual ? 'manual' : 'follow' })
      if (!manual && validate) {
        // The transport followed the chain for us: gate where it landed. An
        // EMPTY res.url is "unknown", not "no redirect" (Electron's net.fetch
        // reports '' for every response), and an unknown landing cannot pass
        // a gate, so it is refused rather than trusted.
        if (!res.url) {
          try { await res.body?.cancel?.() } catch {}
          throw new Error('redirect target unknown (the transport did not report the final URL)')
        }
        if (res.url !== current) {
          validate(res.url)
          current = res.url
        }
      } else if (!manual && res.url && res.url !== current) {
        current = res.url
      }
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
  return decodeBody(concatChunks(chunks, total), res.headers.get('content-type'))
}

function concatChunks(chunks, total) {
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return buf
}

function decodeBody(buf, contentType) {
  const cs = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]
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
 * miss and the chain moves on. Stop words are ignored so "who is Shawn Wang"
 * is judged on shawn + wang.
 */
const STOP_WORDS = new Set(['who', 'what', 'when', 'where', 'why', 'how', 'the', 'and', 'for', 'are', 'was', 'were', 'does', 'did', 'this', 'that', 'with', 'from', 'about', 'into', 'you', 'your', 'can', 'will', 'has', 'have', 'had', 'not', 'but', 'his', 'her', 'its', 'their', 'them', 'they', 'she', 'him', 'best', 'top', 'get', 'make', 'much', 'many', 'any', 'all', 'more', 'most', 'some', 'there', 'than', 'then', 'out', 'over'])
export function looksRelevant(results, query) {
  const words = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOP_WORDS.has(w))
  if (words.length < 2) return results.length > 0
  return results.some((r) => {
    const hay = `${r.title ?? ''} ${r.snippet ?? ''} ${r.url ?? ''}`.toLowerCase()
    let hits = 0
    for (const w of words) if (hay.includes(w)) hits++
    return hits >= 2
  })
}

// Keyless providers: the scrapers can answer a different query, and Wikipedia's
// full-text search matches each word separately ("who is Shawn Wang" returned
// Shawn Hatosy and Wang Cong). API providers rank properly and skip the gate.
const KEYLESS_PROVIDERS = new Set(['ddg', 'bing', 'wikipedia'])

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
 *   fetchProvider?: (() => Promise<{ fetch?: typeof fetch, manualRedirects?: boolean, request?: Function, kind?: string }>) | null,
 *   manualRedirects?: boolean,
 *   provider?: string,
 *   apiKey?: string,
 *   logger?: { info?: Function, warn?: Function, debug?: Function } | null,
 *   limits?: Partial<typeof DEFAULT_LIMITS>,
 *   alwaysWikiHosts?: string[],
 * }} [opts]
 */
export function createWebSession({ fetchImpl, fetchProvider = null, manualRedirects = true, provider = 'auto', apiKey = '', logger = null, limits = {}, alwaysWikiHosts = [] } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits }
  // Either a plain fetch (tests, scripts) or an async provider resolved on
  // first use ({ request } or { fetch, manualRedirects }; see
  // electronFetchProvider).
  let impl = fetchImpl ? { fetch: fetchImpl, manualRedirects } : null
  if (!impl && !fetchProvider) impl = { fetch: globalThis.fetch, manualRedirects: true }
  if (impl && typeof impl.fetch !== 'function') throw new Error('createWebSession: no fetch available')
  const resolveImpl = async () => {
    if (!impl) {
      impl = await fetchProvider()
      if (typeof impl?.request !== 'function' && typeof impl?.fetch !== 'function') throw new Error('createWebSession: fetch provider returned no transport')
      logger?.info?.(`[sei/web] fetch via ${impl.kind ?? 'custom'}`)
    }
    return impl
  }
  const refs = new Map() // label -> { url, title, host }
  let callsThisTurn = 0
  let lastProvider = null
  // A DuckDuckGo challenge means this address is being rate-limited; asking
  // again a few seconds later only extends it. Skip DDG for a while. A
  // TIMEOUT arms the same cooldown (260917): a network that blackholes the
  // scrapers used to cost the full clock on every search, every time. Bing
  // gets its own clock for the same reason.
  let ddgBlockedUntil = 0
  let bingBlockedUntil = 0
  const ENGINE_COOLDOWN_MS = 90_000
  const BLOCKING_FAILURE = /challenge|timeout/i
  const alwaysWikis = (alwaysWikiHosts ?? []).map(wikiFor).filter(Boolean)

  const ctx = {
    limits: L,
    apiKey,
    async get(url, opts = {}) {
      const transport = await resolveImpl()
      return fetchCapped(transport, url, { ...opts, timeoutMs: opts.timeoutMs ?? L.fetchTimeoutMs, maxBytes: L.maxBodyBytes, maxRedirects: L.maxRedirects })
    },
    async post(url, opts = {}) {
      const transport = await resolveImpl()
      return fetchCapped(transport, url, { ...opts, method: 'POST', timeoutMs: opts.timeoutMs ?? L.fetchTimeoutMs, maxBytes: L.maxBodyBytes, maxRedirects: 0 })
    },
  }

  /**
   * The ctx a search provider sees: `signal` and the per-endpoint timeout are
   * injected into EVERY get/post, so a provider cannot forget to forward the
   * outer abort (FSM preemption / a superseding chat send used to be unable
   * to cancel an in-flight engine fetch, 260917).
   */
  function searchCtx(signal, timeoutMs) {
    const inject = (opts = {}) => ({ ...opts, signal, timeoutMs: opts.timeoutMs ?? timeoutMs })
    return { ...ctx, signal, get: (url, opts) => ctx.get(url, inject(opts)), post: (url, opts) => ctx.post(url, inject(opts)) }
  }

  /** MediaWiki list=search on one wiki. Throws on a non-answer. */
  async function wikiSearch(wiki, q, signal) {
    const u = `https://${wiki.host}${wiki.apiPath}?action=query&list=search&format=json&srprop=snippet&srlimit=${Math.min(3, L.maxResults)}&srsearch=${encodeURIComponent(q)}`
    const { res, text } = await ctx.get(u, { headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA }, signal, timeoutMs: L.searchTimeoutMs })
    if (!res.ok) throw new Error(`${wiki.host} http ${res.status}`)
    const j = JSON.parse(text)
    return (j?.query?.search ?? []).map((r) => ({ title: r.title, url: wikiArticleUrl(wiki, r.title), snippet: stripTags(r.snippet ?? ''), wiki: wiki.name }))
  }

  /** Query with the game name removed, so the wiki's own index is not asked for its own name. */
  function wikiQuery(wiki, q) {
    // Also drop recency words: a wiki's full-text index matches "most recent"
    // literally (minecraft.wiki ranked a lost alpha build first for "most
    // recent java version"); the model reads the page to learn what is current.
    const stripped = (wiki.match ? q.replace(wiki.match, ' ') : q)
      .replace(/\b(most recent|latest|recent|current|currently|newest|new|now|today)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim()
    return stripped.length >= 3 ? stripped : q
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

  async function generalSearch(q, signal, errors) {
    const now = Date.now()
    const chain = providerChain(provider, apiKey).filter((name) => (name !== 'ddg' || now >= ddgBlockedUntil) && (name !== 'bing' || now >= bingBlockedUntil))
    for (const name of chain) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      try {
        // Keyless engines are a sequential chain, so each gets the short
        // search clock; a keyed API is a single call on the page clock.
        const raw = await providers[name](q, searchCtx(signal, KEYLESS_PROVIDERS.has(name) ? L.searchTimeoutMs : L.fetchTimeoutMs))
        if (KEYLESS_PROVIDERS.has(name) && !looksRelevant(raw, q)) throw new Error(`${name} answered a different query`)
        if (raw.length === 0) throw new Error(`${name} no results`)
        lastProvider = name
        return raw
      } catch (err) {
        if (signal?.aborted) throw err
        if (BLOCKING_FAILURE.test(String(err?.message))) {
          if (name === 'ddg') ddgBlockedUntil = Date.now() + ENGINE_COOLDOWN_MS
          else if (name === 'bing') bingBlockedUntil = Date.now() + ENGINE_COOLDOWN_MS
        }
        errors.push(`${name}: ${err?.message ?? err}`)
        logger?.debug?.(`[sei/web] search via ${name} failed: ${err?.message ?? err}`)
      }
    }
    return []
  }

  async function search(query, { signal } = {}) {
    const q = String(query ?? '').trim().replace(/\s+/g, ' ').slice(0, 200)
    if (!q) return { content: 'search: empty query', is_error: true }
    const errors = []
    // Wikis named by the query (plus the surface's standing wikis) are asked
    // directly, in parallel with the general engines. Their hits come first:
    // for a game question the wiki page IS the answer, and the engines are
    // the ones that hand back a storefront homepage.
    const wikis = [...new Map([...wikisForQuery(q), ...alwaysWikis].map((w) => [w.host, w])).values()].slice(0, 2)
    const [wikiSettled, general] = await Promise.all([
      Promise.allSettled(wikis.map((w) => wikiSearch(w, wikiQuery(w, q), signal))),
      generalSearch(q, signal, errors),
    ])
    // Preempted while the engines were answering: the turn that asked is
    // gone, so stale results must not be handed to whatever runs next.
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const wikiHits = []
    wikiSettled.forEach((r, i) => {
      if (r.status === 'fulfilled') wikiHits.push(...r.value)
      else errors.push(`${wikis[i].host}: ${r.reason?.message ?? r.reason}`)
    })
    if (wikiHits.length && !general.length) lastProvider = 'wiki'
    const seen = new Set()
    const results = []
    for (const r of [...wikiHits, ...general]) {
      if (!r?.url || !/^https?:\/\//i.test(r.url)) continue
      const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      results.push(r)
      if (results.length >= L.maxResults) break
    }
    if (results.length === 0) {
      logger?.warn?.(`[sei/web] search failed on every provider: ${errors.join('; ')}`)
      return { content: 'search failed: no search service answered. Tell the player you could not look it up right now.', is_error: true }
    }
    const lines = results.map((r) => {
      const label = addRef(r)
      const host = hostOf(r.url)
      const snippet = clip(r.snippet, L.snippetChars)
      return `${label}. ${clip(r.title || host || r.url, L.titleChars)}${host ? ` (${host})` : ''}${snippet ? ` - ${snippet}` : ''}`
    })
    return { content: `results for "${q}":\n${lines.join('\n')}`, is_error: false }
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
    // Known wiki: read through the MediaWiki API (answers from any network,
    // no site chrome). Fall through to the HTML page when it does not.
    const wiki = wikiFor(target.host)
    const wikiTitle = wikiTitleFromUrl(url, wiki)
    if (wiki && wikiTitle) {
      const viaApi = await visitWikiApi(wiki, wikiTitle, target, pageNo, signal)
      if (viaApi) return viaApi
    }
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
    if (!res.ok) {
      // An unknown wiki behind a bot wall: its api.php usually still answers.
      if ((res.status === 403 || res.status === 503) && !wiki && wikiTitleFromUrl(url, null)) {
        const guess = { host: target.host, articlePath: /\/w\//.test(new URL(url).pathname) ? '/w/' : '/wiki/', apiPath: '/api.php', name: target.host }
        const viaApi = await visitWikiApi(guess, wikiTitleFromUrl(url, null), target, pageNo, signal)
        if (viaApi) return viaApi
      }
      return { content: `visit: ${target.host || url} answered HTTP ${res.status}`, is_error: true }
    }
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
    return pageOut({ ...target, host: target.host || url }, title, body, pageNo)
  }

  function pageOut(target, title, body, pageNo) {
    const totalPages = Math.max(1, Math.ceil(body.length / L.pageChars))
    if (pageNo > totalPages) return { content: `visit: ${target.host} has only ${totalPages} page${totalPages === 1 ? '' : 's'}.`, is_error: true }
    const slice = body.slice((pageNo - 1) * L.pageChars, pageNo * L.pageChars)
    const head = `${target.label ? `[${target.label}] ` : ''}${target.host}${title ? ` - ${clip(title, L.titleChars)}` : ''}` +
      (totalPages > 1 ? ` (part ${pageNo}/${totalPages}${pageNo < totalPages ? `, page: ${pageNo + 1} for more` : ''})` : '')
    return { content: `${head}\n${slice}`, is_error: false }
  }

  async function visitWikiApi(wiki, title, target, pageNo, signal) {
    try {
      const u = `https://${wiki.host}${wiki.apiPath}?action=parse&format=json&redirects=1&disabletoc=1&disableeditsection=1&prop=text%7Cdisplaytitle&page=${encodeURIComponent(title)}`
      const { res, text } = await ctx.get(u, { headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA }, signal })
      if (!res.ok) return null
      const j = JSON.parse(text)
      const html = j?.parse?.text?.['*'] ?? j?.parse?.text
      if (typeof html !== 'string' || !html) return null
      const body = htmlToText(`<main>${html}</main>`)
      if (!body) return null
      const shown = stripTags(j?.parse?.displaytitle ?? '') || j?.parse?.title || title
      return pageOut({ ...target, host: wiki.host }, `${shown} (${wiki.name})`, body, pageNo)
    } catch (err) {
      if (signal?.aborted) throw err
      logger?.debug?.(`[sei/web] wiki api read failed for ${wiki.host}/${title}: ${err?.message ?? err}`)
      return null
    }
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
    get ddgBlockedUntil() { return ddgBlockedUntil },
    get bingBlockedUntil() { return bingBlockedUntil },
    get callsThisTurn() { return callsThisTurn },
  }
}

export function isWebTool(name) {
  return WEB_TOOL_NAMES.has(name)
}
