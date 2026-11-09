import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sent: [] as string[], ps: '4' as string | null, env: null as Record<string, string> | null }));
vi.mock('electron', () => ({
  Menu: { sendActionToFirstResponder: (a: string) => h.sent.push(a) },
  app: { getAppMetrics: () => [{ pid: 11 }, { pid: 12 }] },
}));
vi.mock('../winPowerShell', () => ({
  runPowerShell: async (_s: string, _t: number, env: Record<string, string>) => {
    h.env = env;
    return h.ps;
  },
}));

import { MINIMIZE_SCRIPT, minimizeOtherWindows } from './minimizeOthers';

const realPlatform = process.platform;
const setPlatform = (p: string): void => {
  Object.defineProperty(process, 'platform', { value: p });
};

describe('minimizeOtherWindows (261110)', () => {
  afterEach(() => setPlatform(realPlatform));

  it('Windows: minimizes without activating, never Sei or the shell, and reads the count', async () => {
    expect(MINIMIZE_SCRIPT).toContain('ShowWindowAsync(h, 7)');
    for (const cls of ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']) expect(MINIMIZE_SCRIPT).toContain(`"${cls}"`);
    expect(MINIMIZE_SCRIPT).toContain('SEI_KEEP_PIDS');
    setPlatform('win32');
    h.ps = 'noise\n4';
    expect(await minimizeOtherWindows()).toEqual({ ok: true, minimized: 4 });
    expect(h.env?.SEI_KEEP_PIDS.split(',')).toEqual(expect.arrayContaining([String(process.pid), '11', '12']));
    h.ps = null;
    expect(await minimizeOtherWindows()).toEqual({ ok: false, error: 'failed' });
  });

  it('macOS: the app menu\'s Hide Others; Linux: unsupported', async () => {
    setPlatform('darwin');
    expect(await minimizeOtherWindows()).toEqual({ ok: true });
    expect(h.sent).toEqual(['hideOtherApplications:']);
    setPlatform('linux');
    expect(await minimizeOtherWindows()).toEqual({ ok: false, error: 'unsupported' });
  });
});
