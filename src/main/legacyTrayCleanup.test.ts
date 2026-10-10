import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), setLoginItemSettings: () => {} },
}));

import { cleanupLegacyTraySettings, type LegacyTrayCleanupDeps } from './legacyTrayCleanup';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sei-legacy-tray-'));
  file = path.join(dir, 'tray-settings.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<LegacyTrayCleanupDeps> = {}): LegacyTrayCleanupDeps & {
  setLoginItemSettings: ReturnType<typeof vi.fn>;
} {
  return {
    filePath: file,
    platform: 'darwin',
    isPackaged: true,
    execPath: 'C:\\Sei\\Sei.exe',
    setLoginItemSettings: vi.fn(),
    log: () => {},
    ...over,
  } as LegacyTrayCleanupDeps & { setLoginItemSettings: ReturnType<typeof vi.fn> };
}

const optedIn = {
  enabled: true,
  open_at_login: true,
  wall_prompt_seen: true,
  login_item_registered: true,
  wall: null,
  notified_for: null,
};

describe('cleanupLegacyTraySettings', () => {
  it('does nothing when there is no file', () => {
    const d = deps();
    expect(cleanupLegacyTraySettings(d)).toBe('none');
    expect(d.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('removes the file and the mac login item Sei registered', () => {
    writeFileSync(file, JSON.stringify(optedIn));
    const d = deps();
    expect(cleanupLegacyTraySettings(d)).toBe('removed-with-login-item');
    expect(d.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false, openAsHidden: false });
    expect(existsSync(file)).toBe(false);
  });

  it('removes the Windows login item with the path and args it was registered with', () => {
    writeFileSync(file, JSON.stringify(optedIn));
    const d = deps({ platform: 'win32' });
    expect(cleanupLegacyTraySettings(d)).toBe('removed-with-login-item');
    expect(d.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      path: 'C:\\Sei\\Sei.exe',
      args: ['--hidden'],
    });
  });

  it('leaves a login item Sei did not register alone', () => {
    writeFileSync(file, JSON.stringify({ ...optedIn, open_at_login: false, login_item_registered: false }));
    const d = deps();
    expect(cleanupLegacyTraySettings(d)).toBe('removed');
    expect(d.setLoginItemSettings).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('never touches login items in dev builds', () => {
    writeFileSync(file, JSON.stringify(optedIn));
    const d = deps({ isPackaged: false });
    expect(cleanupLegacyTraySettings(d)).toBe('removed');
    expect(d.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('deletes a corrupt file without throwing', () => {
    writeFileSync(file, '{not json');
    const d = deps();
    expect(cleanupLegacyTraySettings(d)).toBe('removed');
    expect(d.setLoginItemSettings).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('keeps the file for a retry when the login item removal fails', () => {
    writeFileSync(file, JSON.stringify(optedIn));
    const d = deps({
      setLoginItemSettings: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    expect(cleanupLegacyTraySettings(d)).toBe('login-item-failed');
    expect(existsSync(file)).toBe(true);
  });
});
