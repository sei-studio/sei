/**
 * Roblox lookup for the backseat "which game are you playing?" step (260929).
 *
 * Public, unauthenticated Roblox web APIs only, called from MAIN (the renderer
 * has no network of its own for this, and main is where the prompt is built,
 * so the details the model reads are fetched here rather than trusted from
 * the renderer). Every endpoint was checked from our server on 260929:
 *
 *   place -> universe  apis.roblox.com/universes/v1/places/{placeId}/universe
 *                      {"universeId": n} (null for a place that does not exist)
 *   details            games.roblox.com/v1/games?universeIds=a,b
 *   icons              thumbnails.roblox.com/v1/games/icons?universeIds=a,b&size=150x150
 *   popular            apis.roblox.com/explore-api/v1/get-sorts  (120 req/min;
 *                      the "top-playing-now" sort is the live popular list)
 *   search             apis.roblox.com/search-api/omni-search?searchQuery=..
 *                      RATE LIMITED to about ONE request per minute per IP
 *                      (x-ratelimit-limit: "1, 1;w=60"; a second query inside
 *                      the window is a 429).
 *
 * The search limit shapes the design. A search is only sent on submit (never
 * as-you-type), every result is cached per query, a 429 arms a cooldown from
 * the response's own reset header instead of retrying, and while search is
 * unavailable the query is matched against the POPULAR POOL instead: the
 * union of every explore sort (about 300 current experiences), which covers
 * most of what players actually type. A pasted game link needs no search at
 * all and always works.
 *
 * Never throws: every failure is a typed result or an empty list, because the
 * player can always continue without picking a game.
 */

import { randomUUID } from 'node:crypto';
import {
  parseRobloxLink,
  looksLikeLink,
  type BackseatGameInfo,
  type BackseatGameResolveResult,
} from '../../../shared/backseatGames';

export const ROBLOX_ENDPOINTS = {
  placeUniverse: (placeId: number) =>
    `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
  games: (ids: number[]) => `https://games.roblox.com/v1/games?universeIds=${ids.join(',')}`,
  icons: (ids: number[]) =>
    `https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids.join(',')}` +
    '&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false',
  sorts: (sessionId: string) =>
    `https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=${sessionId}`,
  search: (query: string, sessionId: string) =>
    `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}` +
    `&sessionId=${sessionId}&pageType=all`,
} as const;

const TIMEOUT_MS = 6_000;
const DETAILS_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const POPULAR_TTL_MS = 15 * 60 * 1000;
/** A failed popular fetch retries sooner, so the list heals with the network. */
const POPULAR_FAIL_TTL_MS = 60 * 1000;
/** Cooldown after a search 429 when the response names no reset time. */
const SEARCH_COOLDOWN_MS = 60 * 1000;
const MAX_RESULTS = 8;
const POPULAR_COUNT = 8;
const SEARCH_CACHE_MAX = 50;

/**
 * Shown when the explore API cannot be reached, so the step always has
 * something to click. Checked against games.roblox.com on 260929; the live
 * list replaces it whenever it loads.
 */
export const FALLBACK_POPULAR: readonly BackseatGameInfo[] = [
  { universeId: 1686885941, placeId: 4924922222, name: 'Brookhaven 🏡RP' },
  { universeId: 994732206, placeId: 2753915549, name: 'Blox Fruits' },
  { universeId: 66654135, placeId: 142823291, name: 'Murder Mystery 2' },
  { universeId: 7326934954, placeId: 79546208627805, name: '99 Nights in the Forest 🔦' },
  { universeId: 383310974, placeId: 920587237, name: 'Adopt Me!' },
  { universeId: 2440500124, placeId: 6516141723, name: 'DOORS' },
  { universeId: 703124385, placeId: 1962086868, name: 'Tower of Hell' },
  { universeId: 1176784616, placeId: 3260590327, name: 'Tower Defense Simulator' },
];

