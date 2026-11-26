/**
 * 261123 launch timing: app_first_view is sent once, with the boot routing's
 * auth wait.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('./ipcClient', () => ({ sei: bridge }));

import { FIRST_VIEW_EVENT, reportFirstView, resetFirstViewForTest, timeAuthWait } from './firstView';

beforeEach(() => {
  resetFirstViewForTest();
  bridge.track.mockReset();
});

describe('reportFirstView', () => {
  it('sends once per renderer load', () => {
    reportFirstView('home');
    reportFirstView('settings');
    expect(bridge.track).toHaveBeenCalledTimes(1);
    expect(bridge.track).toHaveBeenCalledWith(
      FIRST_VIEW_EVENT,
      expect.objectContaining({ view_kind: 'home', waited_auth_ms: 0, renderer_ms: expect.any(Number) }),
    );
  });

  it('names the onboarding sign-in panel signin', () => {
    reportFirstView('onboard', { signin: true });
    expect(bridge.track.mock.calls[0][1]).toMatchObject({ view_kind: 'signin' });
  });

  it('carries the auth wait', async () => {
    vi.useFakeTimers();
    try {
      const p = timeAuthWait(() => new Promise<string>((r) => setTimeout(() => r('ok'), 250)));
      await vi.advanceTimersByTimeAsync(250);
      await expect(p).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
    reportFirstView('home');
    expect(bridge.track.mock.calls[0][1].waited_auth_ms).toBeGreaterThanOrEqual(0);
  });

  it('never throws when the bridge does', () => {
    bridge.track.mockImplementation(() => {
      throw new Error('gone');
    });
    expect(() => reportFirstView('home')).not.toThrow();
  });
});
