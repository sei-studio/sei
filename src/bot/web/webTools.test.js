// src/bot/web/webTools.test.js — parsers, labels, text extraction, URL gate,
// and the session behavior (provider chain fallback, paging, budget) against
// a scripted fetch. No network.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  createWebSession,
  parseDdgHtml,
  parseBingHtml,
  htmlToText,
  labelFor,
  assertPublicHttpUrl,
  normalizeUserUrl,
  providerChain,
  looksRelevant,
  wikiTitleFromUrl,
  wikisForQuery,
  clip,
  createNetRequester,
  WEB_TOOLS,
} from './webTools.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (n) => fs.readFileSync(path.join(here, 'fixtures', n), 'utf8')

function fakeResponse({ status = 200, body = '', contentType = 'text/html; charset=utf-8', headers = {} } = {}) {
  const bytes = new TextEncoder().encode(body)
  const h = new Map(Object.entries({ 'content-type': contentType, ...headers }).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    body: {
      getReader() {
        let done = false
        return {
          read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })),
          cancel: async () => {},
        }
      },
      cancel: async () => {},
    },
    text: async () => body,
  }
}

/** Route table: url substring -> response or function(url, init). */
function scriptedFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    for (const [needle, r] of Object.entries(routes)) {
      if (url.includes(needle)) return typeof r === 'function' ? r(url, init) : r
    }
    return fakeResponse({ status: 404, body: 'nope' })
  }
  fetchImpl.calls = calls
  return fetchImpl
}

