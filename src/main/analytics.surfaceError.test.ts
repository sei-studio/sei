/**
 * 260828 — surface_error events + the summon_failed dedupe throttle.
 *
 * The analytics module is a singleton, so like analytics.diagnostics.test.ts
 * these run in file order: init with a mocked PostHog client first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { captureSpy } = vi.hoisted(() => ({ captureSpy: vi.fn() }));

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
}));
vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = captureSpy;
    alias = vi.fn();
    identify = vi.fn();
    shutdown = vi.fn(async () => {});
  },
}));
vi.mock('./configStore', () => ({
  loadConfig: vi.fn(async () => ({})),
  updateConfig: vi.fn(async (fn: (c: Record<string, unknown>) => Record<string, unknown>) =>
    fn({ analytics_install_id: 'install-0000', analytics_opt_out: false }),
  ),
}));
vi.mock('./apiKeyStore', () => ({
  getAiBackendKind: vi.fn(async () => 'local'),
  onAiBackendKindChanged: vi.fn(),
}));

import {
  initAnalytics,
  captureSurfaceError,
  surfaceErrorClass,
  captureDiagnosticThrottled,
  resetDiagThrottleForTest,
  DIAG_THROTTLE_WINDOW_MS,
} from './analytics';

function lastCall(): { event: string; properties: Record<string, unknown> } {
  const arg = captureSpy.mock.calls[captureSpy.mock.calls.length - 1][0] as {
    event: string;
    properties: Record<string, unknown>;
  };
  return arg;
}

describe('surfaceErrorClass (pure)', () => {
  it('maps error shapes to stable tokens', () => {
    expect(surfaceErrorClass(new Error('Request timed out'))).toBe('timeout');
    expect(surfaceErrorClass(new Error('429 rate_limit_error'))).toBe('rate_limited');
    expect(surfaceErrorClass(new Error('401 authentication_error: invalid x-api-key'))).toBe('auth');
    expect(surfaceErrorClass(new Error('402 payment required'))).toBe('payment_required');
    expect(surfaceErrorClass(new Error('fetch failed'))).toBe('network');
    expect(surfaceErrorClass(new Error('getaddrinfo ENOTFOUND api.sei.gg'))).toBe('network');
    expect(surfaceErrorClass(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe('aborted');
    expect(surfaceErrorClass(new Error('something else entirely'))).toBe('unknown');
    expect(surfaceErrorClass('plain string weirdness')).toBe('unknown');
  });
});

describe('captureSurfaceError', () => {
  beforeEach(async () => {
    await initAnalytics();
    captureSpy.mockClear();
  });

  it('ships surface + error_class + character_id with common props', () => {
    captureSurfaceError('chess', 'move_turn_timeout', 'char-1');
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const { event, properties } = lastCall();
    expect(event).toBe('surface_error');
    expect(properties.surface).toBe('chess');
    expect(properties.error_class).toBe('move_turn_timeout');
    expect(properties.character_id).toBe('char-1');
    expect(properties.client).toBe('desktop-app');
  });

  it('omits character_id when not supplied', () => {
    captureSurfaceError('voice', 'tts_stream_stall');
    expect(lastCall().properties).not.toHaveProperty('character_id');
  });

  it('refuses a non-token error_class (raw message shapes) as invalid_class', () => {
    captureSurfaceError('chat', 'Error: ECONNRESET at Socket <raw message>', 'char-1');
    expect(lastCall().properties.error_class).toBe('invalid_class');
  });
});

describe('captureDiagnosticThrottled', () => {
  beforeEach(async () => {
    await initAnalytics();
    captureSpy.mockClear();
    resetDiagThrottleForTest();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ships the first event with repeat_count 1', () => {
    captureDiagnosticThrottled('summon_failed', 'c1:PREFERRED_NAME_MISSING:pre_gate', {
      error_class: 'PREFERRED_NAME_MISSING',
    });
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(lastCall().properties.repeat_count).toBe(1);
  });

  it('suppresses identical repeats inside the window, then ships with the count', () => {
    const key = 'c1:PREFERRED_NAME_MISSING:pre_gate';
    captureDiagnosticThrottled('summon_failed', key, { error_class: 'PREFERRED_NAME_MISSING' });
    // The 260828 incident shape: one retry every ~14s.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(14_000);
      captureDiagnosticThrottled('summon_failed', key, { error_class: 'PREFERRED_NAME_MISSING' });
    }
    // 20 * 14s = 280s < 5min window → everything after the first is suppressed.
    expect(captureSpy).toHaveBeenCalledTimes(1);
    // Past the window the next event ships, carrying the suppressed count.
    vi.advanceTimersByTime(DIAG_THROTTLE_WINDOW_MS);
    captureDiagnosticThrottled('summon_failed', key, { error_class: 'PREFERRED_NAME_MISSING' });
    expect(captureSpy).toHaveBeenCalledTimes(2);
    expect(lastCall().properties.repeat_count).toBe(21); // 20 suppressed + this one
  });

  it('does not delay a different key', () => {
    captureDiagnosticThrottled('summon_failed', 'c1:PREFERRED_NAME_MISSING:pre_gate', {});
    captureDiagnosticThrottled('summon_failed', 'c1:LOCAL_NO_API_KEY:pre_gate', {});
    captureDiagnosticThrottled('summon_failed', 'c2:PREFERRED_NAME_MISSING:pre_gate', {});
    expect(captureSpy).toHaveBeenCalledTimes(3);
  });
});
