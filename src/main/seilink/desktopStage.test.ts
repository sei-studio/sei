import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  windows: [] as unknown[],
  appHide: vi.fn(),
  appFocus: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
  app: { hide: electron.appHide, focus: electron.appFocus },
  screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}));

import {
  enterDesktopStage,
  exitDesktopStage,
  isStaged,
  planEnter,
  planExit,
  planReveal,
  revealDesktop,
  type StageOp,
  type StageSnapshot,
} from './desktopStage';

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
const BOUNDS = { x: 200, y: 150, width: 1200, height: 800 };

function snap(over: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    platform: 'win32',
    bounds: { ...BOUNDS },
    maximized: false,
    minimized: false,
    visible: true,
    nativeFullScreen: false,
    resizable: true,
    display: { ...DISPLAY },
    ...over,
  };
}

const names = (ops: StageOp[]): string[] => ops.map((o) => o.op);

describe('planEnter', () => {
  it('Windows: frameless window sized to the display, not setFullScreen', () => {
    const p = planEnter(snap());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(names(p.ops)).toEqual(['resizable', 'setBounds', 'focus']);
    expect(p.ops[1]).toEqual({ op: 'setBounds', bounds: DISPLAY });
    expect(p.saved).toEqual({ platform: 'win32', bounds: BOUNDS, maximized: false, resizable: true });
  });

  it('macOS: onto the primary display, traffic lights off, then simple fullscreen', () => {
    const p = planEnter(snap({ platform: 'darwin', bounds: { x: 2500, y: 100, width: 1200, height: 800 } }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(names(p.ops)).toEqual(['setBounds', 'buttons', 'simpleFullScreen', 'focus']);
    const b = (p.ops[0] as { bounds: { x: number; y: number; width: number; height: number } }).bounds;
    expect(b.x).toBeGreaterThanOrEqual(DISPLAY.x);
    expect(b.x + b.width).toBeLessThanOrEqual(DISPLAY.x + DISPLAY.width);
    expect(p.ops[2]).toEqual({ op: 'simpleFullScreen', on: true });
  });

  it('a maximized window is unmaximized first and remembered as maximized', () => {
    const p = planEnter(snap({ maximized: true }));
    if (!p.ok) throw new Error('refused');
    expect(p.ops[0]).toEqual({ op: 'unmaximize' });
    expect(p.saved.maximized).toBe(true);
  });

  it('a hidden or minimized window comes back transparent and only shows once on the stage', () => {
    const hidden = planEnter(snap({ platform: 'darwin', visible: false }));
    if (!hidden.ok) throw new Error('refused');
    expect(names(hidden.ops)).toEqual(['opacity', 'show', 'setBounds', 'buttons', 'simpleFullScreen', 'opacity', 'focus']);
    expect(hidden.ops[0]).toEqual({ op: 'opacity', value: 0 });
    expect(hidden.ops[5]).toEqual({ op: 'opacity', value: 1 });
    const min = planEnter(snap({ minimized: true }));
    if (!min.ok) throw new Error('refused');
    expect(names(min.ops)).toEqual(['opacity', 'restore', 'resizable', 'setBounds', 'opacity', 'focus']);
  });

  it('refuses a window in native fullscreen (its own Space, away from the desktop)', () => {
    expect(planEnter(snap({ platform: 'darwin', nativeFullScreen: true }))).toEqual({ ok: false, error: 'native_fullscreen' });
  });
});

describe('planExit', () => {
  const saved = { platform: 'win32' as const, bounds: BOUNDS, maximized: true, resizable: true };

  it('Windows reveal: hide, restore bounds while hidden, minimize, maximize again on restore', () => {
    expect(names(planExit(saved, true))).toEqual(['hide', 'setBounds', 'resizable', 'remaximizeOnRestore', 'minimize']);
  });

  it('Windows back to the app: bounds, maximize, show', () => {
    expect(names(planExit(saved, false))).toEqual(['setBounds', 'resizable', 'maximize', 'show', 'focus']);
  });

  it('macOS reveal: hide before leaving simple fullscreen, then hide the app', () => {
    const ops = planExit({ ...saved, platform: 'darwin', maximized: false }, true);
    expect(names(ops)).toEqual(['hide', 'simpleFullScreen', 'buttons', 'setBounds', 'hideApp']);
    expect(ops[1]).toEqual({ op: 'simpleFullScreen', on: false });
  });

  it('macOS back to the app shows the window as it was', () => {
    expect(names(planExit({ ...saved, platform: 'darwin', maximized: false }, false))).toEqual(['simpleFullScreen', 'buttons', 'setBounds', 'show', 'focus']);
  });
});

describe('planReveal', () => {
  it('macOS hides, Windows and Linux minimize', () => {
    expect(names(planReveal('darwin'))).toEqual(['hide', 'hideApp']);
    expect(names(planReveal('win32'))).toEqual(['minimize']);
    expect(names(planReveal('linux'))).toEqual(['minimize']);
  });
});

/** A BrowserWindow stand-in that records calls. */
function fakeWindow(over: { visible?: boolean; minimized?: boolean; fullScreen?: boolean } = {}) {
  const calls: string[] = [];
  let visible = over.visible ?? true;
  let minimized = over.minimized ?? false;
  const listeners = new Map<string, Array<() => void>>();
  const w = {
    calls,
    isDestroyed: () => false,
    isMaximized: () => false,
    isMinimized: () => minimized,
    isVisible: () => visible,
    isFullScreen: () => over.fullScreen ?? false,
    isResizable: () => true,
    getBounds: () => ({ ...BOUNDS }),
    getNormalBounds: () => ({ ...BOUNDS }),
    setBounds: (b: unknown) => calls.push(`setBounds:${JSON.stringify(b)}`),
    setResizable: (on: boolean) => calls.push(`resizable:${on}`),
    setSimpleFullScreen: (on: boolean) => calls.push(`simple:${on}`),
    setWindowButtonVisibility: (on: boolean) => calls.push(`buttons:${on}`),
    setOpacity: (v: number) => calls.push(`opacity:${v}`),
    unmaximize: () => calls.push('unmaximize'),
    maximize: () => calls.push('maximize'),
    restore: () => {
      minimized = false;
      calls.push('restore');
    },
    show: () => {
      visible = true;
      calls.push('show');
    },
    hide: () => {
      visible = false;
      calls.push('hide');
    },
    minimize: () => {
      minimized = true;
      calls.push('minimize');
    },
    focus: () => calls.push('focus'),
    once: (ev: string, fn: () => void) => listeners.set(ev, [...(listeners.get(ev) ?? []), fn]),
    off: () => undefined,
  };
  return w;
}

describe('runtime', () => {
  beforeEach(() => {
    electron.windows = [];
  });

  it('enters once, refuses a second window, and exits with the time on stage', () => {
    const w = fakeWindow();
    const other = fakeWindow();
    expect(enterDesktopStage(w as never)).toEqual({ ok: true });
    expect(isStaged(w as never)).toBe(true);
    expect(enterDesktopStage(w as never)).toEqual({ ok: true });
    expect(enterDesktopStage(other as never)).toEqual({ ok: false, error: 'busy' });
    // Not staged: nothing to exit.
    expect(exitDesktopStage(other as never, true).ok).toBe(false);
    const r = exitDesktopStage(w as never, true);
    expect(r.ok).toBe(true);
    expect(r.stagedMs).toBeGreaterThanOrEqual(0);
    expect(isStaged()).toBe(false);
  });

  it('a native-fullscreen window is refused and left alone', () => {
    const w = fakeWindow({ fullScreen: true });
    expect(enterDesktopStage(w as never)).toEqual({ ok: false, error: 'native_fullscreen' });
    expect(isStaged()).toBe(false);
  });

  it('no window: no_window', () => {
    expect(enterDesktopStage(null)).toEqual({ ok: false, error: 'no_window' });
  });

  it('a window that throws while entering is given back, visible', () => {
    const w = fakeWindow({ visible: false });
    (w as { setBounds: (b: unknown) => void }).setBounds = () => {
      throw new Error('boom');
    };
    expect(enterDesktopStage(w as never)).toEqual({ ok: false, error: 'failed' });
    expect(isStaged()).toBe(false);
    expect(w.isVisible()).toBe(true);
  });

  it('reveal without the stage steps aside; on the stage it does nothing', () => {
    const w = fakeWindow();
    expect(revealDesktop(w as never)).toBe(true);
    expect(w.calls.length).toBeGreaterThan(0);
    const s = fakeWindow();
    enterDesktopStage(s as never);
    expect(revealDesktop(s as never)).toBe(false);
    exitDesktopStage(s as never, false);
  });
});