describe('parsers', () => {
  it('parses DuckDuckGo HTML results with decoded uddg targets and snippets', () => {
    const r = parseDdgHtml(fixture('ddg.html'))
    expect(r.length).toBe(10)
    expect(r[0].url).toBe('https://minecraft.wiki/w/Netherite_Armor')
    expect(r[0].title).toMatch(/Netherite Armor/)
    expect(r[0].snippet).toMatch(/strongest armor/i)
    for (const x of r) expect(x.url).toMatch(/^https?:\/\//)
  })

  it('parses Bing HTML results, unpacking the ck/a redirect', () => {
    const r = parseBingHtml(fixture('bing.html'))
    expect(r.length).toBe(4)
    expect(r[0].url).toBe('https://www.craft.do/')
    expect(r[0].title).toMatch(/^Craft/)
    expect(r[0].snippet.length).toBeGreaterThan(20)
  })

  it('returns nothing for a challenge page', () => {
    expect(parseDdgHtml('<html><body>Unfortunately, bots use DuckDuckGo too.</body></html>')).toEqual([])
    expect(parseBingHtml('<html></html>')).toEqual([])
  })
})

describe('htmlToText', () => {
  it('drops scripts, nav and boilerplate, keeps paragraphs and list items', () => {
    const html = `<html><head><title>T &amp; U</title><style>p{}</style></head><body>
      <nav><a href="/">Home</a><a href="/x">Other</a></nav>
      <main><h1>Heading</h1><p>First para with <b>bold</b> and &quot;quotes&quot;.</p>
      <ul><li>one</li><li>two</li></ul>
      <script>alert(1)</script>
      ${'<p>filler text to make the main region substantial. </p>'.repeat(12)}
      </main><footer>copyright</footer></body></html>`
    const t = htmlToText(html)
    expect(t).toContain('Heading')
    expect(t).toContain('First para with bold and "quotes".')
    expect(t).toContain('- one\n- two')
    expect(t).not.toContain('alert')
    expect(t).not.toContain('Home')
    expect(t).not.toContain('copyright')
  })

  it('strips wiki chrome: edit links, citation markers, stray table pipes', () => {
    const t = htmlToText('<p>Born<span>[ edit ]</span> in 1975.<sup>[ 3 ]</sup></p><table><tr><td>Spouse</td><td>Kelly</td></tr><tr><td></td></tr></table>')
    expect(t).not.toContain('[ edit ]')
    expect(t).not.toContain('[ 3 ]')
    expect(t).not.toMatch(/^\|$/m)
  })

  it('survives > inside quoted attributes', () => {
    expect(htmlToText(`<p data-x='{"a":">"}'>hi <b>there</b></p>`)).toBe('hi there')
  })
})

describe('labels + urls', () => {
  it('labels run a..z then aa, ab', () => {
    expect(labelFor(0)).toBe('a')
    expect(labelFor(25)).toBe('z')
    expect(labelFor(26)).toBe('aa')
    expect(labelFor(27)).toBe('ab')
    expect(labelFor(52)).toBe('ba')
  })

  it('rejects local and private targets, accepts public https', () => {
    for (const bad of ['http://localhost/x', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://172.20.0.1/', 'http://[::1]/', 'ftp://example.com/', 'http://user:pw@example.com/', 'http://foo.local/']) {
      expect(() => assertPublicHttpUrl(bad), bad).toThrow()
    }
    expect(assertPublicHttpUrl('https://example.com/a?b=1').hostname).toBe('example.com')
  })

  it('normalizes bare hosts, refuses prose', () => {
    expect(normalizeUserUrl('example.com/page')).toBe('https://example.com/page')
    expect(normalizeUserUrl('https://x.org')).toBe('https://x.org')
    expect(normalizeUserUrl('what is this')).toBeNull()
  })

  it('provider chain: keyed first only when a key is present; wikipedia is the floor', () => {
    expect(providerChain('auto', '')).toEqual(['ddg', 'bing', 'wikipedia'])
    expect(providerChain('brave', '')).toEqual(['ddg', 'bing', 'wikipedia'])
    expect(providerChain('brave', 'k')).toEqual(['brave', 'ddg', 'bing', 'wikipedia'])
    expect(providerChain('ddg', '')).toEqual(['ddg', 'wikipedia'])
    expect(providerChain('nonsense', '')).toEqual(['ddg', 'bing', 'wikipedia'])
  })

  it('looksRelevant rejects a scrape that answered a different query', () => {
    expect(looksRelevant([{ title: 'LATENT Definition & Meaning', snippet: 'present and capable of emerging' }], 'Latent Space podcast hosts')).toBe(false)
    expect(looksRelevant([{ title: 'Latent Space: The AI Engineer Podcast', snippet: 'swyx and Alessio' }], 'Latent Space podcast hosts')).toBe(true)
    expect(looksRelevant([{ title: 'anything', snippet: '' }], 'swyx')).toBe(true) // one-word query: no gate
    // Stop words do not count: a name query is judged on the name.
    expect(looksRelevant([{ title: 'Shawn Hatosy', snippet: 'American actor' }, { title: 'Wang Cong', snippet: 'boxer' }], 'who is Shawn Wang')).toBe(false)
    expect(looksRelevant([{ title: 'Shawn Wang (swyx)', snippet: 'writer' }], 'who is Shawn Wang')).toBe(true)
  })

  it('search skips a scraped provider whose results do not match the query', async () => {
    const junk = fixture('bing.html') // "craft" results
    const fetchImpl = scriptedFetch({
      'duckduckgo.com': fakeResponse({ status: 202, body: 'challenge' }),
      'bing.com': fakeResponse({ body: junk }),
      'wikipedia.org': fakeResponse({ contentType: 'application/json', body: JSON.stringify({ query: { search: [{ title: 'Latent Space', snippet: 'a <b>podcast</b>' }] } }) }),
    })
    const s = createWebSession({ fetchImpl })
    const r = await s.search('latent space podcast hosts')
    expect(s.lastProvider).toBe('wikipedia')
    expect(r.content).toContain('a. Latent Space')
  })

  it('clip cuts on a word boundary with an ellipsis', () => {
    expect(clip('short', 10)).toBe('short')
    expect(clip('the quick brown fox jumps', 16)).toBe('the quick brown…')
  })

  it('exposes exactly the two tools with the expected names', () => {
    expect(WEB_TOOLS.map((t) => t.name)).toEqual(['search', 'visit'])
  })
})

describe('session', () => {
  it('search falls back down the keyless chain and formats lettered, compact results', async () => {
    const fetchImpl = scriptedFetch({
      'duckduckgo.com': fakeResponse({ status: 202, body: 'Unfortunately, bots use DuckDuckGo too.' }),
      'bing.com': fakeResponse({ body: fixture('bing.html') }),
    })
    const s = createWebSession({ fetchImpl })
    const r = await s.search('craft')
    expect(r.is_error).toBe(false)
    expect(s.lastProvider).toBe('bing')
    const lines = r.content.split('\n')
    expect(lines[0]).toBe('results for "craft":')
    expect(lines[1]).toMatch(/^a\. Craft .*\(craft\.do\) - /)
    expect(lines.length).toBe(5) // header + 4 results
    expect(r.content).not.toContain('http')
    expect(r.content.length).toBeLessThan(1200)
    expect(s.refs.get('a').url).toBe('https://www.craft.do/')
  })

  it('search reports failure when every provider fails', async () => {
    const s = createWebSession({ fetchImpl: scriptedFetch({}) })
    const r = await s.search('anything')
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/could not look it up/)
  })

  it('visit resolves a letter, pages long text, and follows redirects through the gate', async () => {
    const long = `<html><head><title>Long Page</title></head><body><main>${'<p>' + 'word '.repeat(120) + '</p>'.repeat(1)}${'<p>' + 'more '.repeat(200) + '</p>'}</main></body></html>`
    const fetchImpl = scriptedFetch({
      'bing.com': fakeResponse({ body: fixture('bing.html') }),
      'docs.craft.do/long': fakeResponse({ body: long }),
      'www.craft.do/': fakeResponse({ status: 301, headers: { location: 'https://docs.craft.do/long' } }),
    })
    const s = createWebSession({ fetchImpl, provider: 'bing', limits: { pageChars: 500 } })
    await s.search('craft')
    const p1 = await s.visit('a')
    expect(p1.is_error).toBe(false)
    expect(p1.content).toMatch(/^\[a\] docs\.craft\.do - Long Page \(part 1\/\d+, page: 2 for more\)\n/)
    expect(p1.content.length).toBeLessThan(600)
    const p2 = await s.visit('A.', { page: 2 })
    expect(p2.content).toMatch(/part 2\//)
    const over = await s.visit('a', { page: 99 })
    expect(over.is_error).toBe(true)
  })

  it('visit refuses private hops even when reached via redirect', async () => {
    const fetchImpl = scriptedFetch({
      'example.com': fakeResponse({ status: 302, headers: { location: 'http://127.0.0.1:9/admin' } }),
    })
    const s = createWebSession({ fetchImpl })
    const r = await s.visit('https://example.com/')
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/private addresses/)
    expect(fetchImpl.calls.length).toBe(1)
  })

  it('visit reports unknown refs, binary pages, HTTP errors and bot walls', async () => {
    const fetchImpl = scriptedFetch({
      'pdf.example': fakeResponse({ body: '%PDF', contentType: 'application/pdf' }),
      'down.example': fakeResponse({ status: 503, body: '' }),
      'wall.example': fakeResponse({ body: '<html><body><p>Just a moment... enable JavaScript and cookies to continue</p></body></html>' }),
    })
    const s = createWebSession({ fetchImpl })
    expect((await s.visit('q')).content).toMatch(/Call search\(\) first/)
    expect((await s.visit('https://pdf.example/x')).content).toMatch(/not a readable page/)
    expect((await s.visit('https://down.example/x')).content).toMatch(/HTTP 503/)
    expect((await s.visit('https://wall.example/x')).content).toMatch(/blocks automated readers/)
  })

  it('runTool enforces the per-turn budget and beginTurn resets it', async () => {
    const fetchImpl = scriptedFetch({ 'example.com': fakeResponse({ body: '<p>hello world page</p>' }) })
    const s = createWebSession({ fetchImpl, limits: { maxCallsPerTurn: 2 } })
    expect((await s.runTool('visit', { ref: 'https://example.com/1' })).is_error).toBe(false)
    expect((await s.runTool('visit', { ref: 'https://example.com/2' })).is_error).toBe(false)
    const third = await s.runTool('visit', { ref: 'https://example.com/3' })
    expect(third.is_error).toBe(true)
    expect(third.content).toMatch(/no more web lookups this turn/)
    s.beginTurn()
    expect((await s.runTool('visit', { ref: 'https://example.com/4' })).is_error).toBe(false)
    await expect(s.runTool('remember', {})).rejects.toThrow(/not a web tool/)
  })

  it('keyed provider (brave) is used first when a key is configured', async () => {
    const fetchImpl = scriptedFetch({
      'api.search.brave.com': (url, init) => {
        expect(init.headers['X-Subscription-Token']).toBe('KEY')
        return fakeResponse({
          contentType: 'application/json',
          body: JSON.stringify({ web: { results: [{ title: 'Brave hit', url: 'https://b.example/x', description: 'a <b>snippet</b>' }] } }),
        })
      },
    })
    const s = createWebSession({ fetchImpl, provider: 'brave', apiKey: 'KEY' })
    const r = await s.search('q')
    expect(s.lastProvider).toBe('brave')
    expect(r.content).toBe('results for "q":\na. Brave hit (b.example) - a snippet')
  })
})

describe('game wikis (260909)', () => {
  const wikiSearchJson = (titles) => JSON.stringify({ query: { search: titles.map((t) => ({ title: t, snippet: `<span class="searchmatch">${t}</span> snippet` })) } })
  const wikiParseJson = (title, html) => JSON.stringify({ parse: { title, displaytitle: title, text: { '*': html } } })

  it('maps queries to wikis and article URLs to titles', () => {
    expect(wikisForQuery('minecraft how to tame a fox').map((w) => w.host)).toEqual(['minecraft.wiki'])
    expect(wikisForQuery('valorant vandal vs phantom').map((w) => w.host)).toEqual(['valorant.fandom.com'])
    expect(wikisForQuery('ucla current chancellor')).toEqual([])
    expect(wikiTitleFromUrl('https://minecraft.wiki/w/Java_Edition_1.21.11', { articlePath: '/w/' })).toBe('Java Edition 1.21.11')
    expect(wikiTitleFromUrl('https://valorant.fandom.com/wiki/Patch_Notes/11.10', { articlePath: '/wiki/' })).toBe('Patch Notes/11.10')
    expect(wikiTitleFromUrl('https://minecraft.wiki/api.php?x', { articlePath: '/w/' })).toBeNull()
    expect(wikiTitleFromUrl('https://some.wiki/wiki/Thing', null)).toBe('Thing')
  })

  it('search asks the named wiki directly and lists its hits first, even when the engines fail', async () => {
    const fetchImpl = scriptedFetch({
      'minecraft.wiki/api.php?action=query': fakeResponse({ contentType: 'application/json', body: wikiSearchJson(['Taming', 'Fox']) }),
      'duckduckgo.com': fakeResponse({ status: 202, body: 'challenge' }),
      'bing.com': fakeResponse({ status: 500, body: '' }),
      'wikipedia.org': fakeResponse({ status: 500, body: '' }),
    })
    const s = createWebSession({ fetchImpl })
    const r = await s.search('minecraft how to tame a fox')
    expect(r.is_error).toBe(false)
    expect(s.lastProvider).toBe('wiki')
    expect(r.content).toBe('results for "minecraft how to tame a fox":\na. Taming (minecraft.wiki) - Taming snippet\nb. Fox (minecraft.wiki) - Fox snippet')
    expect(s.refs.get('a').url).toBe('https://minecraft.wiki/w/Taming')
    // The wiki was asked WITHOUT the game name.
    const wikiCall = fetchImpl.calls.find((c) => c.url.includes('minecraft.wiki/api.php'))
    expect(decodeURIComponent(wikiCall.url)).toContain('srsearch=how to tame a fox')
    // Recency words are dropped too.
    fetchImpl.calls.length = 0
    await s.search('most recent minecraft java version')
    const wikiCall2 = fetchImpl.calls.find((c) => c.url.includes('minecraft.wiki/api.php'))
    expect(decodeURIComponent(wikiCall2.url)).toContain('srsearch=java version')
    // A DDG challenge arms the cooldown so the next search skips it.
    expect(s.ddgBlockedUntil).toBeGreaterThan(Date.now())
    fetchImpl.calls.length = 0
    await s.search('minecraft creeper')
    expect(fetchImpl.calls.some((c) => c.url.includes('duckduckgo.com'))).toBe(false)
  })

  it('alwaysWikiHosts asks the standing wiki for a query that never names the game', async () => {
    const fetchImpl = scriptedFetch({
      'minecraft.wiki/api.php?action=query': fakeResponse({ contentType: 'application/json', body: wikiSearchJson(['Fox']) }),
      'bing.com': fakeResponse({ body: fixture('bing.html') }),
    })
    const s = createWebSession({ fetchImpl, provider: 'bing', alwaysWikiHosts: ['minecraft.wiki'] })
    const r = await s.search('craft')
    expect(r.content.split('\n')[1]).toMatch(/^a\. Fox \(minecraft\.wiki\)/)
    expect(r.content.split('\n')[2]).toMatch(/craft\.do/)
  })

  it('visit on a known wiki reads through the MediaWiki API and pages the parsed text', async () => {
    const html = '<div class="mw-parser-output"><p>The <b>Vandal</b> is a rifle.</p><p>' + 'Damage 40. '.repeat(80) + '</p></div>'
    const fetchImpl = scriptedFetch({
      'valorant.fandom.com/api.php?action=parse': fakeResponse({ contentType: 'application/json', body: wikiParseJson('Vandal', html) }),
      'valorant.fandom.com/wiki/Vandal': fakeResponse({ status: 403, body: 'Just a moment...' }),
    })
    const s = createWebSession({ fetchImpl, limits: { pageChars: 400 } })
    const v = await s.visit('https://valorant.fandom.com/wiki/Vandal')
    expect(v.is_error).toBe(false)
    expect(v.content).toMatch(/^valorant\.fandom\.com - Vandal \(VALORANT Wiki\) \(part 1\/\d+, page: 2 for more\)\nThe Vandal is a rifle\./)
    expect(fetchImpl.calls.some((c) => c.url.includes('/wiki/Vandal'))).toBe(false) // never hit the walled HTML
    const apiCall = fetchImpl.calls.find((c) => c.url.includes('action=parse'))
    expect(apiCall.url).toContain('page=Vandal')
  })

  it('visit falls back to the HTML page when the wiki API does not answer', async () => {
    const fetchImpl = scriptedFetch({
      'minecraft.wiki/api.php': fakeResponse({ status: 500, body: '' }),
      'minecraft.wiki/w/Fox': fakeResponse({ body: '<html><head><title>Fox</title></head><body><main>' + '<p>Foxes are passive mobs. </p>'.repeat(30) + '</main></body></html>' }),
    })
    const s = createWebSession({ fetchImpl })
    const v = await s.visit('https://minecraft.wiki/w/Fox')
    expect(v.is_error).toBe(false)
    expect(v.content).toContain('Foxes are passive mobs')
  })

  it('an unknown wiki behind a bot wall is retried through its api.php', async () => {
    const fetchImpl = scriptedFetch({
      'some.wiki/wiki/Thing': fakeResponse({ status: 403, body: 'Just a moment...' }),
      'some.wiki/api.php?action=parse': fakeResponse({ contentType: 'application/json', body: wikiParseJson('Thing', '<p>Thing is a thing.</p>') }),
    })
    const s = createWebSession({ fetchImpl })
    const v = await s.visit('https://some.wiki/wiki/Thing')
    expect(v.is_error).toBe(false)
    expect(v.content).toContain('Thing is a thing.')
  })

  it('follow-redirect fetch mode gates the reported final url', async () => {
    const fetchImpl = async () => {
      const r = fakeResponse({ body: '<p>secret</p>' })
      return { ...r, url: 'http://127.0.0.1/admin' } // the transport followed a redirect to a private host
    }
    const s = createWebSession({ fetchImpl, manualRedirects: false })
    const v = await s.visit('https://example.com/x')
    expect(v.is_error).toBe(true)
    expect(v.content).toMatch(/private addresses/)
  })

  it('follow-redirect fetch mode refuses an EMPTY res.url instead of treating it as same-origin', async () => {
    // Electron's net.fetch reports res.url as '' for every response, which the
    // old check read as "no redirect happened" and let the body through.
    const fetchImpl = async () => ({ ...fakeResponse({ body: '<p>secret</p>' }), url: '' })
    const s = createWebSession({ fetchImpl, manualRedirects: false })
    const v = await s.visit('https://example.com/x')
    expect(v.is_error).toBe(true)
    expect(v.content).toMatch(/redirect target unknown/)
    expect(v.content).not.toContain('secret')
  })
})

// ---------------------------------------------------------------------------
// The Electron transport: a fake of `net.request` (ClientRequest +
// IncomingMessage) driving createNetRequester. Routes: url substring ->
// { status, headers, body } | { redirect } | { hang: true } | function(url).

function fakeNet(routes) {
  const calls = []   // every URL the transport was asked to open, in order
  const bodiesRead = [] // every URL whose body was actually delivered
  function route(url) {
    for (const [needle, r] of Object.entries(routes)) if (url.includes(needle)) return typeof r === 'function' ? r(url) : r
    return { status: 404, body: 'nope' }
  }
  function request({ url, method, redirect }) {
    const handlers = {}
    const req = {
      url, method, redirect, headers: {}, aborted: false, followed: false, body: undefined,
      setHeader(k, v) { this.headers[k] = v },
      on(ev, fn) { (handlers[ev] ??= []).push(fn); return req },
      abort() { req.aborted = true },
      followRedirect() { req.followed = true },
      end(body) { req.body = body; queueMicrotask(() => run(url)) },
    }
    const emit = (ev, ...a) => (handlers[ev] ?? []).forEach((f) => f(...a))
    function run(u) {
      if (req.aborted) return
      calls.push(u)
      const r = route(u)
      if (r.redirect) {
        req.followed = false
        emit('redirect', r.status ?? 302, method, r.redirect, {})
        if (req.aborted) return
        if (req.followed) queueMicrotask(() => run(new URL(r.redirect, u).toString()))
        else emit('error', new Error('Redirect was cancelled'))
        return
      }
      if (r.hang) return
      const res = makeIncoming(r)
      emit('response', res)
      queueMicrotask(() => {
        if (req.aborted) return
        bodiesRead.push(u)
        res.push(Buffer.from(r.body ?? ''))
      })
    }
    return req
  }
  function makeIncoming(r) {
    const h = {}
    const status = r.status ?? 200
    const res = {
      statusCode: status,
      headers: Object.fromEntries(Object.entries({ 'content-type': 'text/html; charset=utf-8', ...(r.headers ?? {}) }).map(([k, v]) => [k.toLowerCase(), v])),
      on(ev, fn) { (h[ev] ??= []).push(fn); return res },
      push(buf) {
        const chunk = r.chunk ?? buf.length
        for (let i = 0; i < buf.length; i += chunk) (h.data ?? []).forEach((f) => f(buf.subarray(i, i + chunk)))
        ;(h.end ?? []).forEach((f) => f())
      },
    }
    return res
  }
  return { request, calls, bodiesRead }
}

describe('electron transport (net.request, 260917)', () => {
  const sessionOver = (net, extra = {}) => createWebSession({ fetchProvider: async () => ({ request: createNetRequester(net), kind: 'fake-electron' }), ...extra })

  it('a redirect to a private host is refused BEFORE its body is read, with the gate error', async () => {
    const net = fakeNet({
      'example.com/start': { redirect: 'http://127.0.0.1:9/admin' },
      '127.0.0.1': { body: '<p>secret</p>' },
    })
    const s = sessionOver(net)
    const v = await s.visit('https://example.com/start')
    expect(v.is_error).toBe(true)
    expect(v.content).toMatch(/private addresses/)
    expect(net.calls).toEqual(['https://example.com/start'])
    expect(net.bodiesRead).toEqual([])
    // Link-local (cloud metadata) and RFC1918 hops are refused the same way.
    for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://192.168.1.1/']) {
      const n = fakeNet({ 'example.com': { redirect: bad } })
      const r = await sessionOver(n).visit('https://example.com/x')
      expect(r.is_error, bad).toBe(true)
      expect(n.bodiesRead, bad).toEqual([])
    }
  })

  it('a redirect to a public host is followed and the final url is recorded', async () => {
    const net = fakeNet({
      'www.craft.do/': { redirect: 'https://docs.craft.do/long', status: 301 },
      'docs.craft.do/long': { body: '<html><head><title>Long Page</title></head><body><main>' + '<p>hello there reader </p>'.repeat(40) + '</main></body></html>' },
    })
    const s = sessionOver(net)
    const v = await s.visit('https://www.craft.do/')
    expect(v.is_error).toBe(false)
    expect(v.content).toMatch(/^docs\.craft\.do - Long Page/)
    expect(net.calls).toEqual(['https://www.craft.do/', 'https://docs.craft.do/long'])
    expect(net.bodiesRead).toEqual(['https://docs.craft.do/long'])
    // A relative Location resolves against the hop it came from.
    const rel = fakeNet({ 'a.example/x': { redirect: '/y' }, 'a.example/y': { body: '<p>landed on y</p>' } })
    expect((await sessionOver(rel).visit('https://a.example/x')).content).toContain('landed on y')
    expect(rel.calls[1]).toBe('https://a.example/y')
  })

  it('more than maxRedirects hops rejects', async () => {
    const net = fakeNet({
      'h.example/1': { redirect: 'https://h.example/2' },
      'h.example/2': { redirect: 'https://h.example/3' },
      'h.example/3': { body: '<p>end</p>' },
    })
    const v = await sessionOver(net, { limits: { maxRedirects: 1 } }).visit('https://h.example/1')
    expect(v.is_error).toBe(true)
    expect(v.content).toMatch(/too many redirects/)
    expect(net.bodiesRead).toEqual([])
    // Exactly maxRedirects hops is fine.
    expect((await sessionOver(net, { limits: { maxRedirects: 2 } }).visit('https://h.example/1')).content).toContain('end')
  })

  it('times out, honors the outer abort, sends headers + POST bodies, and caps the body', async () => {
    const net = fakeNet({
      'slow.example': { hang: true },
      'big.example': { body: 'x'.repeat(5000), chunk: 1000 },
      'api.tavily.com': { body: JSON.stringify({ results: [{ title: 'T', url: 'https://t.example/', content: 'c' }] }), headers: { 'content-type': 'application/json' } },
    })
    const s = sessionOver(net, { limits: { fetchTimeoutMs: 30, maxBodyBytes: 2500 }, provider: 'tavily', apiKey: 'TK' })
    const slow = await s.visit('https://slow.example/')
    expect(slow.is_error).toBe(true)
    expect(slow.content).toMatch(/timed out/)

    const ctrl = new AbortController()
    const p = s.visit('https://slow.example/', { signal: ctrl.signal })
    ctrl.abort(new Error('preempted'))
    await expect(p).rejects.toThrow(/preempted/)

    const r = await s.search('anything')
    expect(s.lastProvider).toBe('tavily')
    expect(r.content).toContain('a. T')
    const tavilyReq = net.calls.find((u) => u.includes('tavily'))
    expect(tavilyReq).toBeTruthy()

    const big = await s.visit('https://big.example/')
    expect(big.is_error).toBe(false)
    // 2.5 KB cap on a 5 KB page: the page is truncated, not refused.
    expect(big.content.length).toBeLessThan(2700)
  })

  it('the transport is asked for manual redirects and carries the request headers', async () => {
    const seen = []
    const net = {
      request(opts) {
        const req = fakeNet({ 'x.example': { body: '<p>ok page</p>' } }).request(opts)
        seen.push({ opts, req })
        return req
      },
    }
    await sessionOver(net).visit('https://x.example/')
    expect(seen[0].opts).toMatchObject({ url: 'https://x.example/', method: 'GET', redirect: 'manual' })
    expect(seen[0].req.headers['User-Agent']).toMatch(/Mozilla/)
  })
})

