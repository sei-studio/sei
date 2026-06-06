// src/main/lib/externalUrlValidator.test.ts
//
// 260525-s09 H5: unit tests for the shared shell.openExternal allowlist
// validator. Covers https-allow / https-reject (substring-host bypass attempt),
// mailto allow/reject, protocol gate (javascript: / data: / file: rejected),
// malformed URL.

import { describe, it, expect } from 'vitest';
import {
  assertSafeExternalUrl,
  ALLOWED_HTTPS_HOSTS,
  ALLOWED_HTTPS_SUFFIXES,
  ALLOWED_MAILTO,
} from './externalUrlValidator';

describe('assertSafeExternalUrl — H5 shared allowlist validator (260525-s09)', () => {
  // ─── Allow-path: https hosts on the allowlist ─────────────────────────
  it('allows https://sei.gg/legal', () => {
    expect(() => assertSafeExternalUrl('https://sei.gg/legal')).not.toThrow();
  });

  it('allows https://www.sei.gg/', () => {
    expect(() => assertSafeExternalUrl('https://www.sei.gg/')).not.toThrow();
  });

  it('allows https://dmca.copyright.gov/', () => {
    expect(() => assertSafeExternalUrl('https://dmca.copyright.gov/')).not.toThrow();
  });

  it('allows https://polar.sh/my-org/portal (Polar customer portal)', () => {
    expect(() => assertSafeExternalUrl('https://polar.sh/my-org/portal')).not.toThrow();
  });

  it('allows https://buy.polar.sh/polar_c_abc123 (Polar hosted checkout subdomain)', () => {
    // Polar serves checkout/portal across subdomains; the dot-anchored
    // '.polar.sh' suffix rule trusts the whole registrable domain.
    expect(() => assertSafeExternalUrl('https://buy.polar.sh/polar_c_abc123')).not.toThrow();
  });

  it('allows https://sandbox.polar.sh/my-org/portal (Polar sandbox)', () => {
    expect(() => assertSafeExternalUrl('https://sandbox.polar.sh/my-org/portal')).not.toThrow();
  });

  // ─── Allow-path: mailto on the allowlist ──────────────────────────────
  it('allows mailto:dmca@sei.gg', () => {
    expect(() => assertSafeExternalUrl('mailto:dmca@sei.gg')).not.toThrow();
  });

  // ─── Reject-path: substring-host bypass attempts ──────────────────────
  it('rejects host that CONTAINS the polar.sh label but is a different domain', () => {
    expect(() =>
      assertSafeExternalUrl('https://evil.polar.sh.attacker.tld/'),
    ).toThrow(/rejected/);
  });

  it('rejects a non-dot-anchored polar.sh look-alike (evilpolar.sh)', () => {
    expect(() => assertSafeExternalUrl('https://evilpolar.sh/')).toThrow(/rejected/);
  });

  it('rejects host that CONTAINS an allowlisted host as a substring (sei.gg)', () => {
    expect(() => assertSafeExternalUrl('https://www.sei.gg.attacker.tld/')).toThrow(
      /rejected/,
    );
  });

  // ─── Reject-path: protocol gate ───────────────────────────────────────
  it('rejects http (not https) even for an allowlisted host', () => {
    expect(() => assertSafeExternalUrl('http://sei.gg/')).toThrow(/rejected/);
  });

  it('rejects javascript: URLs', () => {
    expect(() => assertSafeExternalUrl('javascript:alert(1)')).toThrow(/rejected/);
  });

  it('rejects file:// URLs', () => {
    expect(() => assertSafeExternalUrl('file:///etc/passwd')).toThrow(/rejected/);
  });

  it('rejects data: URLs', () => {
    expect(() => assertSafeExternalUrl('data:text/html,<script>')).toThrow(/rejected/);
  });

  // ─── Reject-path: mailto not on allowlist ─────────────────────────────
  it('rejects a mailto whose address is not on the allowlist', () => {
    expect(() => assertSafeExternalUrl('mailto:attacker@evil.tld')).toThrow(/rejected/);
  });

  // ─── Reject-path: malformed URL ───────────────────────────────────────
  it('rejects a malformed URL string', () => {
    expect(() => assertSafeExternalUrl('not a url')).toThrow(/malformed|rejected/);
  });

  // ─── Sanity: exported lists are non-empty and match the documented set ─
  it('exports the documented https-host allowlist verbatim', () => {
    expect(ALLOWED_HTTPS_HOSTS).toEqual([
      'sei.gg',
      'www.sei.gg',
      'dmca.copyright.gov',
      'polar.sh',
    ]);
  });

  it('exports the documented https-suffix allowlist verbatim', () => {
    expect(ALLOWED_HTTPS_SUFFIXES).toEqual(['.polar.sh']);
  });

  it('exports the documented mailto allowlist verbatim', () => {
    expect(ALLOWED_MAILTO).toEqual(['dmca@sei.gg']);
  });
});
