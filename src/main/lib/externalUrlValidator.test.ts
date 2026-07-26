// src/main/lib/externalUrlValidator.test.ts
//
// Unit tests for the shared shell.openExternal gate.
//
// 260525-s09 H5 introduced this as a host allowlist; 260725 removed the host
// half (any site is linkable, so a notice can point anywhere without a client
// release) and kept the protocol gate. These tests pin the surviving contract:
// https/mailto pass regardless of host, everything the OS would resolve as a
// local protocol handler is rejected.

import { describe, it, expect } from 'vitest';
import { assertSafeExternalUrl } from './externalUrlValidator';

describe('assertSafeExternalUrl — shell.openExternal protocol gate', () => {
  // ─── Allow-path: any https host ───────────────────────────────────────
  it('allows the hosts the app itself links to', () => {
    expect(() => assertSafeExternalUrl('https://sei.gg/legal')).not.toThrow();
    expect(() => assertSafeExternalUrl('https://www.sei.gg/')).not.toThrow();
    expect(() => assertSafeExternalUrl('https://dmca.copyright.gov/')).not.toThrow();
    expect(() => assertSafeExternalUrl('https://buy.polar.sh/polar_c_abc123')).not.toThrow();
  });

  it('allows arbitrary third-party https hosts (260725: host allowlist removed)', () => {
    expect(() => assertSafeExternalUrl('https://discord.gg/abc123')).not.toThrow();
    expect(() => assertSafeExternalUrl('https://youtu.be/abc')).not.toThrow();
    expect(() => assertSafeExternalUrl('https://example.com/anything?q=1#x')).not.toThrow();
    // Look-alike hosts are no longer special: there is nothing left to imitate.
    expect(() => assertSafeExternalUrl('https://www.sei.gg.attacker.tld/')).not.toThrow();
  });

  // ─── Allow-path: mailto ───────────────────────────────────────────────
  it('allows any mailto address', () => {
    expect(() => assertSafeExternalUrl('mailto:dmca@sei.gg')).not.toThrow();
    expect(() => assertSafeExternalUrl('mailto:someone@example.com')).not.toThrow();
  });

  // ─── Reject-path: protocol gate (the load-bearing half) ───────────────
  it('rejects http (not https)', () => {
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

  it('rejects OS-resolved local protocol handlers', () => {
    // The reason the protocol gate outlived the host allowlist: these are
    // execution surfaces on Windows, not links.
    expect(() => assertSafeExternalUrl('ms-msdt:/id PCWDiagnostic')).toThrow(/rejected/);
    expect(() => assertSafeExternalUrl('search-ms:query=x')).toThrow(/rejected/);
  });

  // ─── Reject-path: malformed URL ───────────────────────────────────────
  it('rejects a malformed URL string', () => {
    expect(() => assertSafeExternalUrl('not a url')).toThrow(/malformed|rejected/);
  });
});
