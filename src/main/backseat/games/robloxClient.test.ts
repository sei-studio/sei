/**
 * robloxClient (260929): the backseat "which Roblox game" lookup.
 *
 * Fixtures under ./fixtures are REAL responses captured from the public
 * Roblox APIs on 260929, trimmed to a handful of rows (the sorts and search
 * bodies are 100+ KB live). The fetch is faked by URL so every path runs the
 * real parsers against the real shapes.
 *
 * What matters most here is the search rate limit: Roblox's omni-search
 * allows about one request a minute per IP, so a 429 must arm a cooldown
 * (not a retry) and fall back to the popular pool, and a repeated query must
 * come from the cache.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRobloxClient,
  FALLBACK_POPULAR,
  matchPool,
  parseGameRow,
  parseIcons,
  parseSearch,
  parseSorts,
  parseThumbnails,
} from './robloxClient';

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

const SORTS = fx('roblox-sorts.json');
const SEARCH = fx('roblox-search.json');
const GAMES = fx('roblox-games.json');
const ICONS = fx('roblox-icons.json');
const THUMBS = fx('roblox-thumbnails.json');
const PLACE = fx('roblox-place-universe.json');
const PLACE_MISSING = fx('roblox-place-missing.json');

type Route = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that answers by URL substring and records every call. */
function fakeFetch(routes: (url: string) => Route) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = routes(url);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { f, calls, count: (part: string) => calls.filter((u) => u.includes(part)).length };
}

