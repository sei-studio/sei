/**
 * 261001 — the onboarding attribution answer becomes a person property.
 *
 * Renderer props cannot carry `$set` (sanitize drops objects), so capture()
 * maps a VALID `onboarding_attribution.source` to `$set_once` itself. A skip,
 * an unknown value, or the same key on another event sets nothing.
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

import { capture, initAnalytics, personPropsFor } from './analytics';
import { ATTRIBUTION_EVENT, ATTRIBUTION_SOURCES } from '../shared/attribution';

describe('personPropsFor (pure)', () => {
  it('maps every valid attribution source to $set_once', () => {
    for (const source of ATTRIBUTION_SOURCES) {
      expect(personPropsFor(ATTRIBUTION_EVENT, { source })).toEqual({
        $set_once: { attribution_source: source },
      });
    }
  });
  it('sets nothing for a skip, an unknown value, or another event', () => {
    expect(personPropsFor(ATTRIBUTION_EVENT, { source: 'skipped' })).toEqual({});
    expect(personPropsFor(ATTRIBUTION_EVENT, { source: 'my cousin told me' })).toEqual({});
    expect(personPropsFor(ATTRIBUTION_EVENT, {})).toEqual({});
    expect(personPropsFor('character_created', { source: 'reddit' })).toEqual({});
  });
});

describe('capture() with the attribution event', () => {
  it('sends the event with source and the person property', async () => {
    await initAnalytics();
    captureSpy.mockClear();
    capture(ATTRIBUTION_EVENT, { source: 'youtube_creator' });
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const arg = captureSpy.mock.calls[0][0];
    expect(arg.event).toBe('onboarding_attribution');
    expect(arg.distinctId).toBe('install-0000');
    expect(arg.properties.source).toBe('youtube_creator');
    expect(arg.properties.$set_once).toEqual({ attribution_source: 'youtube_creator' });
    // The common $set rides alongside, untouched.
    expect(arg.properties.$set.client).toBe('desktop-app');
  });
  it('a skip is still an event, with no person property', () => {
    captureSpy.mockClear();
    capture(ATTRIBUTION_EVENT, { source: 'skipped' });
    const arg = captureSpy.mock.calls[0][0];
    expect(arg.properties.source).toBe('skipped');
    expect(arg.properties).not.toHaveProperty('$set_once');
  });
  it('renderer-supplied $set_once is still dropped by sanitize', () => {
    captureSpy.mockClear();
    capture('some_event', { $set_once: { attribution_source: 'reddit' } } as Record<string, unknown>);
    expect(captureSpy.mock.calls[0][0].properties).not.toHaveProperty('$set_once');
  });
});
