// src/main/lib/externalUrlValidator.ts
//
// Shared gate for every `shell.openExternal` call site.
//
// 260725 — the HOST allowlist was removed (user directive). It previously
// enumerated the handful of destinations the app itself linked to (sei.gg,
// dmca.copyright.gov, polar.sh, and briefly discord/youtube), which made the
// notices inbox unable to link anywhere the client build had not been taught
// about in advance: adding a host meant cutting a release, and users on older
// builds got a silently dead link. Since the notices feed is operator-authored
// and served over TLS from sei.gg, the host restriction bought little and cost
// a release cycle per link. Any host is now allowed.
//
// The PROTOCOL gate stays, and it is the load-bearing half. `shell.openExternal`
// hands the URI to the OS, which resolves registered protocol handlers —
// `file:///…`, and on Windows schemes like `ms-msdt:` / `search-ms:`, are code
// execution or local-file surfaces, not links. Restricting to https (plus
// mailto for contact links) keeps that door shut while leaving every real
// destination reachable.
//
// Retained callers and what this still buys them:
//  - ipc.ts `app:open-external` — a compromised renderer (or an XSS hole in our
//    own strings) cannot smuggle a `javascript:` / `file:` URI to the OS.
//  - proxyClient.ts checkout / customer-portal URLs — a compromised proxy or
//    MITM can now redirect the user to an arbitrary *site* (previously bounded
//    to polar.sh), but still not to a local-protocol URI.

/**
 * Throws Error if `url` is not a URL we are willing to hand to the OS.
 * Use at every site that calls `shell.openExternal` to keep that surface
 * single-sourced.
 *
 * Reject reasons:
 *  - Malformed URL → "rejected (malformed URL)".
 *  - Any protocol other than https: or mailto: → "rejected".
 */
export function assertSafeExternalUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`assertSafeExternalUrl rejected (malformed URL): ${url}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'mailto:') {
    throw new Error(`assertSafeExternalUrl rejected: ${url}`);
  }
}
