// src/main/lib/externalUrlValidator.ts
//
// 260525-s09 H5: shared source-of-truth for the https-allowlist + mailto-allowlist
// used by every `shell.openExternal` call site. Adding a host here = trusting it
// not to host malicious downloads or phishing. Fixed hosts use exact-equality;
// the `.polar.sh` suffix rule is DOT-ANCHORED, so a look-alike like
// `evil.polar.sh.attacker.tld` is rejected even though it CONTAINS an
// allowlisted label as a substring.
//
// Allowlist provenance (preserves prior ipc.ts inline list verbatim, plus the
// Polar billing hosts required by openCheckout / cancelSubscription):
//  - 'sei.gg' / 'www.sei.gg' — marketing + legal pages (Phase 11).
//  - 'dmca.copyright.gov' — DMCA Designated Agent Directory (Phase 12-17).
//  - 'polar.sh' (+ the '.polar.sh' SUFFIX rule below) — Polar (Merchant of
//    Record) hosted checkout + customer portal. Sei migrated off Lemon Squeezy
//    to Polar in 2026-06. Polar serves these surfaces across several subdomains
//    (buy.polar.sh hosted checkout, sandbox.polar.sh test env, <org>.polar.sh
//    portal, …) and adds more over time, so we trust the whole polar.sh
//    registrable domain via a dot-anchored suffix match (see below) rather than
//    enumerate every subdomain. Required by openCheckout + cancelSubscription's
//    shell.openExternal calls.
//  - 'mailto:dmca@sei.gg' — DMCA contact (Phase 12-17; live DMCA registration
//    DMCA-1073551 filed against sei.gg domain with dmca@sei.gg → shawn@sei.gg
//    redirect, so the public-facing allowlist entry tracks the live domain).
//
// Protocol gate (https + mailto only) is enforced separately, so URLs like
// `javascript:alert(1)`, `data:text/html,<script>`, or `file:///etc/passwd`
// that happen to parse with a matching `hostname` field are still rejected.

export const ALLOWED_HTTPS_HOSTS = [
  'sei.gg',
  'www.sei.gg',
  'dmca.copyright.gov',
  'polar.sh',
] as const;

// Dot-anchored suffix allowlist. A host matches when it equals one of these
// suffixes' parent (handled by the exact list above) OR ends with the suffix —
// e.g. 'buy.polar.sh'.endsWith('.polar.sh') === true. The LEADING DOT is the
// security anchor: it rejects look-alikes like 'evilpolar.sh' (no dot) and
// 'polar.sh.attacker.tld' (ends with '.attacker.tld', not '.polar.sh').
export const ALLOWED_HTTPS_SUFFIXES = ['.polar.sh'] as const;

export const ALLOWED_MAILTO = ['dmca@sei.gg'] as const;

/**
 * Throws Error if `url` is not on the https-host or mailto allowlist.
 * Use at every site that calls `shell.openExternal` to keep that surface
 * single-sourced.
 *
 * Reject reasons:
 *  - Malformed URL → "rejected (malformed URL)".
 *  - Wrong protocol (anything other than https:/mailto:) → "rejected".
 *  - https host not on ALLOWED_HTTPS_HOSTS (exact equality) → "rejected".
 *  - mailto pathname not on ALLOWED_MAILTO (exact equality) → "rejected".
 */
export function assertSafeExternalUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`assertSafeExternalUrl rejected (malformed URL): ${url}`);
  }
  const isAllowedHttps =
    u.protocol === 'https:' &&
    ((ALLOWED_HTTPS_HOSTS as readonly string[]).includes(u.hostname) ||
      (ALLOWED_HTTPS_SUFFIXES as readonly string[]).some((s) => u.hostname.endsWith(s)));
  const isAllowedMailto =
    u.protocol === 'mailto:' &&
    (ALLOWED_MAILTO as readonly string[]).includes(u.pathname);
  if (!isAllowedHttps && !isAllowedMailto) {
    throw new Error(`assertSafeExternalUrl rejected: ${url}`);
  }
}
