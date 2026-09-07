/**
 * Region detection for the W7 region gate (260816).
 *
 * One GET to the Cloudflare-fronted proxy's trace endpoint, parsed for the
 * `loc=CC` line, cached in memory for the process lifetime with a 24h
 * refresh. Everything unhappy — network error, timeout, non-2xx, absent or
 * junk loc — resolves to `loc: null` (= 'unknown'), and unknown is ALLOWED:
 * the gate FAILS OPEN so a detection hiccup never blocks a legitimate user.
 *
 * A failed lookup is cached on a much shorter TTL than a successful one, so
 * a transient boot-time network failure does not disable the gate for a
 * whole day, while a healthy answer is not re-fetched per auth attempt.
 *
 * Consumers:
 *   - src/main/auth/authHandlers.ts — the AUTHORITATIVE gate, checked before
 *     signInWithPassword / signUpWithPassword / signInWithGoogle run.
 *   - the `region:status` IPC handler — the renderer's pre-check so the
 *     blocking popup can appear before a failed submit.
 */
import { isRegionBlocked, parseTraceLoc, type RegionStatus } from '../shared/regionGate';

const TRACE_URL = 'https://api.sei.gg/cdn-cgi/trace';
const TRACE_TIMEOUT_MS = 5_000;
/** A real answer holds for a day; IP region does not change mid-session. */
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
/** A failed lookup retries sooner — 'unknown' should heal once the network does. */
const FAILURE_TTL_MS = 10 * 60 * 1000;

let cache: { loc: string | null; at: number } | null = null;
let inFlight: Promise<string | null> | null = null;

/**
 * One uncached trace fetch. Never rejects — every failure mode is null.
 * `fetchImpl` is injectable for tests only.
 *
 * The default is Electron's `net.fetch` (Chromium network stack), NOT the
 * global Node/undici `fetch`: undici ignores HTTP(S)_PROXY and the OS system
 * proxy, so on a proxied machine whose direct egress geolocates differently
 * (seen live: proxy exit JP, direct HK) the probe saw a country the user's
 * browser never touches and produced a false "region blocked". It is resolved
 * LAZILY via dynamic import because this module's tests run under vitest
 * without Electron — a top-level `import { net } from 'electron'` would break
 * them.
 */
export async function detectRegionLoc(fetchImpl?: typeof fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRACE_TIMEOUT_MS);
  try {
    const doFetch = fetchImpl ?? ((await import('electron')).net.fetch as typeof fetch);
    const res = await doFetch(TRACE_URL, { signal: controller.signal });
    if (!res.ok) return null;
    return parseTraceLoc(await res.text());
  } catch {
    // Network error, abort (timeout), or a body that failed to read.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cached region verdict. Single-flight: concurrent callers (an auth submit
 * racing the renderer pre-check) share one fetch.
 */
export async function getRegionStatus(fetchImpl?: typeof fetch): Promise<RegionStatus> {
  if (cache !== null) {
    const ttl = cache.loc === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
    if (Date.now() - cache.at < ttl) {
      return { loc: cache.loc, blocked: isRegionBlocked(cache.loc) };
    }
  }
  if (inFlight === null) {
    inFlight = detectRegionLoc(fetchImpl)
      .then((loc) => {
        cache = { loc, at: Date.now() };
        return loc;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  const loc = await inFlight;
  return { loc, blocked: isRegionBlocked(loc) };
}

/** Test hook: drop the cache + in-flight fetch between cases. */
export function resetRegionCacheForTest(): void {
  cache = null;
  inFlight = null;
}
