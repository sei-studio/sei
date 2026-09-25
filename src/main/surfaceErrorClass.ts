/**
 * surface_error classifier (260828, extended 260926).
 *
 * Maps a caught LLM-surface error (chat, chess, Draw!, backseat, TTS) to a
 * short stable snake token for `surface_error.error_class`. Shape only: the
 * MESSAGE never leaves the machine through this path, it is only sniffed.
 *
 * 260926: every local/Ollama/BYOK failure landed in `unknown` (or
 * `turn_unknown` on backseat): 180 events from one Ollama user in 30 days,
 * none of them diagnosable. The classes below come from the error shapes our
 * providers actually produce:
 *
 *  - src/main/llm/ollama.ts, openaiCompat.ts, gemini.ts throw
 *    `Error("<kind> API <status>: <body up to 500 chars>")` on a non-2xx.
 *    Ollama bodies look like {"error":"model \"x\" not found, try pulling it
 *    first"}, {"error":"x does not support tools"}, {"error":"model requires
 *    more system memory (...)"}. OpenAI-compatible bodies carry
 *    `model_not_found`, `context_length_exceeded`, `insufficient_quota`,
 *    `invalid_api_key`. Gemini: "models/x is not found", "API key not valid",
 *    RESOURCE_EXHAUSTED.
 *  - The Anthropic SDK (BYOK and cloud) throws APIError subclasses with a
 *    numeric `.status` and a message like `400 {"type":"error","error":
 *    {"type":"invalid_request_error","message":"prompt is too long: ..."}}`;
 *    connection failures are APIConnectionError("Connection error.") with the
 *    fetch error as `.cause`, timeouts APIConnectionTimeoutError("Request
 *    timed out.").
 *  - A server that is not listening (Ollama not running, wrong port) is
 *    undici's `TypeError("fetch failed")` with `cause.code = "ECONNREFUSED"`
 *    (sometimes an AggregateError of one per address family). That used to
 *    read as the generic `network`; it is the single most common local
 *    setup mistake, so it gets its own class.
 *  - `LOCAL_NO_API_KEY: ...` (llm/index.ts, chat/sdk.ts) when a BYOK
 *    provider has no saved key.
 *
 * Existing tokens keep their meaning so dashboards stay continuous:
 * aborted, payment_required, rate_limited, auth, timeout, network, unknown.
 */

export type SurfaceErrorClass =
  | 'aborted'
  | 'no_api_key'
  | 'config'
  | 'payment_required'
  | 'rate_limited'
  | 'auth'
  | 'model_not_found'
  | 'context_length'
  | 'tools_unsupported'
  | 'out_of_memory'
  | 'not_found'
  | 'request_too_large'
  | 'bad_request'
  | 'server_error'
  | 'timeout'
  | 'connection_refused'
  | 'tls'
  | 'network'
  | 'bad_response'
  | 'internal_error'
  | 'unknown';

type Errish = {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  code?: unknown;
  cause?: unknown;
  errors?: unknown;
};

function asErrish(v: unknown): Errish | null {
  return v && typeof v === 'object' ? (v as Errish) : null;
}

/** Every `.code` on the error, its `.cause` chain, and AggregateError members. */
function collectCodes(err: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number): void => {
    const e = asErrish(v);
    if (!e || seen.has(e) || depth > 5) return;
    seen.add(e);
    if (typeof e.code === 'string' && e.code) out.push(e.code.toUpperCase());
    visit(e.cause, depth + 1);
    if (Array.isArray(e.errors)) for (const m of e.errors.slice(0, 8)) visit(m, depth + 1);
  };
  visit(err, 0);
  return out;
}

/** Messages of the error and its cause chain, lowercased and joined. */
function collectMessages(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null && !seen.has(cur); i++) {
    seen.add(cur);
    const e = asErrish(cur);
    if (!e) {
      parts.push(String(cur));
      break;
    }
    if (e.message != null) parts.push(String(e.message));
    cur = e.cause;
  }
  return parts.join(' | ').toLowerCase();
}

/**
 * The HTTP status, from a numeric `.status` (Anthropic/OpenAI SDKs) or our
 * providers' "<kind> API 404: ..." message, or an SDK message that starts
 * with the status ("400 {...}").
 */
function httpStatusOf(err: unknown, msg: string): number | null {
  const s = asErrish(err)?.status;
  if (typeof s === 'number' && s >= 100 && s <= 599) return s;
  const m = msg.match(/\bapi (\d{3})\b/) ?? msg.match(/^(\d{3})\b/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 100 && n <= 599) return n;
  }
  return null;
}

