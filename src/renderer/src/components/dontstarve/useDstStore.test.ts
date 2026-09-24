/**
 * useDstStore install-state persistence (260925, v0.6.5-beta.2 playtest).
 * "Add Sei's helper" failed with EPERM (macOS App Management) and the step
 * showed the permission line for under 3 s: the setup hook's 3 s poll called
 * refreshInstall, whose detection pass (disk only, it never reports an
 * install error) replaced the error with a plain "helper missing".
 * Invariants:
 *   1. A detection pass does not replace an install error while the helper
 *      is still missing.
 *   2. The error clears when the helper is actually in the game, or the game
 *      is no longer found.
 *   3. A detection pass is not applied while an install is in flight, even
 *      one that started before the install and resolved during it.
 *   4. Try again (runInstall) replaces the error.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DstInstallState } from '@shared/dstIpc';

const MISSING: DstInstallState = {
  kind: 'found', installPath: '/Applications/dontstarve_steam.app', modsDir: '/Applications/dontstarve_steam.app/Contents/mods',
  modInstalled: false, modVersion: null, enabled: false, gameRunning: false, needsRestart: false,
};
const INSTALLED: DstInstallState = { ...MISSING, modInstalled: true, modVersion: '0.1.0', enabled: true };
const EPERM: DstInstallState = {
  kind: 'error', error: 'GAME_INSTALL_FAILED', message: "EPERM: operation not permitted, mkdir '.../mods/sei'", permission: true,
};

interface Bridge {
  dstInstallState: ReturnType<typeof vi.fn>;
  dstInstall: ReturnType<typeof vi.fn>;
  onDstInstallProgress: ReturnType<typeof vi.fn>;
}

async function loadStore(bridge: Bridge) {
  vi.resetModules();
  vi.doMock('../../lib/ipcClient', () => ({ sei: bridge }));
  const mod = await import('./useDstStore');
  return mod;
}

let bridge: Bridge;
beforeEach(() => {
  bridge = {
    dstInstallState: vi.fn(async () => MISSING),
    dstInstall: vi.fn(async () => EPERM),
    onDstInstallProgress: vi.fn(() => () => undefined),
  };
});

describe('mergeDetected', () => {
  it('keeps an install error while the helper is still missing', async () => {
    const { mergeDetected } = await loadStore(bridge);
    expect(mergeDetected(EPERM, MISSING, false)).toBe(EPERM);
  });
  it('clears it once the helper is in, or the game is gone', async () => {
    const { mergeDetected } = await loadStore(bridge);
    expect(mergeDetected(EPERM, INSTALLED, false)).toBe(INSTALLED);
    const gone: DstInstallState = { kind: 'not_found', searched: [] };
    expect(mergeDetected(EPERM, gone, false)).toBe(gone);
  });
  it('drops a pass while an install runs', async () => {
    const { mergeDetected } = await loadStore(bridge);
    const installing: DstInstallState = { kind: 'installing', step: 'copying' };
    expect(mergeDetected(installing, MISSING, true)).toBe(installing);
  });
  it('applies a normal pass', async () => {
    const { mergeDetected } = await loadStore(bridge);
    expect(mergeDetected(MISSING, INSTALLED, false)).toBe(INSTALLED);
    expect(mergeDetected(null, MISSING, false)).toBe(MISSING);
  });
});

describe('useDstStore', () => {
  it('the poll does not wipe the permission error (the playtest bug)', async () => {
    const { useDstStore } = await loadStore(bridge);
    await useDstStore.getState().runInstall();
    expect(useDstStore.getState().install).toEqual(EPERM);
    // Three poll ticks later the error is still what the step renders.
    for (let i = 0; i < 3; i++) await useDstStore.getState().refreshInstall();
    expect(useDstStore.getState().install).toEqual(EPERM);
  });

  it('clears the error when the helper shows up in the game', async () => {
    const { useDstStore } = await loadStore(bridge);
    await useDstStore.getState().runInstall();
    bridge.dstInstallState.mockResolvedValueOnce(INSTALLED);
    await useDstStore.getState().refreshInstall();
    expect(useDstStore.getState().install).toEqual(INSTALLED);
  });

  it('does not poll over an install in flight, even a pass that started before it', async () => {
    let finishDetect!: (s: DstInstallState) => void;
    bridge.dstInstallState.mockImplementationOnce(() => new Promise((r) => { finishDetect = r; }));
    let finishInstall!: (s: DstInstallState) => void;
    bridge.dstInstall.mockImplementationOnce(() => new Promise((r) => { finishInstall = r; }));
    const { useDstStore } = await loadStore(bridge);

    const slowPoll = useDstStore.getState().refreshInstall();
    const install = useDstStore.getState().runInstall();
    expect(useDstStore.getState().install).toEqual({ kind: 'installing', step: 'copying' });

    // A poll tick during the install is skipped without asking main.
    const calls = bridge.dstInstallState.mock.calls.length;
    await useDstStore.getState().refreshInstall();
    expect(bridge.dstInstallState.mock.calls.length).toBe(calls);

    // The pass that started first resolves mid-install and is dropped.
    finishDetect(MISSING);
    await slowPoll;
    expect(useDstStore.getState().install).toEqual({ kind: 'installing', step: 'copying' });

    finishInstall(EPERM);
    await install;
    expect(useDstStore.getState().install).toEqual(EPERM);
  });

  it('Try again replaces the error with the new attempt', async () => {
    const { useDstStore } = await loadStore(bridge);
    await useDstStore.getState().runInstall();
    bridge.dstInstall.mockResolvedValueOnce(INSTALLED);
    await useDstStore.getState().runInstall();
    expect(useDstStore.getState().install).toEqual(INSTALLED);
  });
});
