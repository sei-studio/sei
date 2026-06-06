/**
 * Phase 13 — PROXY_* error sentinel strings.
 *
 * Vocabulary used by `src/main/cloud/proxyClient.ts` to communicate billing /
 * trial / checkout failures back to renderer-side ERROR_COPY maps. Mirrors the
 * `CLOUD_*` convention from Plan 11 — the prefix lets the renderer route by
 * substring without re-deserializing structured errors.
 *
 * Used by:
 *   - `proxyClient.ts` — returns these as the `code` field on `{ ok: false }`.
 *   - Renderer Wave 3 screens (13-17 CreditsScreen, 13-18 HardStopModal,
 *     13-19 PricingIcon) for user-facing copy resolution.
 *
 * Source: 13-13-PLAN must_haves §"Sentinel error vocabulary".
 */

export const PROXY_TIMEOUT = 'PROXY_TIMEOUT';
export const PROXY_PAYMENT_REQUIRED = 'PROXY_PAYMENT_REQUIRED';
export const PROXY_RATE_LIMITED = 'PROXY_RATE_LIMITED';
export const PROXY_SERVICE_AT_CAPACITY = 'PROXY_SERVICE_AT_CAPACITY';
export const PROXY_INVALID_JWT = 'PROXY_INVALID_JWT';
export const PROXY_ALREADY_CLAIMED = 'PROXY_ALREADY_CLAIMED';
/**
 * The trial was refused by the per-DEVICE anti-abuse gate (this machine already
 * spent its one trial, possibly under a DIFFERENT account) rather than the
 * per-account gate. The Edge Function returns the same uniform 202 for both
 * dispositions, so `trialClaim()` disambiguates by checking whether THIS account
 * actually holds a kind='trial' grant: present → PROXY_ALREADY_CLAIMED, absent
 * (the grant never landed on this account) → PROXY_DEVICE_CLAIMED. Renderer
 * shows honest "this device already used its free trial" copy instead of the
 * misleading "you already claimed" + a dead-end re-clickable button.
 */
export const PROXY_DEVICE_CLAIMED = 'PROXY_DEVICE_CLAIMED';
export const PROXY_NO_SESSION = 'PROXY_NO_SESSION';
export const PROXY_NETWORK = 'PROXY_NETWORK';
/**
 * The proxy's /billing/customer-portal route returned no portal URL — either
 * the user has no Polar customer record the proxy could find, the Polar API
 * call failed, or POLAR_ACCESS_TOKEN is not configured on the proxy. Renderer
 * shows a "Couldn't open the billing portal" toast with a support email.
 */
export const PROXY_NO_PORTAL_URL = 'PROXY_NO_PORTAL_URL';

export type ProxyErrorCode =
  | typeof PROXY_TIMEOUT
  | typeof PROXY_PAYMENT_REQUIRED
  | typeof PROXY_RATE_LIMITED
  | typeof PROXY_SERVICE_AT_CAPACITY
  | typeof PROXY_INVALID_JWT
  | typeof PROXY_ALREADY_CLAIMED
  | typeof PROXY_DEVICE_CLAIMED
  | typeof PROXY_NO_SESSION
  | typeof PROXY_NETWORK
  | typeof PROXY_NO_PORTAL_URL;
