/**
 * Region gate (W7, china-compat stream 260816).
 *
 * Users whose IP region is unsupported by Anthropic (the cloud LLM behind the
 * proxy) or by Polar/Stripe (billing) are blocked from SIGNING UP or LOGGING
 * IN to cloud mode, and steered to local (BYOK) mode instead. The gate is
 * client-side and applies to the auth flows ONLY:
 *
 *   - Existing signed-in sessions are untouched (no gate on session restore,
 *     sign-out, ToS checks, or anything for already-signed-in users).
 *   - Signed-out cloud-character Browse keeps working (anonymous through the
 *     /supabase proxy).
 *   - Detection FAILS OPEN: a failed/timed-out/absent lookup means 'unknown',
 *     and 'unknown' is ALLOWED.
 *
 * Detection itself (network fetch + cache) lives in src/main/regionDetect.ts;
 * this shared module is the pure vocabulary both processes agree on: the
 * blocklist, the classifier, the trace parser, the stable error token, and
 * the user-facing copy key.
 */

/**
 * Stable error token for a region-refused auth flow. Used as the `code` on
 * SignInResult/SignUpResult and the `reason` on OAuthResult, so every surface
 * can branch on one constant instead of string-matching copy.
 */
export const REGION_BLOCKED = 'region_blocked' as const;

/**
 * User-facing copy, exact per the 260816 decision. This English string is
 * ALSO the i18n key (the zh dictionary is keyed by the literal English
 * string), so renderer surfaces pass it through t()/useT() verbatim.
 */
export const REGION_BLOCKED_COPY =
  'Our servers do not currently support your region. Please continue with local mode.';

/** Shape returned by the `region:status` IPC pre-check. */
export interface RegionStatus {
  /** ISO 3166-1 alpha-2 country code, or null when detection failed/unknown. */
  loc: string | null;
  /** True when `loc` is in BLOCKED_REGIONS. Null loc is never blocked. */
  blocked: boolean;
}

/**
 * Regions blocked from cloud signup/login, as ISO 3166-1 alpha-2 codes.
 *
 * Compiled 2026-08-16 from three sources:
 *
 *   1. The china-compat stream decision: mainland China + Hong Kong + Macao
 *      (.planning/china-compat-v07-260816.md).
 *   2. The complement of Anthropic's published supported-countries list —
 *      https://www.anthropic.com/supported-countries (retrieved 2026-08-16).
 *      Every sovereign state and listed region NOT on that page appears
 *      below. Note the page's own carve-out for Ukraine (supported except
 *      Crimea/Donetsk/Kherson/Luhansk/Zaporizhzhia) is NOT expressible at
 *      country-code granularity (Cloudflare returns loc=UA for all of it),
 *      so UA stays allowed per the fail-open rule.
 *   3. Polar/Stripe restricted buyer regions — Polar supports payments
 *      globally except US-sanctioned countries (Cuba, Russia, Iran, North
 *      Korea, Syria): https://polar.sh/docs/merchant-of-record/supported-countries
 *      (retrieved 2026-08-16). All five are already excluded by (2), so
 *      Polar adds no codes beyond the Anthropic complement.
 *
 * Dependent territories of supported sovereigns (PR, GU, RE, GI, FO, AX,
 * BM, KY, ...) are deliberately NOT listed: Anthropic's page names countries,
 * a territory's status is ambiguous, and ambiguity fails open.
 *
 * Cloudflare's special codes (XX = unknown, T1 = Tor) are handled by
 * parseTraceLoc (mapped to null = unknown = allowed), never listed here.
 */
export const BLOCKED_REGIONS: ReadonlySet<string> = new Set([
  // Stream decision (260816): greater-China cloud block.
  'CN', // China (mainland)
  'HK', // Hong Kong
  'MO', // Macao
  // Complement of Anthropic's supported-countries list (source 2 above).
  'AF', // Afghanistan
  'BY', // Belarus
  'CD', // Congo (Kinshasa) / Democratic Republic of the Congo
  'CU', // Cuba (also Polar/Stripe OFAC-restricted)
  'IR', // Iran (also Polar/Stripe OFAC-restricted)
  'KP', // North Korea (also Polar/Stripe OFAC-restricted)
  'MM', // Myanmar
  'RU', // Russia (also Polar/Stripe OFAC-restricted)
  'SY', // Syria (also Polar/Stripe OFAC-restricted)
  'VE', // Venezuela
  'YE', // Yemen
  // Not named on Anthropic's list; strict complement, kept for review.
  'EH', // Western Sahara
  'XK', // Kosovo (Cloudflare's user-assigned code)
]);

/**
 * True when the detected region is blocked from cloud auth.
 *
 * Null / empty / 'unknown' / anything not a listed code returns false —
 * the gate FAILS OPEN by construction.
 */
export function isRegionBlocked(loc: string | null | undefined): boolean {
  if (!loc) return false;
  return BLOCKED_REGIONS.has(loc.trim().toUpperCase());
}

/**
 * Extract the `loc=CC` country code from a Cloudflare `/cdn-cgi/trace`
 * response body (verified live: api.sei.gg is Cloudflare-fronted and the
 * endpoint returns one `key=value` pair per line).
 *
 * Returns null for garbage, a missing loc line, or Cloudflare's non-country
 * codes (XX = unknown, T1 = Tor exit) — all of which mean 'unknown' and
 * therefore ALLOWED upstream.
 */
export function parseTraceLoc(body: string): string | null {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('loc=')) continue;
    const value = line.slice('loc='.length).trim().toUpperCase();
    // A country code is exactly two ASCII letters; XX/T1 are Cloudflare's
    // "no real country" markers.
    if (!/^[A-Z]{2}$/.test(value)) return null;
    if (value === 'XX') return null;
    return value;
  }
  return null;
}
