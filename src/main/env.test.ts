/**
 * env.ts fallback wiring (260704 anon-key migration).
 *
 * In vitest import.meta.env has no SUPABASE_URL / SUPABASE_ANON_KEY, so these
 * tests exercise exactly the no-.env GitHub-build path: Supabase access must
 * resolve to `<proxy>/supabase` + the placeholder key. The direct-override
 * branch (URL_RAW set) is a build-time `define` substitution and is covered
 * by the packaged-build smoke, not unit-testable here.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { getSupabaseUrl, getSupabaseAnonKey, PROXY_ROUTED_ANON_KEY } from './env';

const ORIGINAL_PROXY_URL = process.env.SEI_PROXY_URL;

afterEach(() => {
  if (ORIGINAL_PROXY_URL === undefined) delete process.env.SEI_PROXY_URL;
  else process.env.SEI_PROXY_URL = ORIGINAL_PROXY_URL;
});

describe('env fallbacks (no build-time Supabase vars)', () => {
  it('routes Supabase through the default proxy host', () => {
    delete process.env.SEI_PROXY_URL;
    expect(getSupabaseUrl()).toBe('https://api.sei.gg/supabase');
  });

  it('respects a SEI_PROXY_URL override', () => {
    process.env.SEI_PROXY_URL = 'http://localhost:8080';
    expect(getSupabaseUrl()).toBe('http://localhost:8080/supabase');
  });

  it('falls back to the proxy-routed placeholder anon key', () => {
    expect(getSupabaseAnonKey()).toBe(PROXY_ROUTED_ANON_KEY);
    expect(PROXY_ROUTED_ANON_KEY.length).toBeGreaterThan(0);
  });
});
