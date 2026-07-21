/**
 * 260720 — privacy re-consent: reenableAnalyticsOnConsent() (called from the
 * tos:accept IPC handler after recordAcceptance succeeds) must clear
 * analytics_opt_out in the SAME config store capture() reads, and re-enable
 * capture() immediately (no restart).
 *
 * The analytics module is a singleton, so this file uses its own mock set and
 * runs init → opt-out → consent in order.
 */
import { describe, it, expect, vi } from 'vitest';

const { captureSpy, configState } = vi.hoisted(() => ({
  captureSpy: vi.fn(),
  // Simulated profile-scoped config.json. Starts OPTED OUT — the interesting
  // case: a user who previously flipped the toggle off, then accepts the new
  // privacy version.
  configState: {
    cfg: { analytics_install_id: 'install-0000', analytics_opt_out: true } as Record<
      string,
      unknown
    >,
  },
}));

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
  loadConfig: vi.fn(async () => ({ ...configState.cfg })),
  updateConfig: vi.fn(async (fn: (c: Record<string, unknown>) => Record<string, unknown>) => {
    configState.cfg = fn({ ...configState.cfg });
    return { ...configState.cfg };
  }),
}));
vi.mock('./apiKeyStore', () => ({
  getAiBackendKind: vi.fn(async () => 'local'),
}));

import {
  initAnalytics,
  capture,
  getAnalyticsOptOut,
  reenableAnalyticsOnConsent,
} from './analytics';
import { updateConfig } from './configStore';

describe('reenableAnalyticsOnConsent (privacy acceptance re-baseline)', () => {
  it('init respects the persisted opt-out: capture() is a no-op', async () => {
    await initAnalytics();
    capture('some_event');
    expect(captureSpy).not.toHaveBeenCalled();
    expect(await getAnalyticsOptOut()).toBe(true);
  });

  it('acceptance clears analytics_opt_out in the config store and re-enables capture immediately', async () => {
    await reenableAnalyticsOnConsent();
    // Persisted through the same updateConfig the reader uses (profile-scoped
    // config.json), not some parallel store.
    expect(vi.mocked(updateConfig)).toHaveBeenCalled();
    expect(configState.cfg.analytics_opt_out).toBe(false);
    expect(await getAnalyticsOptOut()).toBe(false);
    // Live effect: no restart needed.
    capture('some_event');
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second acceptance write keeps opt_out false', async () => {
    await reenableAnalyticsOnConsent();
    expect(configState.cfg.analytics_opt_out).toBe(false);
    expect(await getAnalyticsOptOut()).toBe(false);
  });
});
