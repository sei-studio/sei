import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  enabled: true,
  live: 'sui' as string | null,
  staged: false,
  enter: { ok: true } as { ok: true; frame?: unknown } | { ok: false; error: string },
  reveal: true,
  minimize: { ok: true, minimized: 3 } as { ok: true; minimized?: number } | { ok: false; error: string },
}));

vi.mock('electron', () => ({ app: { focus: vi.fn() }, ipcMain: { handle: vi.fn(), on: vi.fn() }, BrowserWindow: class {} }));
vi.mock('../lazyAnalytics', () => ({
  loadAnalytics: async () => ({ capture: (event: string, props: Record<string, unknown>) => m.events.push({ event, ...props }) }),
}));
vi.mock('./gate', () => ({ seilinkEnabled: () => m.enabled }));
vi.mock('./host/seilinkHost', () => ({ seilinkLiveCharacter: () => m.live }));
vi.mock('./roomStore', () => ({ isRoomCharacterId: (id: unknown) => typeof id === 'string' && /^[a-z]+$/.test(id) }));
vi.mock('./decorateOffer', () => ({ offerDecorateTogether: vi.fn(async () => ({ shown: true, line: 'her' })) }));
vi.mock('./desktopStage', () => ({
  enterDesktopStage: () => {
    if (m.enter.ok) m.staged = true;
    return m.enter;
  },
  exitDesktopStage: () => {
    m.staged = false;
    return { ok: true, stagedMs: 1234 };
  },
  isStaged: () => m.staged,
  revealDesktop: () => m.reveal,
}));
vi.mock('./minimizeOthers', () => ({ minimizeOtherWindows: async () => m.minimize }));

import { EDITOR_ENTER_WAIT_MS, __resetStageFlowForTest, handleMinimizeOthers, handleStage, initStageFlow, openDesktopEditor } from './stageFlow';

function fakeWindow(visible = false) {
  const sent: Array<[string, unknown]> = [];
  let shown = visible;
  return {
    sent,
    shown: () => shown,
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMinimized: () => false,
    isVisible: () => shown,
    setOpacity: vi.fn(),
    restore: vi.fn(),
    show: () => {
      shown = true;
    },
    focus: vi.fn(),
    webContents: { send: (ch: string, p: unknown) => sent.push([ch, p]) },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('stage flow', () => {
  let win: ReturnType<typeof fakeWindow>;
  const openWithWindow = vi.fn();

  beforeEach(() => {
    __resetStageFlowForTest();
    m.events = [];
    m.enabled = true;
    m.live = 'sui';
    m.staged = false;
    m.enter = { ok: true };
    win = fakeWindow(false);
    openWithWindow.mockReset();
    initStageFlow({ getMainWindow: () => win as never, openWithWindow });
  });

  it('the dock opens her editor on the desktop without showing the window first', () => {
    openDesktopEditor('sui', 'dock');
    expect(win.sent).toEqual([['seilink:open-room-editor', { characterId: 'sui', openedFrom: 'dock', desktop: true }]]);
    expect(win.shown()).toBe(false);
    expect(openWithWindow).not.toHaveBeenCalled();
  });

  it('shows the window the usual way when no stage enter arrives in time', async () => {
    vi.useFakeTimers();
    openDesktopEditor('sui', 'dock');
    await vi.advanceTimersByTimeAsync(EDITOR_ENTER_WAIT_MS + 10);
    expect(win.shown()).toBe(true);
    await flush();
    expect(m.events).toContainEqual(expect.objectContaining({ event: 'seilink_desktop_stage', action: 'failed', error_class: 'timeout' }));
    vi.useRealTimers();
  });

  it('an enter in time cancels the fallback and is recorded', async () => {
    vi.useFakeTimers();
    openDesktopEditor('sui', 'offer');
    expect(handleStage(win as never, { action: 'enter', purpose: 'editor', characterId: 'sui', openedFrom: 'offer' })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(EDITOR_ENTER_WAIT_MS + 10);
    vi.useRealTimers();
    await flush();
    expect(m.events.map((e) => e.action)).toEqual(['entered']);
    expect(m.events[0]).toMatchObject({ purpose: 'editor', opened_from: 'offer', character_id: 'sui' });
  });

  it('someone who does not live there gets the editor in the app', () => {
    openDesktopEditor('lyra', 'dock');
    expect(openWithWindow).toHaveBeenCalledWith('seilink:open-room-editor', { characterId: 'lyra', openedFrom: 'dock', desktop: false });
  });

  it('a refused stage keeps the surface in the window and shows it', async () => {
    m.enter = { ok: false, error: 'native_fullscreen' };
    expect(handleStage(win as never, { action: 'enter', purpose: 'intro', characterId: 'sui' })).toEqual({ ok: false, error: 'native_fullscreen' });
    expect(win.shown()).toBe(true);
    await flush();
    expect(m.events[0]).toMatchObject({ action: 'failed', purpose: 'intro', error_class: 'native_fullscreen' });
  });

  it('exit records the reveal and the time on stage', async () => {
    handleStage(win as never, { action: 'enter', purpose: 'editor', characterId: 'sui', openedFrom: 'button' });
    expect(handleStage(win as never, { action: 'exit', reveal: true })).toEqual({ ok: true });
    await flush();
    expect(m.events[1]).toMatchObject({ action: 'exited', purpose: 'editor', opened_from: 'button', reveal: true, staged_ms: 1234 });
  });

  it('refuses while SeiLink is off and checks the id', () => {
    m.enabled = false;
    expect(handleStage(win as never, { action: 'enter', purpose: 'editor', characterId: 'sui' })).toEqual({ ok: false, error: 'disabled' });
    m.enabled = true;
    expect(handleStage(win as never, { action: 'enter', purpose: 'editor', characterId: '../x' })).toEqual({ ok: false, error: 'failed' });
  });

  it('reveal steps aside without the stage', async () => {
    expect(handleStage(win as never, { action: 'reveal', purpose: 'move_in', characterId: 'sui' })).toEqual({ ok: true });
    await flush();
    expect(m.events[0]).toMatchObject({ action: 'revealed', purpose: 'move_in' });
  });

  it('261110: an enter hands back where the display sits in the window', () => {
    m.enter = { ok: true, frame: { x: 0, y: 0, width: 1920, height: 1080 } };
    expect(handleStage(win as never, { action: 'enter', purpose: 'intro', characterId: 'sui' })).toEqual({ ok: true, frame: { x: 0, y: 0, width: 1920, height: 1080 } });
    m.enter = { ok: true };
  });

  it('261110: minimize_others minimizes, says how many, and counts it (shape only)', async () => {
    m.events = [];
    expect(await handleMinimizeOthers({ action: 'minimize_others', surface: 'live_card' })).toEqual({ ok: true, minimized: 3 });
    await flush();
    expect(m.events.at(-1)).toMatchObject({ event: 'seilink_minimize_windows', outcome: 'ok', windows: 3, surface: 'live_card' });
    m.minimize = { ok: false, error: 'unsupported' };
    expect(await handleMinimizeOthers({ action: 'minimize_others' })).toEqual({ ok: false, error: 'unsupported' });
    await flush();
    expect(m.events.at(-1)).toMatchObject({ event: 'seilink_minimize_windows', outcome: 'unsupported', surface: 'other' });
    m.enabled = false;
    expect(await handleMinimizeOthers({ action: 'minimize_others' })).toEqual({ ok: false, error: 'disabled' });
    m.enabled = true;
    m.minimize = { ok: true, minimized: 3 };
  });
});
