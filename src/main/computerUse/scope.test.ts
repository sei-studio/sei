import { describe, expect, it } from 'vitest';
import { checkScope, type ScopeContext } from './scope';
import { targetFromSourceId } from './env';
import type { WindowInfo } from './types';

const win = (id: number, pid: number, bounds: WindowInfo['bounds'], owner = 'App'): WindowInfo => ({
  id,
  pid,
  layer: 0,
  alpha: 1,
  bounds,
  onScreen: true,
  owner,
});
const shared = win(10, 100, { x: 0, y: 0, w: 800, h: 600 }, 'Safari');
const cover = win(11, 200, { x: 500, y: 400, w: 400, h: 300 }, 'Notes');
const displays = [{ id: 1, bounds: { x: 0, y: 0, w: 1512, h: 982 }, scale: 2, main: true }];
const base: ScopeContext = {
  target: { kind: 'window', windowId: 10, pid: 100 },
  windows: [cover, shared],
  displays,
  frontmost: { pid: 100, name: 'Safari' },
  seiPids: new Set([999]),
};
const pt = (x: number, y: number) => ({ points: [{ x, y }], keyboard: false, typing: false });

describe('checkScope (window share)', () => {
  it('allows a point on the shared window', () => {
    expect(checkScope(base, pt(100, 100))).toEqual({ ok: true });
  });
  it('refuses outside the window, under another window, and on Sei controls', () => {
    expect(checkScope(base, pt(900, 100)).ok).toBe(false);
    expect(checkScope(base, pt(600, 500))).toMatchObject({ ok: false, reason: expect.stringMatching(/Notes/) });
    expect(checkScope({ ...base, seiRects: [{ x: 0, y: 0, w: 50, h: 50 }] }, pt(10, 10)).ok).toBe(false);
  });
  it('refuses keys when another app has focus', () => {
    const k = { points: [], keyboard: true, typing: true };
    expect(checkScope(base, k).ok).toBe(true);
    expect(checkScope({ ...base, frontmost: { pid: 200, name: 'Notes' } }, k)).toMatchObject({ ok: false });
  });
  it('fails closed when the window is gone', () => {
    expect(checkScope({ ...base, windows: [cover] }, pt(1, 1)).ok).toBe(false);
  });
});

describe('checkScope (screen share)', () => {
  const screen: ScopeContext = { ...base, target: { kind: 'screen', displayId: 1 }, bundleIdOf: (pid) => (pid === 300 ? 'com.apple.Terminal' : undefined) };
  it('allows any ordinary app and refuses denied ones and Sei', () => {
    expect(checkScope(screen, pt(600, 500)).ok).toBe(true);
    const term = win(12, 300, { x: 1000, y: 0, w: 400, h: 400 }, 'Terminal');
    expect(checkScope({ ...screen, windows: [term, ...screen.windows] }, pt(1100, 100)).ok).toBe(false);
    const sei = win(13, 999, { x: 1000, y: 500, w: 200, h: 200 }, 'Sei');
    expect(checkScope({ ...screen, windows: [sei, ...screen.windows] }, pt(1100, 600)).ok).toBe(false);
  });
});

describe('targetFromSourceId', () => {
  it('parses desktopCapturer ids', () => {
    expect(targetFromSourceId('window:1234:0', 'x')).toEqual({ kind: 'window', windowId: 1234, label: 'x' });
    expect(targetFromSourceId('screen:69733378:0')).toMatchObject({ kind: 'screen', displayId: 69733378 });
    expect(targetFromSourceId('camera:1')).toBeNull();
  });
});
