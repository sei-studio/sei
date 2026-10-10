/**
 * 261005 — events captured before initAnalytics() resolves are held and
 * replayed (with their original timestamps) once init knows the user has not
 * opted out; under opt-out they are dropped. Also the `backend: 'unset'`
 * property before onboarding and `app_quit.last_surface`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { captureSpy, cfg } = vi.hoisted(() => ({
  captureSpy: vi.fn(),
  cfg: { value: { analytics_install_id: 'install-0000', analytics_opt_out: false } as Record<string, unknown> },
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
  loadConfig: vi.fn(async () => cfg.value),
  updateConfig: vi.fn(async (fn: (c: Record<string, unknown>) => Record<string, unknown>) => fn(cfg.value)),
}));
vi.mock('./apiKeyStore', () => ({
  getAiBackendKind: vi.fn(async () => 'local'),
  onAiBackendKindChanged: vi.fn(),
}));

import {
  _resetPreInitForTests,
  backendProp,
  capture,
  captureAppQuit,
  initAnalytics,
  noteSurface,
  setProfileOnboarded,
  shutdownAnalytics,
  surfaceForEvent,
} from './analytics';

type Call = { event: string; properties: Record<string, unknown>; timestamp?: Date };
const calls = (): Call[] => captureSpy.mock.calls.map((c) => c[0] as Call);

describe('pre-init queue', () => {
  beforeEach(async () => {
    await shutdownAnalytics();
    captureSpy.mockClear();
    _resetPreInitForTests(false);
  });

  it('replays events captured before init, with their original time', async () => {
    cfg.value = { analytics_install_id: 'install-0000', analytics_opt_out: false };
    const before = Date.now();
    capture('onboarding_step', { step: 'intro', action: 'view' });
    expect(captureSpy).not.toHaveBeenCalled();
    await initAnalytics();
    const c = calls();
    expect(c).toHaveLength(1);
    expect(c[0].event).toBe('onboarding_step');
    expect(c[0].properties).toMatchObject({ step: 'intro', action: 'view' });
    expect(c[0].timestamp).toBeInstanceOf(Date);
    expect(c[0].timestamp!.getTime()).toBeGreaterThanOrEqual(before);
    // After init, events go straight through without a timestamp override.
    capture('app_opened');
    expect(calls()[1].timestamp).toBeUndefined();
  });

  it('drops held events when the user opted out', async () => {
    cfg.value = { analytics_install_id: 'install-0000', analytics_opt_out: true };
    capture('onboarding_step', { step: 'intro', action: 'view' });
    await initAnalytics();
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('drops held events when the opt-out flag could not be read', async () => {
    // A prior good read leaves optedOut false in module state, so only the
    // unknown-consent guard can keep the held event from going out.
    cfg.value = { analytics_install_id: 'install-0000', analytics_opt_out: false };
    await initAnalytics();
    await shutdownAnalytics();
    _resetPreInitForTests(false);
    const { updateConfig } = await import('./configStore');
    vi.mocked(updateConfig).mockRejectedValueOnce(new Error('EACCES'));
    capture('onboarding_step', { step: 'intro', action: 'view' });
    await initAnalytics();
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('is bounded', async () => {
    cfg.value = { analytics_install_id: 'install-0000', analytics_opt_out: false };
    for (let i = 0; i < 500; i++) capture('onboarding_step', { i });
    await initAnalytics();
    expect(captureSpy.mock.calls.length).toBe(200);
  });
});

describe('backend property', () => {
  it("is 'unset' only for a not-yet-onboarded profile on the default kind", () => {
    expect(backendProp('local', false)).toBe('unset');
    expect(backendProp('local', true)).toBe('local');
    expect(backendProp('cloud-proxy', false)).toBe('cloud-proxy');
  });

  it('rides every event and follows setProfileOnboarded', async () => {
    await shutdownAnalytics();
    captureSpy.mockClear();
    _resetPreInitForTests(false);
    cfg.value = { analytics_install_id: 'install-0000', analytics_opt_out: false, preferred_name: '' };
    await initAnalytics();
    capture('app_opened');
    setProfileOnboarded('Sam');
    capture('app_opened');
    const c = calls();
    expect(c[0].properties.backend).toBe('unset');
    expect(c[1].properties.backend).toBe('local');
  });
});

describe('app_quit', () => {
  it('maps event names to surfaces', () => {
    expect(surfaceForEvent('chess_game_started')).toBe('chess');
    expect(surfaceForEvent('character_summoned')).toBe('game');
    expect(surfaceForEvent('voice_call_started')).toBe('voice');
    expect(surfaceForEvent('voice_call_ended')).toBeNull();
    expect(surfaceForEvent('chat_session_ended')).toBeNull();
    expect(surfaceForEvent('app_opened')).toBeNull();
  });

  it('carries session_ms and the last surface', async () => {
    await shutdownAnalytics();
    captureSpy.mockClear();
    _resetPreInitForTests(false);
    cfg.value = { analytics_install_id: 'install-0000', analytics_opt_out: false, preferred_name: 'Sam' };
    await initAnalytics();
    captureAppQuit();
    expect(calls()[0].properties).toMatchObject({ last_surface: 'none' });
    // Once per process: a re-entered before-quit sends nothing more.
    captureAppQuit();
    expect(calls()).toHaveLength(1);
    _resetPreInitForTests(true);
    capture('draw_game_started', {});
    noteSurface(null);
    captureAppQuit();
    const q = calls()[2].properties;
    expect(q.last_surface).toBe('draw');
    expect(typeof q.session_ms).toBe('number');
  });
});
