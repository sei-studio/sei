/**
 * startControl's start window: a stop, the end of the share, or a newer
 * control() call that lands while the helper is still starting must cancel
 * that start, not let it begin driving afterwards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', getAppMetrics: () => [] },
  BrowserWindow: { getAllWindows: () => [] },
  globalShortcut: { register: () => true, unregister: () => {} },
}));
vi.mock('./controlTool', () => ({ actFlagFromEnv: () => true }));
vi.mock('../llm', () => ({
  buildLlmProvider: async () => ({ kind: 'anthropic', model: 'claude-sonnet-5', call: async () => ({ toolUses: [], text: '' }) }),
}));
vi.mock('./driveOverlay', () => ({
  createDriveOverlay: () => ({ setDetail: () => {}, rect: () => null, nativeWindowId: () => null, close: () => {} }),
}));

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const helpers: Array<{ disposed: boolean; gate: Deferred }> = [];

vi.mock('./inputHelper', () => ({
  helperPath: () => '/bin/helper',
  MacInputHelper: {
    start: async () => {
      const rec = { disposed: false, gate: deferred() };
      helpers.push(rec);
      return {
        ready: {},
        // Permissions hang until the test releases them: the start window.
        permissions: async () => {
          await rec.gate.promise;
          return { axTrusted: true, postEventAccess: true, screenCaptureAccess: true };
        },
        windows: async () => [{ id: 77, pid: 9, layer: 0, alpha: 1, onScreen: true, bounds: { x: 0, y: 0, w: 800, h: 600 } }],
        displays: async () => [{ id: 1, bounds: { x: 0, y: 0, w: 1440, h: 900 }, scale: 2, main: true }],
        watch: () => new Promise(() => {}),
        onUserInput: () => () => {},
        cancel: async () => {},
        releaseAll: async () => {},
        dispose: () => {
          rec.disposed = true;
        },
      };
    },
  },
}));

import { ACT_CANCELLED, isActing, startControl, stopAct } from './actSession';

const opts = (characterId: string) => ({
  characterId,
  characterName: 'Sui',
  sourceId: 'window:77:0',
  sourceName: 'Safari',
  goal: 'open the settings',
  speak: () => {},
  log: () => {},
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('startControl start window', () => {
  beforeEach(() => {
    helpers.length = 0;
  });

  it('a stop during the start cancels it: no run, helper disposed', async () => {
    const p = startControl(opts('c1'));
    await tick();
    expect(helpers).toHaveLength(1);
    stopAct('c1');
    helpers[0]!.gate.resolve();
    await expect(p).resolves.toEqual({ ok: false, error: ACT_CANCELLED });
    expect(helpers[0]!.disposed).toBe(true);
    expect(isActing('c1')).toBe(false);
  });

  it('a newer start (any character) cancels one still starting', async () => {
    const first = startControl(opts('c1'));
    await tick();
    const second = startControl(opts('c2'));
    await tick();
    expect(helpers).toHaveLength(2);
    for (const h of helpers) h.gate.resolve();
    await expect(first).resolves.toEqual({ ok: false, error: ACT_CANCELLED });
    await expect(second).resolves.toEqual({ ok: true });
    expect(isActing('c1')).toBe(false);
    expect(isActing('c2')).toBe(true);
    stopAct('c2');
  });
});