export interface RobloxClientDeps {
  /** Injected in tests. Default: Electron's net.fetch (Chromium stack, OS proxy). */
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface RobloxClient {
  /** A pasted link resolves to one game; anything else is a search. */
  resolve(input: string): Promise<BackseatGameResolveResult>;
  /** The live "top playing now" list (fallback list when it cannot load). */
  popular(): Promise<BackseatGameInfo[]>;
  /** Full details for one experience (cached), or null when unavailable. */
  details(universeId: number): Promise<BackseatGameInfo | null>;
}

type Json = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly resetMs: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const posInt = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/** The reset of a rate-limit response, in ms: `x-ratelimit-reset` (seconds
 *  to the window's end) beats `retry-after`, which Roblox sets to 5 while the
 *  window it guards is a full minute. */
function resetFromHeaders(headers: Headers): number | null {
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return reset * 1000;
  const retry = Number(headers.get('retry-after'));
  if (Number.isFinite(retry) && retry > 0) return retry * 1000;
  return null;
}

/** Parse one games.roblox.com/v1/games row. */
export function parseGameRow(row: unknown): BackseatGameInfo | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Json;
  const universeId = posInt(r.id);
  const name = str(r.name);
  if (!universeId || !name) return null;
  const creator = (r.creator ?? {}) as Json;
  const creatorType = creator.type === 'Group' || creator.type === 'User' ? creator.type : undefined;
  // genre_l1 / genre_l2 are the current taxonomy ("Roleplay & Avatar Sim",
  // "Life"); `genre` is the legacy one ("Town and City"), kept as a fallback.
  const genre = [str(r.genre_l1), str(r.genre_l2)].filter(Boolean).join(', ') || str(r.genre);
  return {
    universeId,
    placeId: posInt(r.rootPlaceId),
    name,
    creator: str(creator.name),
    creatorType,
    playing: num(r.playing),
    genre: genre && genre !== 'All' ? genre : undefined,
    description: str(r.description),
    maxPlayers: posInt(r.maxPlayers),
    visits: num(r.visits),
  };
}

/** Parse an omni-search response into games (sponsored rows dropped). */
export function parseSearch(body: unknown): BackseatGameInfo[] {
  const groups = (body as Json | null)?.searchResults;
  if (!Array.isArray(groups)) return [];
  const out: BackseatGameInfo[] = [];
  const seen = new Set<number>();
  for (const g of groups) {
    if ((g as Json)?.contentGroupType !== 'Game') continue;
    const contents = (g as Json).contents;
    if (!Array.isArray(contents)) continue;
    for (const c of contents as Json[]) {
      if (c.isSponsored === true) continue;
      if (c.contentType !== undefined && c.contentType !== 'Game') continue;
      const universeId = posInt(c.universeId) ?? posInt(c.contentId);
      const name = str(c.name);
      if (!universeId || !name || seen.has(universeId)) continue;
      seen.add(universeId);
      out.push({
        universeId,
        placeId: posInt(c.rootPlaceId),
        name,
        creator: str(c.creatorName),
        playing: num(c.playerCount),
      });
    }
  }
  return out;
}

/** Parse the explore sorts: the ordered popular list plus the whole pool. */
export function parseSorts(body: unknown): { popular: BackseatGameInfo[]; pool: BackseatGameInfo[] } {
  const sorts = (body as Json | null)?.sorts;
  if (!Array.isArray(sorts)) return { popular: [], pool: [] };
  const toInfo = (g: Json): BackseatGameInfo | null => {
    if (g.isSponsored === true) return null;
    const universeId = posInt(g.universeId);
    const name = str(g.name);
    if (!universeId || !name) return null;
    return { universeId, placeId: posInt(g.rootPlaceId), name, playing: num(g.playerCount) };
  };
  const pool = new Map<number, BackseatGameInfo>();
  let popular: BackseatGameInfo[] = [];
  for (const s of sorts as Json[]) {
    const games = Array.isArray(s.games) ? (s.games as Json[]) : [];
    const infos = games.map(toInfo).filter((g): g is BackseatGameInfo => !!g);
    if (s.sortId === 'top-playing-now') popular = infos;
    for (const g of infos) if (!pool.has(g.universeId)) pool.set(g.universeId, g);
  }
  return { popular, pool: [...pool.values()] };
}

