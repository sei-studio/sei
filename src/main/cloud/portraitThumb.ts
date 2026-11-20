/**
 * World grid thumbnail refresh (261111). MAIN PROCESS ONLY.
 *
 * The World grid shows `portraits/<owner>/<id>.thumb.webp` instead of the full
 * portrait. The proxy makes that thumbnail from the STORED portrait (the app
 * never uploads one, so it cannot differ from the moderated image):
 * `POST <proxy>/portraits/v1/:id/thumb`, owner only, shared characters only.
 * After writing it the proxy bumps characters.updated_at, which is the `?v=`
 * of every portrait / thumbnail URL (shared/portraitUrls.ts).
 *
 * Called fire-and-forget after a publish and after a shared character's
 * portrait bytes were actually uploaded. Never throws. A request for an id
 * that is already in flight is coalesced into ONE follow-up run, so a burst
 * of saves costs at most two calls and the last one sees the latest bytes.
 * Without a thumbnail (proxy down, older proxy, skipped) the grid falls back
 * to the full portrait.
 */

const PROXY_BASE = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
const TIMEOUT_MS = 30_000;

export type ThumbOutcome = 'ready' | 'skipped' | 'no_session' | 'failed';

export interface ThumbDeps {
  getJwt: () => Promise<string | null>;
  fetchImpl: typeof fetch;
  log: (m: string) => void;
}

async function defaultJwt(): Promise<string | null> {
  try {
    const { getClient } = await import('../auth/supabaseClient');
    const { data } = await getClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

const defaultDeps: ThumbDeps = {
  getJwt: defaultJwt,
  fetchImpl: (...a) => fetch(...a),
  log: (m) => console.log(m),
};

/** One call to the proxy route. Never throws. */
export async function callThumbRoute(characterId: string, deps: ThumbDeps = defaultDeps): Promise<ThumbOutcome> {
  const jwt = await deps.getJwt();
  if (!jwt) return 'no_session';
  try {
    const res = await deps.fetchImpl(`${PROXY_BASE}/portraits/v1/${encodeURIComponent(characterId)}/thumb`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      deps.log(`[sei] portrait thumb ${characterId}: HTTP ${res.status}`);
      return 'failed';
    }
    const body = (await res.json().catch(() => null)) as { state?: string; reason?: string } | null;
    if (body?.state === 'ready') return 'ready';
    deps.log(`[sei] portrait thumb ${characterId}: skipped (${body?.reason ?? 'unknown'})`);
    return 'skipped';
  } catch (err) {
    deps.log(`[sei] portrait thumb ${characterId}: ${(err as Error).message}`);
    return 'failed';
  }
}

const inFlight = new Map<string, { promise: Promise<void>; again: boolean }>();

/**
 * Ask the proxy to (re)make a character's World thumbnail. Fire-and-forget;
 * the returned promise is for tests and resolves when the work (including a
 * coalesced follow-up) is done.
 */
export function requestPortraitThumb(characterId: string, deps: ThumbDeps = defaultDeps): Promise<void> {
  const cur = inFlight.get(characterId);
  if (cur) {
    cur.again = true;
    return cur.promise;
  }
  const entry = { promise: Promise.resolve(), again: false };
  entry.promise = (async () => {
    try {
      do {
        entry.again = false;
        await callThumbRoute(characterId, deps);
      } while (entry.again);
    } finally {
      inFlight.delete(characterId);
    }
  })();
  inFlight.set(characterId, entry);
  return entry.promise;
}
