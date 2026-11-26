/**
 * 261125 (O5): keep a pooled connection to the Sei proxy warm ahead of a
 * request the player is about to make.
 *
 * Node's fetch (undici) closes an idle pooled connection after 4 s, and a
 * player types (or talks) for longer than that between turns, so without a
 * warm-up every typed chat turn on the cloud backend opened a fresh TCP + TLS
 * connection to api.sei.gg before its LLM request could go out.
 *
 * The request is a GET of /health on purpose. The 260724 voice prewarm sent
 * HEAD to the origin root, and the proxy edge answers every HEAD with
 * `connection: close` (measured 261125 with undici's connect diagnostics: a
 * POST right after `HEAD /` or `HEAD /health` still opened a NEW connection,
 * while one after `GET /health` reused it). So that prewarm resolved DNS and
 * cached a TLS session but left no connection to reuse.
 *
 * Best-effort: never throws, any status counts (only the connection
 * matters), throttled so bursty callers (keystrokes, mic frames) cannot stack
 * requests. The 3 s throttle sits under the 4 s idle window, so a burst of
 * typing keeps the connection alive until the send.
 */

export const PROXY_PREWARM_MIN_INTERVAL_MS = 3_000;
const PREWARM_TIMEOUT_MS = 3_000;

let lastAt = 0;

/** The proxy origin, read per call so tests (and SEI_PROXY_URL) can point it elsewhere. */
function proxyBaseUrl(): string {
  return process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
}

/**
 * Fire one GET /health at the proxy unless one went out in the last
 * PROXY_PREWARM_MIN_INTERVAL_MS. Returns whether a request was sent (tests).
 */
export function prewarmProxyConnection(opts: { now?: number; fetchImpl?: typeof fetch } = {}): boolean {
  const now = opts.now ?? Date.now();
  if (now - lastAt < PROXY_PREWARM_MIN_INTERVAL_MS) return false;
  lastAt = now;
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  void (async () => {
    try {
      const res = await doFetch(`${proxyBaseUrl()}/health`, { method: 'GET', signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS) });
      // Read the (tiny) body so the connection goes back to the pool idle.
      await res.arrayBuffer();
    } catch {
      /* best-effort */
    }
  })();
  return true;
}

/**
 * The ChatGPT plan's model catalog is read on the turn when it is not cached
 * yet (llm/index.ts resolveChatgptModel: /v1/models, bounded at 6 s, before
 * the provider is ready). It is cached in memory only, so the first typed
 * turn of every app run paid that round trip to chatgpt.com. While the player
 * types, fetch it ahead so the turn reads the cache. The turn picks the same
 * model it would have after fetching it itself; a failed prefetch changes
 * nothing (the turn fetches as before) and is not retried for a minute.
 */
export const CHATGPT_CATALOG_PREFETCH_RETRY_MS = 60_000;
let catalogAttemptAt = 0;

async function prefetchChatgptCatalog(now: number): Promise<boolean> {
  const { chatgptSession } = await import('./chatgptPlan');
  const s = chatgptSession();
  if (s.cachedModels().length > 0) return false;
  if (now - catalogAttemptAt < CHATGPT_CATALOG_PREFETCH_RETRY_MS) return false;
  catalogAttemptAt = now;
  void s.listModels().catch(() => {});
  return true;
}

/**
 * Typed chat (renderer `chat:prewarm`, sent while the player types). Cloud
 * backend: warm the proxy connection. ChatGPT plan: prefetch the model
 * catalog (which also opens the connection to chatgpt.com). Other own-key
 * providers are left alone. Never throws.
 */
export async function prewarmChatUpstream(opts: { now?: number } = {}): Promise<boolean> {
  try {
    const now = opts.now ?? Date.now();
    const { getAiBackendKind } = await import('./apiKeyStore');
    if ((await getAiBackendKind()) === 'cloud-proxy') return prewarmProxyConnection({ now });
    const { localProviderKind } = await import('./llm');
    if ((await localProviderKind()) === 'chatgpt') return await prefetchChatgptCatalog(now);
    return false;
  } catch {
    return false;
  }
}

/** Tests only. */
export function _resetProxyPrewarm(): void {
  lastAt = 0;
  catalogAttemptAt = 0;
}
