// Provider region refusals (261103, T303).
//
// In local / BYOK mode Sei never pre-blocks by region: each provider decides,
// and when one refuses because of where the request comes from, the player is
// told so in one plain line ("<Provider> does not support your region.")
// instead of "your key was rejected" or a generic failure. The Sei cloud gate
// is separate (src/main/regionDetect.ts) and is not touched by this module.
//
// Pure and dependency-free so the bot (raw ESM), main (bundled) and the tests
// share it. Shapes it recognises, from the providers' own error bodies:
//  - Anthropic: HTTP 403 `{"type":"error","error":{"type":"forbidden",
//    "message":"Request not allowed"}}` for an unsupported region. A bare
//    `permission_error` is NOT a region answer on its own (Anthropic uses it
//    for "your key may not use this resource"), so it counts only when the
//    text also names a country / region / location.
//  - OpenAI (and OpenAI-shaped gateways): HTTP 403 with code
//    `unsupported_country_region_territory`, "Country, region, or territory
//    not supported". The ChatGPT OAuth token endpoint uses the same code.
//  - Gemini: HTTP 400 FAILED_PRECONDITION "User location is not supported
//    for the API use."
//  - Anything else that says, in so many words, that the service is not
//    available in the caller's country / region / location (OpenRouter and
//    other gateways pass the upstream line through). DeepSeek and Qwen
//    publish no region refusal code; they are covered only by that wording.

/** Tag main and the bot put on a region refusal they rethrow. */
export const PROVIDER_REGION_CODE = 'PROVIDER_REGION_UNSUPPORTED'

const REGION_CODE_RE = /unsupported_country(_region_territory)?|unsupported_region|country_not_supported|region_not_supported/
const REGION_TEXT_RE =
  /user location is not supported|country, region,? or territory (is )?not supported|(country|region|territory|location) (is )?not supported|unsupported (country|region|location)|not (available|supported|offered) in your (country|region|location|area)|(your|this) (country|region|location) is not (supported|available)/
const ANTHROPIC_FORBIDDEN_RE = /request not allowed/

/** @param {unknown} v */
function asObj(v) {
  return v && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v) : null
}

/**
 * Everything textual an error carries, lowercased: message and cause chain,
 * `.code` / `.type`, and an SDK's parsed `.error` body.
 * @param {unknown} err
 */
function errorText(err) {
  const parts = []
  const seen = new Set()
  let cur = err
  for (let i = 0; i < 5 && cur != null && !seen.has(cur); i++) {
    seen.add(cur)
    const e = asObj(cur)
    if (!e) {
      parts.push(String(cur))
      break
    }
    for (const k of ['message', 'code', 'type', 'oauthError']) {
      if (typeof e[k] === 'string') parts.push(e[k])
    }
    if (e.error != null) {
      try {
        parts.push(typeof e.error === 'string' ? e.error : JSON.stringify(e.error))
      } catch {
        /* circular body: the message is enough */
      }
    }
    cur = e.cause
  }
  return parts.join(' | ').toLowerCase()
}

/**
 * HTTP status from `.status` (SDK errors, OAuthError.httpStatus) or our
 * providers' "<kind> API 403: ..." / SDK "403 {...}" messages.
 * @param {unknown} err
 * @param {string} text
 */
function statusOf(err, text) {
  const e = asObj(err)
  for (const k of ['status', 'httpStatus']) {
    const s = e?.[k]
    if (typeof s === 'number' && s >= 100 && s <= 599) return s
  }
  const m = text.match(/\bapi (\d{3})\b/) ?? text.match(/^(\d{3})\b/)
  return m ? Number(m[1]) : null
}

/**
 * True when a provider refused the request because of the caller's region.
 * Never true for an abort, a network failure or a plain auth error.
 * @param {unknown} err  an Error, an SDK error, or a bare error code string
 */
export function isProviderRegionRefusal(err) {
  if (err == null) return false
  const text = typeof err === 'string' ? err.toLowerCase() : errorText(err)
  if (!text) return false
  if (text.includes(PROVIDER_REGION_CODE.toLowerCase())) return true
  if (REGION_CODE_RE.test(text) || REGION_TEXT_RE.test(text)) return true
  // Anthropic's region answer is only "Request not allowed", so it needs the 403.
  return statusOf(err, text) === 403 && ANTHROPIC_FORBIDDEN_RE.test(text)
}

/** Display name for the region line. Matches PROVIDER_LABELS
 * (src/shared/llmCatalog.ts) except where that label names a Sei feature
 * rather than the company (a test keeps the two in step). */
const REGION_PROVIDER_NAMES = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  chatgpt: 'OpenAI',
  deepseek: 'DeepSeek',
  qwen: 'Qwen (Alibaba)',
  gemini: 'Google Gemini',
  grok: 'Grok (xAI)',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  mistral: 'Mistral',
  together: 'Together',
  groq: 'Groq',
  fireworks: 'Fireworks',
  cerebras: 'Cerebras',
  perplexity: 'Perplexity',
}

/** @param {string | null | undefined} kind */
export function regionProviderName(kind) {
  return (kind && REGION_PROVIDER_NAMES[/** @type {keyof typeof REGION_PROVIDER_NAMES} */ (kind)]) || 'Your AI provider'
}

/** The one user-facing line. No em dashes, no workaround advice. */
export function providerRegionLine(name) {
  return `${name} does not support your region.`
}

/**
 * The error main and the bot rethrow for a region refusal: code
 * PROVIDER_REGION_UNSUPPORTED, message `PROVIDER_REGION_UNSUPPORTED[<name>]:
 * <line>` so a renderer that only sees the IPC message can still read the
 * provider name back (src/shared/providerRegion.ts).
 * @param {string | null | undefined} kind
 * @param {unknown} [cause]
 */
export function providerRegionError(kind, cause) {
  const name = regionProviderName(kind)
  const err = new Error(`${PROVIDER_REGION_CODE}[${name}]: ${providerRegionLine(name)}`)
  // @ts-ignore  tagged like the other typed provider errors
  err.code = PROVIDER_REGION_CODE
  // @ts-ignore
  err.providerName = name
  if (cause !== undefined) {
    // @ts-ignore
    err.cause = cause
  }
  return err
}