const CONN_REFUSED_CODES = new Set(['ECONNREFUSED']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);
const TLS_CODE_RE = /^(CERT_|ERR_TLS|ERR_SSL|SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_(GET|VERIFY)|ERR_OSSL)/;

// Body sniffs. Checked before the bare status so a 400 that says "context
// length" or a 429 that says "insufficient_quota" gets the specific class.
const PAYMENT_RE = /\b402\b|payment|insufficient_quota|credit balance|billing|out of credits/;
const CONTEXT_RE =
  /context_length|context length|context window|prompt is too long|too many tokens|maximum context|input (is )?too long|reduce the length|exceeds the (maximum )?(number of )?tokens/;
const TOOLS_RE = /does not support tools|(tool use|tools|function calling) (is |are )?not supported/;
const MODEL_RE =
  /model_not_found|model[^|]{0,80}not found|model[^|]{0,80}does not exist|try pulling it|no such model|unknown model|invalid model|models\/[^\s|]+ is not found|not_found_error[^|]{0,80}model/;
const OOM_RE = /requires more system memory|out of memory|insufficient memory|cuda error|\boom\b/;
const AUTH_RE =
  /unauthorized|authentication_error|invalid[^|]{0,20}api[^|]{0,5}key|api key not valid|x-api-key|permission_error|incorrect api key/;
const RATE_RE = /rate.?limit|throttl|overloaded|resource_exhausted|too many requests/;
const TIMEOUT_RE = /timeout|timed.?out/;
const NETWORK_RE =
  /enotfound|enetunreach|getaddrinfo|econnreset|fetch failed|network|offline|socket|connection error/;

export function surfaceErrorClass(err: unknown): SurfaceErrorClass {
  const e = asErrish(err);
  const name = e?.name != null ? String(e.name) : '';
  const msg = collectMessages(err);
  const codes = collectCodes(err);

  // A provider's own request deadline (llm/timeout.ts). Checked before the
  // abort test: the underlying fetch was aborted, but nobody cancelled it.
  if (e?.code === 'LLM_TIMEOUT' || name === 'LlmTimeoutError' || msg.startsWith('llm_timeout')) return 'timeout';
  // A user/supersede abort. Surfaces filter these before reporting, but keep
  // the token stable for any caller that does not.
  if (name === 'AbortError' || name === 'APIUserAbortError' || /abort/.test(msg)) return 'aborted';
  if (msg.includes('local_no_api_key')) return 'no_api_key';
  if (/has no base url configured/.test(msg)) return 'config';

  // Transport, from the undici cause chain first (the message is just
  // "fetch failed" / "Connection error.").
  if (codes.some((c) => CONN_REFUSED_CODES.has(c)) || msg.includes('econnrefused')) return 'connection_refused';
  if (codes.some((c) => TLS_CODE_RE.test(c)) || /certificate|self.signed|ssl/.test(msg)) return 'tls';
  if (codes.some((c) => TIMEOUT_CODES.has(c))) return 'timeout';
  if (codes.some((c) => NETWORK_CODES.has(c))) return 'network';

  const status = httpStatusOf(err, msg);

  if (PAYMENT_RE.test(msg) || status === 402) return 'payment_required';
  if (CONTEXT_RE.test(msg)) return 'context_length';
  if (TOOLS_RE.test(msg)) return 'tools_unsupported';
  if (MODEL_RE.test(msg)) return 'model_not_found';
  if (OOM_RE.test(msg)) return 'out_of_memory';

  if (status != null) {
    if (status === 429) return 'rate_limited';
    if (status === 401 || status === 403) return 'auth';
    if (status === 408 || status === 504) return 'timeout';
    if (status === 413) return 'request_too_large';
    if (status === 404) return 'not_found';
    if (status === 529 || status === 503) return 'rate_limited'; // overloaded (kept with rate_limited)
    if (status >= 500) return 'server_error';
    if (status >= 400) return AUTH_RE.test(msg) ? 'auth' : 'bad_request';
  }

  if (RATE_RE.test(msg)) return 'rate_limited';
  if (AUTH_RE.test(msg)) return 'auth';
  if (TIMEOUT_RE.test(msg)) return 'timeout';
  if (NETWORK_RE.test(msg)) return 'network';

  // A reply that was not the JSON the provider promised.
  if (name === 'SyntaxError' || /unexpected token|not valid json|unexpected end of json/.test(msg)) {
    return 'bad_response';
  }
  // A bug on our side (a mapper read a field that was not there, ...).
  if (name === 'TypeError' || name === 'ReferenceError' || name === 'RangeError') return 'internal_error';
  return 'unknown';
}
