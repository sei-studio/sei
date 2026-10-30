import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installUpdate = vi.fn(async () => undefined);
const fakeSei = { platform: 'darwin', installUpdate: () => installUpdate() };
vi.mock('../ipcClient', () => ({ sei: fakeSei }));

const { useUpdateStore, RESTART_STUCK_MS, showsWindowsUpdateNote } = await import('./useUpdateStore');

describe('useUpdateStore (261023)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeSei.platform = 'darwin';
    installUpdate.mockClear();
    useUpdateStore.setState({ rail: null, toast: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a late progress tick never hides a finished download', () => {
    const s = useUpdateStore.getState();
    s.setDownloading(10);
    s.setReady('0.7.0');
    s.setDownloading(99);
    expect(useUpdateStore.getState().rail).toEqual({ kind: 'ready', version: '0.7.0' });
  });

  it('an error clears a download in flight but keeps a ready update', () => {
    const s = useUpdateStore.getState();
    s.setDownloading(30);
    s.clearRail();
    expect(useUpdateStore.getState().rail).toBeNull();
    s.setReady('0.7.0');
    s.clearRail();
    expect(useUpdateStore.getState().rail?.kind).toBe('ready');
  });

  it('restart installs once and only from ready', async () => {
    const s = useUpdateStore.getState();
    s.restart();
    expect(useUpdateStore.getState().rail).toBeNull();
    s.setReady('0.7.0');
    s.restart();
    s.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().rail).toEqual({ kind: 'restarting', version: '0.7.0' });
  });

  it('puts the button back when the app is still alive after the stuck window', async () => {
    const s = useUpdateStore.getState();
    s.setReady('0.7.0');
    s.restart();
    await vi.advanceTimersByTimeAsync(RESTART_STUCK_MS - 1);
    expect(useUpdateStore.getState().rail?.kind).toBe('restarting');
    await vi.advanceTimersByTimeAsync(1);
    expect(useUpdateStore.getState().rail).toEqual({ kind: 'ready', version: '0.7.0' });
  });

  it('puts the button back at once when the install call fails', async () => {
    installUpdate.mockRejectedValueOnce(new Error('no'));
    const s = useUpdateStore.getState();
    s.setReady('0.7.0');
    s.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(useUpdateStore.getState().rail).toEqual({ kind: 'ready', version: '0.7.0' });
  });

  it('on Windows calls main straight away; main owns the note hold (261030)', async () => {
    fakeSei.platform = 'win32';
    const s = useUpdateStore.getState();
    s.setReady('0.7.0');
    s.restart();
    expect(useUpdateStore.getState().rail).toEqual({ kind: 'restarting', version: '0.7.0' });
    await vi.advanceTimersByTimeAsync(0);
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it('on macOS installs straight away', async () => {
    const s = useUpdateStore.getState();
    s.setReady('0.7.0');
    s.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('Windows update note platform gate (261030)', () => {
  it('is Windows only', () => {
    expect(showsWindowsUpdateNote('win32')).toBe(true);
    expect(showsWindowsUpdateNote('darwin')).toBe(false);
    expect(showsWindowsUpdateNote('linux')).toBe(false);
    expect(showsWindowsUpdateNote(undefined)).toBe(false);
  });
});
