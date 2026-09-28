/**
 * 260929 — the quit-time analytics flush is bounded. before-quit awaits
 * shutdownAnalytics() BEFORE the supervisor drains the bots, and posthog-node
 * defaults to a 30s shutdown timeout, so an unreachable PostHog used to hold
 * quit (and leave the companion in the world) for 30s.
 */
import { describe, it, expect, vi } from 'vitest';

const { shutdownSpy } = vi.hoisted(() => ({
  // posthog-node rejects its shutdown timeout with a bare string.
  shutdownSpy: vi.fn(async (_ms?: number) => {
    throw 'Timeout while shutting down PostHog. Some events may not have been sent.';
  }),
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
}));
vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = vi.fn();
    alias = vi.fn();
    identify = vi.fn();
    shutdown = shutdownSpy;
  },
}));
vi.mock('./configStore', () => ({
  loadConfig: vi.fn(async () => ({ analytics_install_id: 'install-0000', analytics_opt_out: false })),
  updateConfig: vi.fn(async (fn: (c: Record<string, unknown>) => Record<string, unknown>) => fn({})),
}));
vi.mock('./apiKeyStore', () => ({
  getAiBackendKind: vi.fn(async () => 'local'),
  onAiBackendKindChanged: vi.fn(),
}));

import { initAnalytics, isAnalyticsActive, shutdownAnalytics, ANALYTICS_SHUTDOWN_TIMEOUT_MS } from './analytics';

describe('shutdownAnalytics', () => {
  it('passes a short bound to the PostHog flush and survives its timeout rejection', async () => {
    await initAnalytics();
    expect(isAnalyticsActive()).toBe(true);
    await expect(shutdownAnalytics()).resolves.toBeUndefined();
    expect(shutdownSpy).toHaveBeenCalledWith(ANALYTICS_SHUTDOWN_TIMEOUT_MS);
    expect(ANALYTICS_SHUTDOWN_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    expect(isAnalyticsActive()).toBe(false);
  });
});
