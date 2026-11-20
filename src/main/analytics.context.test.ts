/**
 * 261031 (T278): analytics.ts end to end with posthog-node mocked (nothing
 * leaves the machine): dev/test-build suppression, the device id as the
 * anonymous distinct_id (persisted across launches in userData), property
 * enrichment on every event, the plan property and checkout_completed. The
 * alias / identify sequence is analytics.identity.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ctor: vi.fn(),
  capture: vi.fn(),
  alias: vi.fn(),
  identify: vi.fn(),
  app: { getVersion: () => '0.7.0', isPackaged: true as boolean },
  cfg: { value: {} as Record<string, unknown> },
}));

vi.mock('electron', () => ({ app: h.app }));
vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor(...args: unknown[]) {
      h.ctor(...args);
    }
    capture = h.capture;
    alias = h.alias;
    identify = h.identify;
    shutdown = vi.fn(async () => {});
  },
}));
vi.mock('./configStore', () => ({
  loadConfig: vi.fn(async () => h.cfg.value),
  updateConfig: vi.fn(async (fn: (c: Record<string, unknown>) => Record<string, unknown>) => {
    h.cfg.value = fn(h.cfg.value);
    return h.cfg.value;
  }),
}));
vi.mock('./apiKeyStore', () => ({
  getAiBackendKind: vi.fn(async () => 'local'),
  onAiBackendKindChanged: vi.fn(),
}));

import { analyticsDeviceId, deviceRolloutBucket } from './analyticsContext';

let userData: string;

type AnalyticsModule = typeof import('./analytics');

/** A fresh process: new module state, same userData dir. */
async function launch(): Promise<AnalyticsModule> {
  vi.resetModules();
  const { _setUserDataOverride } = await import('./paths');
  _setUserDataOverride(userData);
  const a = await import('./analytics');
  await a.initAnalytics();
  return a;
}

function lastCapture(): { distinctId: string; event: string; properties: Record<string, unknown> } {
  return h.capture.mock.calls.at(-1)![0];
}

beforeEach(() => {
  userData = mkdtempSync(path.join(os.tmpdir(), 'sei-analytics-'));
  h.ctor.mockClear();
  h.capture.mockClear();
  h.alias.mockClear();
  h.identify.mockClear();
  h.app.isPackaged = true;
  h.cfg.value = { analytics_opt_out: false, preferred_name: 'Sam' };
  vi.stubEnv('SEI_ANALYTICS_DEV', '');
  vi.stubEnv('SEI_RELEASE_CHANNEL', 'sei-channel=stable');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(userData, { recursive: true, force: true });
});

