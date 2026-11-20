/**
 * 261001 — the onboarding attribution answer becomes a person property.
 *
 * Renderer props cannot carry `$set` (sanitize drops objects), so capture()
 * maps a VALID `onboarding_attribution.source` to `$set_once` itself. A skip,
 * an unknown value, or the same key on another event sets nothing.
 */
import { describe, it, expect, vi } from 'vitest';
// 261031: tests run unpackaged (channel 'dev'), which sends nothing unless
// SEI_ANALYTICS_DEV is set (analyticsContext.ts send gate).
vi.hoisted(() => {
  process.env.SEI_ANALYTICS_DEV = '1';
});

const { captureSpy } = vi.hoisted(() => ({ captureSpy: vi.fn() }));

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
}));
// 261031: the device id; a profile that already has an install id (as here)
// keeps that install id as its anonymous distinct_id.
vi.mock('./auth/deviceId', () => ({ getDeviceId: async () => 'device-raw-0000' }));
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
import {
  ATTRIBUTION_DETAIL_EVENT,
  ATTRIBUTION_DETAILS,
  ATTRIBUTION_EVENT,
  ATTRIBUTION_SOURCES,
} from '../shared/attribution';

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

describe('personPropsFor: follow-up detail (261012)', () => {
  it('maps every valid detail to $set_once attribution_detail', () => {
    for (const [source, details] of Object.entries(ATTRIBUTION_DETAILS)) {
      for (const d of details) {
        expect(personPropsFor(ATTRIBUTION_DETAIL_EVENT, { source, heard_from_detail: d })).toEqual({
          $set_once: { attribution_detail: d },
        });
      }
    }
  });
  it('sets nothing for a skip, a mismatched pair, or free text', () => {
    expect(personPropsFor(ATTRIBUTION_DETAIL_EVENT, { source: 'ai_assistant', heard_from_detail: 'skipped' })).toEqual({});
    expect(personPropsFor(ATTRIBUTION_DETAIL_EVENT, { source: 'google_search', heard_from_detail: 'claude' })).toEqual({});
    expect(personPropsFor(ATTRIBUTION_DETAIL_EVENT, { source: 'ai_assistant', heard_from_detail: 'my uncle' })).toEqual({});
    expect(personPropsFor(ATTRIBUTION_DETAIL_EVENT, { heard_from_detail: 'claude' })).toEqual({});
    // The main event's mapping is untouched by the detail prop.
    expect(personPropsFor(ATTRIBUTION_EVENT, { source: 'ai_assistant', heard_from_detail: 'claude' })).toEqual({
      $set_once: { attribution_source: 'ai_assistant' },
    });
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
  it('the follow-up event carries heard_from_detail and its person property', () => {
    captureSpy.mockClear();
    capture(ATTRIBUTION_DETAIL_EVENT, { source: 'ai_assistant', heard_from_detail: 'chatgpt' });
    const arg = captureSpy.mock.calls[0][0];
    expect(arg.event).toBe('onboarding_attribution_detail');
    expect(arg.properties.source).toBe('ai_assistant');
    expect(arg.properties.heard_from_detail).toBe('chatgpt');
    expect(arg.properties.$set_once).toEqual({ attribution_detail: 'chatgpt' });
  });
  it('renderer-supplied $set_once is still dropped by sanitize', () => {
    captureSpy.mockClear();
    capture('some_event', { $set_once: { attribution_source: 'reddit' } } as Record<string, unknown>);
    expect(captureSpy.mock.calls[0][0].properties).not.toHaveProperty('$set_once');
  });
});