describe('search cancellation + engine cooldowns (260917)', () => {
  it('the outer abort reaches the engine fetch and search throws instead of returning stale results', async () => {
    const ctrl = new AbortController()
    let innerSignal = null
    const fetchImpl = scriptedFetch({
      'duckduckgo.com': async (url, init) => {
        innerSignal = init.signal
        ctrl.abort(new Error('preempted'))
        if (init.signal.aborted) throw init.signal.reason
        return fakeResponse({ body: fixture('ddg.html') })
      },
    })
    const s = createWebSession({ fetchImpl })
    await expect(s.search('craft tools', { signal: ctrl.signal })).rejects.toThrow(/preempted/)
    expect(innerSignal).toBeInstanceOf(AbortSignal)
    expect(innerSignal.aborted).toBe(true)
    expect(fetchImpl.calls.some((c) => c.url.includes('bing.com'))).toBe(false) // the chain did not move on
  })

  it('a timeout arms the DDG and Bing cooldowns, and keyless engines run on searchTimeoutMs', async () => {
    const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)))
    const fetchImpl = scriptedFetch({
      'duckduckgo.com': hang,
      'bing.com': hang,
      'wikipedia.org': fakeResponse({ contentType: 'application/json', body: JSON.stringify({ query: { search: [{ title: 'Craft', snippet: 'craft <b>things</b>' }] } }) }),
    })
    const s = createWebSession({ fetchImpl, limits: { searchTimeoutMs: 20, fetchTimeoutMs: 60_000 } })
    const t0 = Date.now()
    const r = await s.search('craft')
    expect(Date.now() - t0).toBeLessThan(2000) // two engines timed out on the SEARCH clock, not the 60 s page clock
    expect(r.is_error).toBe(false)
    expect(s.lastProvider).toBe('wikipedia')
    expect(s.ddgBlockedUntil).toBeGreaterThan(Date.now())
    expect(s.bingBlockedUntil).toBeGreaterThan(Date.now())
    fetchImpl.calls.length = 0
    await s.search('craft')
    expect(fetchImpl.calls.map((c) => c.url).some((u) => /duckduckgo|bing\.com/.test(u))).toBe(false)
    expect(fetchImpl.calls.some((c) => c.url.includes('wikipedia.org'))).toBe(true)
  })

  it('visit keeps the page clock (fetchTimeoutMs), not the search clock', async () => {
    const fetchImpl = scriptedFetch({
      'page.example': (url, init) => new Promise((res) => setTimeout(() => res(fakeResponse({ body: '<p>slow but fine page</p>' })), 40)),
    })
    const s = createWebSession({ fetchImpl, limits: { searchTimeoutMs: 5, fetchTimeoutMs: 2000 } })
    const v = await s.visit('https://page.example/')
    expect(v.is_error).toBe(false)
    expect(v.content).toContain('slow but fine page')
  })
})