describe('dev and test builds send nothing', () => {
  it('an unpackaged build never creates a client', async () => {
    h.app.isPackaged = false;
    const a = await launch();
    a.capture('app_opened');
    expect(h.ctor).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
    expect(a.isAnalyticsActive()).toBe(false);
    expect(a.analyticsChannel()).toBe('dev');
  });

  it('a packaged build without a baked channel (local dist, spike workflow) is test and silent', async () => {
    vi.stubEnv('SEI_RELEASE_CHANNEL', '');
    const a = await launch();
    a.capture('app_opened');
    expect(a.analyticsChannel()).toBe('test');
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('pre-init events of a dev build are dropped, not replayed later', async () => {
    h.app.isPackaged = false;
    vi.resetModules();
    const { _setUserDataOverride } = await import('./paths');
    _setUserDataOverride(userData);
    const a = await import('./analytics');
    a.capture('onboarding_step', { step: 'intro' });
    await a.initAnalytics();
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('SEI_ANALYTICS_DEV=1 opts a dev build in, tagged channel dev', async () => {
    h.app.isPackaged = false;
    vi.stubEnv('SEI_ANALYTICS_DEV', '1');
    const a = await launch();
    a.capture('app_opened');
    expect(lastCapture().properties).toMatchObject({ channel: 'dev', packaged: false });
  });
});

describe('device id', () => {
  it('is the anonymous distinct_id and survives a relaunch (device-id.json)', async () => {
    let a = await launch();
    a.capture('app_opened');
    const first = lastCapture();
    const rawId = (JSON.parse(readFileSync(path.join(userData, 'device-id.json'), 'utf8')) as { deviceId: string }).deviceId;
    expect(first.distinctId).toBe(analyticsDeviceId(rawId));
    expect(first.properties.device_id).toBe(first.distinctId);
    expect(first.properties.rollout_bucket).toBe(deviceRolloutBucket(rawId));

    const { _resetDeviceIdCacheForTests } = await import('./auth/deviceId');
    _resetDeviceIdCacheForTests();
    a = await launch();
    a.capture('app_opened');
    expect(lastCapture().distinctId).toBe(first.distinctId);
    // A different process: a different session id.
    expect(lastCapture().properties.$session_id).not.toBe(first.properties.$session_id);
  });

  it('after sign-in the account is the distinct_id and device_id stays a property', async () => {
    const a = await launch();
    a.capture('app_opened');
    const deviceId = lastCapture().distinctId;
    a.identifyUser('user-123');
    expect(h.alias).toHaveBeenCalledWith({ distinctId: 'user-123', alias: deviceId });
    a.capture('chat_session_started');
    expect(lastCapture().distinctId).toBe('user-123');
    expect(lastCapture().properties.device_id).toBe(deviceId);
    a.resetUser();
    a.capture('signed_out');
    expect(lastCapture().distinctId).toBe(deviceId);
  });
});

describe('property enrichment', () => {
  it('stamps build, device, provider and plan facts on every event and in $set', async () => {
    h.cfg.value = { ...h.cfg.value, provider: 'ollama', provider_config: { ollama: { model: 'qwen3:8b' } } };
    const a = await launch();
    a.capture('voice_call_ended', { duration_ms: 5 });
    const p = lastCapture().properties;
    expect(p).toMatchObject({
      app_version: '0.7.0',
      channel: 'stable',
      packaged: true,
      ai_provider: 'ollama',
      llm_provider: 'ollama',
      model_family: 'qwen',
      plan: 'none',
      backend: 'local',
      duration_ms: 5,
    });
    expect(p.$session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.$set).toMatchObject({ channel: 'stable', ai_provider: 'ollama', app_version: '0.7.0' });
    // Signed out: the person's plan is never overwritten with 'none'.
    expect(p.$set).not.toHaveProperty('plan');
    expect(JSON.stringify(p)).not.toContain('qwen3:8b');
  });

  it('a config save moves ai_provider without a relaunch', async () => {
    const a = await launch();
    a.noteAnalyticsConfig({ provider: 'chatgpt', provider_config: {} });
    a.capture('app_opened');
    expect(lastCapture().properties.ai_provider).toBe('chatgpt');
  });
});

describe('plan and checkout_completed', () => {
  it('plan is unknown until the first snapshot, then the tier', async () => {
    const a = await launch();
    a.identifyUser('user-1');
    a.capture('x_event');
    expect(lastCapture().properties.plan).toBe('unknown');
    a.notePlanSnapshot('user-1', 'free', 0);
    a.capture('x_event');
    expect(lastCapture().properties.plan).toBe('free');
    expect((lastCapture().properties.$set as Record<string, unknown>).plan).toBe('free');
  });

  it('a tier rise after a checkout_opened is one checkout_completed, shape only', async () => {
    const a = await launch();
    a.identifyUser('user-1');
    a.notePlanSnapshot('user-1', 'free', 0, { now: 1_000 });
    a.capture('checkout_opened', { kind: 'quest' });
    a.notePlanSnapshot('user-1', 'quest', 0);
    const done = h.capture.mock.calls.map((c) => c[0]).filter((c) => c.event === 'checkout_completed');
    expect(done).toHaveLength(1);
    expect(done[0].properties).toMatchObject({
      kind: 'subscription',
      tier: 'quest',
      from_tier: 'free',
      checkout_opened_this_session: true,
      plan: 'quest',
    });
    a.notePlanSnapshot('user-1', 'quest', 0);
    expect(h.capture.mock.calls.filter((c) => c[0].event === 'checkout_completed')).toHaveLength(1);
  });

  it('a read older than one already applied is dropped (overlapping creditsGet calls)', async () => {
    const a = await launch();
    a.identifyUser('user-1');
    a.notePlanSnapshot('user-1', 'free', 0, { seq: 1 });
    a.notePlanSnapshot('user-1', 'free', 500, { seq: 3 });
    // seq 2 started before seq 3 but resolved after it: stale, ignored.
    a.notePlanSnapshot('user-1', 'free', 0, { seq: 2 });
    a.notePlanSnapshot('user-1', 'free', 500, { seq: 4 });
    const done = h.capture.mock.calls.map((c) => c[0]).filter((c) => c.event === 'checkout_completed');
    expect(done).toHaveLength(1);
    expect(done[0].properties).toMatchObject({ kind: 'topup', credits_added: 500, checkout_opened_this_session: false });
  });

  it('past_due back to active is not a checkout', async () => {
    const a = await launch();
    a.identifyUser('user-1');
    a.notePlanSnapshot('user-1', 'free', 0, { status: 'past_due', seq: 1 });
    a.notePlanSnapshot('user-1', 'quest', 0, { status: 'active', seq: 2 });
    expect(h.capture.mock.calls.filter((c) => c[0].event === 'checkout_completed')).toHaveLength(0);
    a.capture('x_event');
    expect(lastCapture().properties.plan).toBe('quest');
  });

  it("another account's snapshot neither sets the plan nor counts as a purchase", async () => {
    const a = await launch();
    a.identifyUser('user-1');
    a.notePlanSnapshot('user-1', 'free', 0);
    a.notePlanSnapshot('user-2', 'party', 0);
    a.capture('x_event');
    expect(lastCapture().properties.plan).toBe('free');
    expect(h.capture.mock.calls.filter((c) => c[0].event === 'checkout_completed')).toHaveLength(0);
  });
});

describe('opt-out', () => {
  it('sends nothing and aliases nothing', async () => {
    h.cfg.value = { ...h.cfg.value, analytics_opt_out: true };
    const a = await launch();
    a.capture('app_opened');
    a.identifyUser('user-9');
    a.notePlanSnapshot('user-9', 'free', 0);
    a.notePlanSnapshot('user-9', 'party', 0);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.alias).not.toHaveBeenCalled();
    expect(h.identify).not.toHaveBeenCalled();
  });
});
