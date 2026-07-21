/**
 * 260720 — captureDiagnostic / sanitizeDiagnostic: the long-text allowlist
 * that lets pre-redacted stderr/stdout tails + error_message past sanitize()'s
 * 200-char truncation (8KB per-field cap), with the same gating as capture().
 *
 * The analytics module is a singleton, so the tests run in file order:
 * pre-init gating first, then initAnalytics with a mocked PostHog client.
 */
import { describe, it, expect, vi } from 'vitest';

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
  sanitizeDiagnostic,
  captureDiagnostic,
  initAnalytics,
  setAnalyticsOptOut,
  isSignedInAnalytics,
  identifyUser,
  resetUser,
} from './analytics';

describe('sanitizeDiagnostic (pure)', () => {
  it('lets allowlisted long-text keys through up to 8KB, tails keep the END', () => {
    const out = sanitizeDiagnostic({
      stderr_tail: 'A'.repeat(10_000) + 'CRASH',
      stdout_tail: 'short out',
      error_message: 'E'.repeat(9_000),
      other_string: 'B'.repeat(500),
    });
    expect((out.stderr_tail as string).length).toBe(8192);
    expect(out.stderr_tail as string).toMatch(/CRASH$/);
    expect(out.stdout_tail).toBe('short out');
    expect((out.error_message as string).length).toBe(8192);
    expect(out.error_message as string).toMatch(/^E/); // head kept for messages
    // Non-allowlisted strings still get the standard 200-char truncation.
    expect((out.other_string as string).length).toBe(200);
  });

  it('keeps the standard sanitize() rules for everything else', () => {
    const out = sanitizeDiagnostic({
      duration_ms: 42,
      signed_in: true,
      exit_code: null,
      nested: { drop: 'me' },
      camelCase: 'dropped',
      stderr_tail: 123 as unknown as string, // non-string allowlisted value: number passes as scalar
    });
    expect(out.duration_ms).toBe(42);
    expect(out.signed_in).toBe(true);
    expect(out.exit_code).toBeNull();
    expect(out).not.toHaveProperty('nested');
    expect(out).not.toHaveProperty('camelCase');
    expect(out.stderr_tail).toBe(123); // sanitize keeps scalars as-is
  });

  it('handles undefined props', () => {
    expect(sanitizeDiagnostic(undefined)).toEqual({});
  });
});

describe('captureDiagnostic gating + capture', () => {
  it('is a no-op before init (no client)', () => {
    captureDiagnostic('summon_failed', { error_class: 'BOT_CRASH' });
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('captures with common props and full-length tails after init', async () => {
    await initAnalytics();
    const tail = 'T'.repeat(4000) + ' the-crash';
    captureDiagnostic('summon_failed', {
      character_id: 'char-1',
      error_class: 'BOT_CRASH',
      stderr_tail: tail,
    });
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const arg = captureSpy.mock.calls[0][0] as {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
    };
    expect(arg.event).toBe('summon_failed');
    expect(arg.distinctId).toBe('install-0000');
    expect(arg.properties.client).toBe('desktop-app');
    expect(arg.properties.error_class).toBe('BOT_CRASH');
    expect(arg.properties.stderr_tail).toBe(tail); // NOT truncated to 200
  });

  it('respects opt-out exactly like capture()', async () => {
    captureSpy.mockClear();
    await setAnalyticsOptOut(true);
    captureDiagnostic('summon_failed', { error_class: 'BOT_CRASH' });
    expect(captureSpy).not.toHaveBeenCalled();
    await setAnalyticsOptOut(false);
    captureDiagnostic('summon_failed', { error_class: 'BOT_CRASH' });
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });
});

describe('isSignedInAnalytics', () => {
  it('tracks identify/reset', () => {
    expect(isSignedInAnalytics()).toBe(false);
    identifyUser('user-123');
    expect(isSignedInAnalytics()).toBe(true);
    resetUser();
    expect(isSignedInAnalytics()).toBe(false);
  });
});