/** Parse thumbnails.roblox.com icons into universeId -> URL. */
export function parseIcons(body: unknown): Map<number, string> {
  const out = new Map<number, string>();
  const data = (body as Json | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const d of data as Json[]) {
    const id = posInt(d.targetId);
    const url = str(d.imageUrl);
    // Only Roblox's own CDN: the renderer loads this straight into an <img>.
    if (id && url && d.state === 'Completed' && /^https:\/\/[a-z0-9.-]+\.rbxcdn\.com\//i.test(url)) {
      out.set(id, url);
    }
  }
  return out;
}

/** Fold a query for matching: case, emoji, brackets and punctuation go. */
export function foldName(s: string): string {
  return s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Popular-pool matches for a query: every query word in the name. */
export function matchPool(pool: readonly BackseatGameInfo[], query: string): BackseatGameInfo[] {
  const words = foldName(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  return pool
    .filter((g) => {
      const name = foldName(g.name);
      return words.every((w) => name.includes(w));
    })
    .sort((a, b) => (b.playing ?? 0) - (a.playing ?? 0))
    .slice(0, MAX_RESULTS);
}

export function createRobloxClient(deps: RobloxClientDeps = {}): RobloxClient {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  // One session id per client, the way the Roblox site sends one per visit.
  const sessionId = randomUUID();

  const details = new Map<number, { at: number; game: BackseatGameInfo }>();
  const icons = new Map<number, { at: number; url: string }>();
  const universeOf = new Map<number, number>();
  const searches = new Map<string, { at: number; results: BackseatGameInfo[] }>();
  let sorts: { at: number; ok: boolean; popular: BackseatGameInfo[]; pool: BackseatGameInfo[] } | null = null;
  let sortsInFlight: Promise<void> | null = null;
  let searchBlockedUntil = 0;

  async function getJson(url: string): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const doFetch = deps.fetch ?? ((await import('electron')).net.fetch as typeof fetch);
      const res = await doFetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new HttpError(res.status, res.status === 429 ? resetFromHeaders(res.headers) : null);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Icons for games that lack one, in one batched call. Best effort. */
  async function withIcons(games: BackseatGameInfo[]): Promise<BackseatGameInfo[]> {
    const t = now();
    const missing = games
      .map((g) => g.universeId)
      .filter((id) => {
        const hit = icons.get(id);
        return !hit || t - hit.at > DETAILS_TTL_MS;
      });
    if (missing.length) {
      try {
        const got = parseIcons(await getJson(ROBLOX_ENDPOINTS.icons(missing.slice(0, 30))));
        for (const [id, url] of got) icons.set(id, { at: t, url });
      } catch {
        /* no icons is fine; the row shows a placeholder */
      }
    }
    return games.map((g) => {
      const icon = icons.get(g.universeId)?.url;
      return icon && !g.iconUrl ? { ...g, iconUrl: icon } : g;
    });
  }

  async function loadSorts(): Promise<void> {
    const t = now();
    if (sorts && t - sorts.at < (sorts.ok ? POPULAR_TTL_MS : POPULAR_FAIL_TTL_MS)) return;
    if (!sortsInFlight) {
      sortsInFlight = (async () => {
        try {
          const parsed = parseSorts(await getJson(ROBLOX_ENDPOINTS.sorts(sessionId)));
          const ok = parsed.popular.length > 0;
          sorts = { at: now(), ok, ...parsed };
        } catch {
          sorts = { at: now(), ok: false, popular: [], pool: sorts?.pool ?? [] };
        }
      })().finally(() => {
        sortsInFlight = null;
      });
    }
    await sortsInFlight;
  }

  async function fetchDetails(universeId: number): Promise<BackseatGameInfo | null> {
    const hit = details.get(universeId);
    if (hit && now() - hit.at < DETAILS_TTL_MS) return hit.game;
    const body = (await getJson(ROBLOX_ENDPOINTS.games([universeId]))) as Json;
    const rows = Array.isArray(body?.data) ? (body.data as unknown[]) : [];
    const game = rows.map(parseGameRow).find((g) => g?.universeId === universeId) ?? null;
    if (!game) return null;
    const [withIcon] = await withIcons([game]);
    details.set(universeId, { at: now(), game: withIcon });
    return withIcon;
  }

  async function resolveLink(placeId: number): Promise<BackseatGameResolveResult> {
    try {
      let universeId = universeOf.get(placeId);
      if (!universeId) {
        const body = (await getJson(ROBLOX_ENDPOINTS.placeUniverse(placeId))) as Json;
        universeId = posInt(body?.universeId);
        if (!universeId) return { kind: 'error', code: 'not_found' };
        universeOf.set(placeId, universeId);
      }
      const game = await fetchDetails(universeId);
      return game ? { kind: 'game', game } : { kind: 'error', code: 'not_found' };
    } catch (err) {
      // A 400/404 for a malformed or deleted place is "not found", not an outage.
      if (err instanceof HttpError && (err.status === 400 || err.status === 404)) {
        return { kind: 'error', code: 'not_found' };
      }
      return { kind: 'error', code: 'network' };
    }
  }

  async function search(query: string): Promise<BackseatGameResolveResult> {
    const key = foldName(query) || query.trim().toLowerCase();
    const hit = searches.get(key);
    if (hit && now() - hit.at < SEARCH_TTL_MS) return { kind: 'results', results: hit.results };

    const fromPool = async (
      fallback: 'rate_limited' | 'unavailable',
    ): Promise<BackseatGameResolveResult> => {
      await loadSorts();
      const results = await withIcons(matchPool(sorts?.pool ?? [], query));
      return { kind: 'results', results, fallback };
    };

    if (now() < searchBlockedUntil) return fromPool('rate_limited');
    try {
      const found = parseSearch(await getJson(ROBLOX_ENDPOINTS.search(query, sessionId)));
      const results = await withIcons(found.slice(0, MAX_RESULTS));
      if (searches.size >= SEARCH_CACHE_MAX) {
        const oldest = searches.keys().next().value;
        if (oldest !== undefined) searches.delete(oldest);
      }
      searches.set(key, { at: now(), results });
      return { kind: 'results', results };
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        searchBlockedUntil = now() + (err.resetMs ?? SEARCH_COOLDOWN_MS);
        return fromPool('rate_limited');
      }
      return fromPool('unavailable');
    }
  }

  return {
    async resolve(input) {
      const text = input.trim().slice(0, 200);
      if (!text) return { kind: 'results', results: [] };
      const link = parseRobloxLink(text);
      if (link) return resolveLink(link.placeId);
      if (looksLikeLink(text)) return { kind: 'error', code: 'bad_link' };
      return search(text);
    },

    async popular() {
      await loadSorts();
      const list = sorts?.popular.length ? sorts.popular : [...FALLBACK_POPULAR];
      return withIcons(list.slice(0, POPULAR_COUNT));
    },

    async details(universeId) {
      if (!Number.isSafeInteger(universeId) || universeId <= 0) return null;
      try {
        return await fetchDetails(universeId);
      } catch {
        return null;
      }
    },
  };
}

let shared: RobloxClient | null = null;

/** The app-wide client, so the pick step and the session share one cache. */
export function robloxClient(): RobloxClient {
  shared ??= createRobloxClient();
  return shared;
}
