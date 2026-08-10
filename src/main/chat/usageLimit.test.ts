/**
 * Tests for usageLimit.ts (260810) — the rate-limit classification and the
 * retry-window extraction whose 1-hour fallback used to lie.
 *
 *   U.1 — classifyUsageLimit: 402 depleted, 429 rate_limited, else null.
 *   U.2 — retryAfterSeconds prefers the JSON body's retry_after_seconds (the
 *         proxy's honest window) over the Retry-After header (deliberately
 *         capped at 10s server-side).
 *   U.3 — header is the fallback when the body has none; both header shapes
 *         (Headers-like and plain object) are read.
 *   U.4 — no usable value anywhere → undefined (the call site then uses the
 *         60s guess and the modal says "in a moment" instead of a clock time).
 *   U.5 — the call site's fallback is 60, not the old 3600 (source pin).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// usageLimit's only top-level import is apiKeyStore (for the cloud-mode gate
// in raiseUsageLimitPopup, not exercised here), and apiKeyStore drags in
// electron. Stub the direct dependency so the module loads in the node env.
vi.mock('../apiKeyStore', () => ({
  getAiBackendKind: vi.fn(async () => 'local'),
}));

import { classifyUsageLimit, retryAfterSeconds } from './usageLimit';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('classifyUsageLimit', () => {
  it('U.1: 402 depleted, 429 rate_limited, anything else null', () => {
    expect(classifyUsageLimit({ status: 402 })).toBe('depleted');
    expect(classifyUsageLimit({ status: 429 })).toBe('rate_limited');
    expect(classifyUsageLimit({ status: 500 })).toBeNull();
    expect(classifyUsageLimit(null)).toBeNull();
    expect(classifyUsageLimit(new Error('boom'))).toBeNull();
  });
});

describe('retryAfterSeconds', () => {
  it('U.2: JSON body retry_after_seconds outranks the Retry-After header', () => {
    const err = {
      status: 429,
      error: { kind: 'rate', retry_after_seconds: 300 },
      headers: { 'retry-after': '10' },
    };
    expect(retryAfterSeconds(err)).toBe(300);
  });

  it('U.3: header fallback works for both header shapes', () => {
    expect(retryAfterSeconds({ headers: { 'retry-after': '45' } })).toBe(45);
    const headersLike = { get: (k: string) => (k === 'retry-after' ? '20' : null) };
    expect(retryAfterSeconds({ headers: headersLike })).toBe(20);
    // A body without the field does not shadow the header.
    expect(
      retryAfterSeconds({ error: { kind: 'rate' }, headers: { 'retry-after': '45' } }),
    ).toBe(45);
  });

  it('U.4: nothing usable anywhere is undefined', () => {
    expect(retryAfterSeconds({})).toBeUndefined();
    expect(retryAfterSeconds({ error: { retry_after_seconds: 'soon' } })).toBeUndefined();
    expect(retryAfterSeconds({ error: { retry_after_seconds: 0 } })).toBeUndefined();
    expect(retryAfterSeconds({ headers: { 'retry-after': 'never' } })).toBeUndefined();
    expect(retryAfterSeconds(null)).toBeUndefined();
  });

  it('U.5: the call-site fallback is 60 seconds, not 3600', () => {
    const src = readFileSync(resolve(__dirname, 'usageLimit.ts'), 'utf-8');
    expect(src.includes('retryAfterSeconds(err) ?? 60')).toBe(true);
    expect(src.includes('?? 3600')).toBe(false);
  });
});
