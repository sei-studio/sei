/**
 * W7 region gate (260816) — pure vocabulary tests: the trace parser, the
 * blocklist classifier matrix, and the blocklist's own shape.
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_REGIONS,
  REGION_BLOCKED,
  REGION_BLOCKED_COPY,
  isRegionBlocked,
  parseTraceLoc,
} from './regionGate';

// A realistic Cloudflare /cdn-cgi/trace body (shape verified live against
// api.sei.gg in the 260816 research pass).
const TRACE_BODY = [
  'fl=123abc',
  'h=api.sei.gg',
  'ip=203.0.113.7',
  'ts=1765900000.123',
  'visit_scheme=https',
  'uag=Mozilla/5.0',
  'colo=SJC',
  'sliver=none',
  'http=http/2',
  'loc=CN',
  'tls=TLSv1.3',
  'sni=plaintext',
  'warp=off',
  'gateway=off',
  'rbi=off',
  'kex=X25519',
].join('\n');

describe('parseTraceLoc', () => {
  it('extracts the loc country code from a real trace body', () => {
    expect(parseTraceLoc(TRACE_BODY)).toBe('CN');
  });

  it('handles CRLF line endings', () => {
    expect(parseTraceLoc('h=api.sei.gg\r\nloc=US\r\ntls=TLSv1.3')).toBe('US');
  });

  it('uppercases a lowercase code', () => {
    expect(parseTraceLoc('loc=jp')).toBe('JP');
  });

  it('returns null for garbage', () => {
    expect(parseTraceLoc('<!doctype html><html>captive portal</html>')).toBeNull();
    expect(parseTraceLoc('')).toBeNull();
    expect(parseTraceLoc('{"ok":true}')).toBeNull();
  });

  it('returns null when the loc line is absent', () => {
    expect(parseTraceLoc('h=api.sei.gg\nip=203.0.113.7')).toBeNull();
  });

  it("returns null for Cloudflare's non-country codes (XX unknown, T1 Tor)", () => {
    expect(parseTraceLoc('loc=XX')).toBeNull();
    expect(parseTraceLoc('loc=T1')).toBeNull();
  });

  it('returns null for a malformed loc value', () => {
    expect(parseTraceLoc('loc=')).toBeNull();
    expect(parseTraceLoc('loc=USA')).toBeNull();
  });
});

describe('isRegionBlocked', () => {
  it('blocks CN, HK, MO', () => {
    expect(isRegionBlocked('CN')).toBe(true);
    expect(isRegionBlocked('HK')).toBe(true);
    expect(isRegionBlocked('MO')).toBe(true);
  });

  it('blocks the Anthropic-unsupported / sanctioned set', () => {
    for (const code of ['RU', 'BY', 'IR', 'KP', 'CU', 'SY', 'AF', 'MM', 'YE', 'VE', 'CD']) {
      expect(isRegionBlocked(code), code).toBe(true);
    }
  });

  it('allows supported regions', () => {
    for (const code of ['US', 'JP', 'DE', 'GB', 'FR', 'TW', 'KR', 'SG', 'UA']) {
      expect(isRegionBlocked(code), code).toBe(false);
    }
  });

  it('allows unknown: null, undefined, empty, and non-codes (fail open)', () => {
    expect(isRegionBlocked(null)).toBe(false);
    expect(isRegionBlocked(undefined)).toBe(false);
    expect(isRegionBlocked('')).toBe(false);
    expect(isRegionBlocked('unknown')).toBe(false);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isRegionBlocked('cn')).toBe(true);
    expect(isRegionBlocked(' hk ')).toBe(true);
    expect(isRegionBlocked('us')).toBe(false);
  });
});

describe('BLOCKED_REGIONS shape', () => {
  it('contains only uppercase two-letter codes', () => {
    for (const code of BLOCKED_REGIONS) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('never lists the unknown markers', () => {
    expect(BLOCKED_REGIONS.has('XX')).toBe(false);
    expect(BLOCKED_REGIONS.has('T1')).toBe(false);
  });
});

describe('constants', () => {
  it('pins the stable error token and the exact user-facing copy', () => {
    expect(REGION_BLOCKED).toBe('region_blocked');
    expect(REGION_BLOCKED_COPY).toBe(
      'Our servers do not currently support your region. Please continue with local mode.',
    );
    // No em dash in user-facing copy (CLAUDE.md rule).
    expect(REGION_BLOCKED_COPY.includes('—')).toBe(false);
  });
});
