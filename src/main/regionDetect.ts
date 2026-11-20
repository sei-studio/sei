/**
 * Region detection for the W7 region gate (260816).
 *
 * One GET to the Cloudflare-fronted proxy's trace endpoint, parsed for the
 * `loc=CC` line. Everything unhappy — network error, timeout, non-2xx, absent or
 * junk loc — resolves to `loc: null` (= 'unknown'), and unknown is ALLOWED:
 * the gate FAILS OPEN so a detection hiccup never blocks a legitimate user.
 *
 * 261103 (T303): nothing is cached. Every auth attempt and every renderer
 * pre-check fetches the trace again, so the verdict follows the network the
 * user is on NOW (a VPN or network change after launch counts on the next
 * attempt, not after a restart). Only concurrent callers share one fetch.
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
 * Region verdict, fetched fresh on every call. Single-flight: concurrent
 * callers (an auth submit racing the renderer pre-check) share one fetch.
 */
export async function getRegionStatus(fetchImpl?: typeof fetch): Promise<RegionStatus> {
  if (inFlight === null) {
    inFlight = detectRegionLoc(fetchImpl).finally(() => {
      inFlight = null;
    });
  }
  const loc = await inFlight;
  return { loc, blocked: isRegionBlocked(loc) };
}

/** Test hook: drop the in-flight fetch between cases. */
export function resetRegionCacheForTest(): void {
  inFlight = null;
}
