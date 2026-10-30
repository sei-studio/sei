import { describe, expect, it } from 'vitest';
import { restartInstallArgs } from './updateInstall';

describe('restartInstallArgs', () => {
  it('runs the Windows installer visibly and relaunches Sei (261030)', () => {
    // NsisUpdater maps (false, true) to `--updated --force-run`: the one-click
    // "Installing, please wait" window shows, nothing to click, then Sei
    // reopens (autoRunAppAfterInstall supplies --force-run when not silent).
    // (true, true) was `--updated /S --force-run`: ~100 s with no window.
    const [isSilent, isForceRunAfter] = restartInstallArgs('win32');
    expect(isSilent).toBe(false);
    expect(isForceRunAfter).toBe(true);
  });

  it("runs the installer silently under Sei's own progress window (261030)", () => {
    // updateProgressHelper's window is up, so the stock NSIS banner would only
    // sit on top of it: `--updated /S --force-run`, and Sei still reopens.
    expect(restartInstallArgs('win32', { progressWindow: true })).toEqual([true, true]);
    expect(restartInstallArgs('win32', { progressWindow: false })).toEqual([false, true]);
  });

  it('leaves macOS on the default call (Squirrel relaunches on its own)', () => {
    expect(restartInstallArgs('darwin')).toEqual([]);
    expect(restartInstallArgs('darwin', { progressWindow: true })).toEqual([]);
  });

  it('leaves Linux on the defaults', () => {
    expect(restartInstallArgs('linux')).toEqual([]);
  });
});