/** The happy-path Roblox, with per-test overrides for the search endpoint. */
function roblox(opts: { search?: () => Route; sorts?: () => Route; place?: () => Route } = {}) {
  return fakeFetch((url) => {
    if (url.includes('/universes/v1/places/4924922222/universe')) return opts.place?.() ?? { body: PLACE };
    if (url.includes('/universes/v1/places/')) return { body: PLACE_MISSING };
    if (url.includes('games.roblox.com/v1/games?')) return { body: GAMES };
    if (url.includes('thumbnails.roblox.com/v1/games/multiget/thumbnails')) return { body: THUMBS };
    if (url.includes('thumbnails.roblox.com/v1/games/icons')) return { body: ICONS };
    if (url.includes('explore-api')) return opts.sorts?.() ?? { body: SORTS };
    if (url.includes('omni-search')) return opts.search?.() ?? { body: SEARCH };
    return { status: 404 };
  });
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('parsers (real response shapes)', () => {
  it('reads a games row: current genre taxonomy, group creator, counts', () => {
    const row = (GAMES as { data: unknown[] }).data[0];
    const g = parseGameRow(row)!;
    expect(g.universeId).toBe(1686885941);
    expect(g.placeId).toBe(4924922222);
    expect(g.name).toBe('Brookhaven 🏡RP');
    expect(g.genre).toBe('Roleplay & Avatar Sim, Life');
    expect(g.creator).toBe('Brookhaven by Voldex');
    expect(g.creatorType).toBe('Group');
    expect(g.maxPlayers).toBeGreaterThan(0);
    expect(g.visits).toBeGreaterThan(0);
    expect(g.description).toMatch(/roleplay/i);
  });

  it('reads search results in order and drops sponsored rows', () => {
    const results = parseSearch(SEARCH);
    expect(results[0]).toMatchObject({
      universeId: 703124385,
      name: 'Tower of Hell',
      creator: 'YXceptional Studios',
      placeId: 1962086868,
    });
    expect(results.length).toBe(6);
    const sponsored = {
      searchResults: [
        {
          contentGroupType: 'Game',
          contents: [
            { universeId: 1, name: 'Ad', isSponsored: true, contentType: 'Game' },
            { universeId: 2, name: 'Real', isSponsored: false, contentType: 'Game' },
          ],
        },
        { contentGroupType: 'User', contents: [{ universeId: 3, name: 'Someone' }] },
      ],
    };
    expect(parseSearch(sponsored).map((g) => g.name)).toEqual(['Real']);
    expect(parseSearch(null)).toEqual([]);
  });

  it('takes the top-playing-now sort as popular and every sort as the pool', () => {
    const { popular, pool } = parseSorts(SORTS);
    expect(popular.map((g) => g.name)).toContain('Brookhaven 🏡RP');
    expect(popular[0].playing).toBeGreaterThan(0);
    // The pool is the union, deduplicated (Slayers 2 is in two sorts).
    expect(pool.length).toBeGreaterThan(popular.length);
    expect(new Set(pool.map((g) => g.universeId)).size).toBe(pool.length);
  });

  it('takes the first completed 16:9 thumbnail per game, Roblox CDN only', () => {
    const thumbs = parseThumbnails(THUMBS);
    expect(thumbs.get(1686885941)).toMatch(/^https:\/\/tr\.rbxcdn\.com\/.*\/480\/270\//);
    expect(thumbs.size).toBe(3);
    const odd = parseThumbnails({
      data: [
        { universeId: 1, thumbnails: [{ state: 'Blocked', imageUrl: 'https://tr.rbxcdn.com/x' }] },
        { universeId: 2, thumbnails: [{ state: 'Completed', imageUrl: 'https://evil.example.com/x' }] },
        { universeId: 3, thumbnails: [] },
      ],
    });
    expect(odd.size).toBe(0);
    expect(parseThumbnails(null).size).toBe(0);
  });

  it('accepts icons only from Roblox CDN and only when completed', () => {
    const icons = parseIcons(ICONS);
    expect(icons.get(1686885941)).toMatch(/^https:\/\/tr\.rbxcdn\.com\//);
    const bad = parseIcons({
      data: [
        { targetId: 5, state: 'Completed', imageUrl: 'https://evil.example.com/x.png' },
        { targetId: 6, state: 'Pending', imageUrl: 'https://tr.rbxcdn.com/x' },
      ],
    });
    expect(bad.size).toBe(0);
  });

  it('matches the pool on every query word, ignoring case and emoji', () => {
    const { pool } = parseSorts(SORTS);
    expect(matchPool(pool, 'brookhaven').map((g) => g.name)).toEqual(['Brookhaven 🏡RP']);
    expect(matchPool(pool, 'MURDER mystery').map((g) => g.universeId)).toEqual([66654135]);
    expect(matchPool(pool, 'zzzz not a game')).toEqual([]);
    expect(matchPool(pool, '   ')).toEqual([]);
  });
});

describe('createRobloxClient', () => {
  it('resolves a pasted link to one game with details and icon', async () => {
    const net = roblox();
    const c = createRobloxClient({ fetch: net.f });
    const res = await c.resolve('https://www.roblox.com/games/4924922222/Brookhaven-RP');
    expect(res.kind).toBe('game');
    if (res.kind !== 'game') return;
    expect(res.game.name).toBe('Brookhaven 🏡RP');
    expect(res.game.genre).toBe('Roleplay & Avatar Sim, Life');
    expect(res.game.iconUrl).toMatch(/rbxcdn/);
    expect(net.count('omni-search')).toBe(0);
    // The same link again is served from cache.
    const before = net.calls.length;
    await c.resolve('roblox.com/games/4924922222');
    expect(net.calls.length).toBe(before);
  });

  it('says not_found for a place that does not exist or a 404, network otherwise', async () => {
    const c1 = createRobloxClient({ fetch: roblox().f });
    expect(await c1.resolve('https://www.roblox.com/games/1/x')).toEqual({
      kind: 'error',
      code: 'not_found',
    });
    const c2 = createRobloxClient({ fetch: roblox({ place: () => ({ status: 404 }) }).f });
    expect(await c2.resolve('roblox.com/games/4924922222')).toEqual({
      kind: 'error',
      code: 'not_found',
    });
    const c3 = createRobloxClient({ fetch: roblox({ place: () => new Error('offline') }).f });
    expect(await c3.resolve('roblox.com/games/4924922222')).toEqual({
      kind: 'error',
      code: 'network',
    });
  });

  it('rejects a link that is not a Roblox game link without calling anything', async () => {
    const net = roblox();
    const c = createRobloxClient({ fetch: net.f });
    expect(await c.resolve('https://example.com/games/123')).toEqual({ kind: 'error', code: 'bad_link' });
    expect(await c.resolve('https://www.roblox.com/share?code=abc&type=ExperienceDetails')).toEqual({
      kind: 'error',
      code: 'bad_link',
    });
    expect(net.calls).toEqual([]);
  });

  it('searches, attaches icons, and caches a repeated query', async () => {
    const net = roblox();
    const c = createRobloxClient({ fetch: net.f });
    const res = await c.resolve('tower of hell');
    expect(res.kind).toBe('results');
    if (res.kind !== 'results') return;
    expect(res.fallback).toBeUndefined();
    expect(res.results[0].name).toBe('Tower of Hell');
    expect(net.count('omni-search')).toBe(1);
    await c.resolve('  Tower of HELL ');
    expect(net.count('omni-search')).toBe(1);
  });

  it('on a 429, arms a cooldown from x-ratelimit-reset and answers from the popular pool', async () => {
    const t = clock();
    const net = roblox({
      search: () => ({
        status: 429,
        headers: { 'x-ratelimit-reset': '55', 'retry-after': '5' },
      }),
    });
    const c = createRobloxClient({ fetch: net.f, now: t.now });
    const res = await c.resolve('brookhaven');
    expect(res).toMatchObject({ kind: 'results', fallback: 'rate_limited' });
    if (res.kind !== 'results') return;
    expect(res.results.map((g) => g.name)).toEqual(['Brookhaven 🏡RP']);
    expect(net.count('omni-search')).toBe(1);

    // Inside the window (retry-after says 5 s; the real window is 55 s):
    // no request goes out.
    t.advance(10_000);
    await c.resolve('murder mystery');
    expect(net.count('omni-search')).toBe(1);

    // After the reset the search endpoint is asked again.
    t.advance(46_000);
    await c.resolve('doors');
    expect(net.count('omni-search')).toBe(2);
  });

  it('falls back to the pool as "unavailable" when search is down', async () => {
    const net = roblox({ search: () => new Error('ECONNRESET') });
    const c = createRobloxClient({ fetch: net.f });
    const res = await c.resolve('murder');
    expect(res).toMatchObject({ kind: 'results', fallback: 'unavailable' });
    if (res.kind !== 'results') return;
    expect(res.results[0].universeId).toBe(66654135);
  });

  it('lists popular games live, and the built-in list when explore is down', async () => {
    const live = createRobloxClient({ fetch: roblox().f });
    const list = await live.popular();
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((g) => g.name)).toContain('Brookhaven 🏡RP');
    expect(list.find((g) => g.universeId === 1686885941)?.iconUrl).toMatch(/rbxcdn/);
    expect(list.find((g) => g.universeId === 1686885941)?.thumbnailUrl).toMatch(/rbxcdn.*480\/270/);

    const down = createRobloxClient({ fetch: roblox({ sorts: () => ({ status: 503 }) }).f });
    const fallback = await down.popular();
    expect(fallback.map((g) => g.universeId)).toEqual(FALLBACK_POPULAR.map((g) => g.universeId));
  });

  it('caches details and answers null when they cannot be read', async () => {
    const net = roblox();
    const c = createRobloxClient({ fetch: net.f });
    expect((await c.details(1686885941))?.name).toBe('Brookhaven 🏡RP');
    const n = net.count('games.roblox.com');
    await c.details(1686885941);
    expect(net.count('games.roblox.com')).toBe(n);

    const broken = createRobloxClient({ fetch: fakeFetch(() => new Error('offline')).f });
    expect(await broken.details(1686885941)).toBeNull();
    expect(await c.details(-4)).toBeNull();
    // A universe the games endpoint does not return is null, not a wrong game.
    expect(await c.details(123)).toBeNull();
  });
});
