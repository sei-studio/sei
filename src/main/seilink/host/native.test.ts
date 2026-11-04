import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addonAvailability, addonPath, isSupportedPlatform } from './native';

describe('seilink addon availability', () => {
  it('Linux is unsupported (the app runs without the addon)', () => {
    expect(isSupportedPlatform('linux')).toBe(false);
    expect(addonAvailability({ platform: 'linux', packaged: true, resourcesPath: '/r', appPath: '/a' })).toEqual({ ok: false, failure: 'unsupported_platform' });
  });

  it('finds the packaged addon under resources/seilink, the dev one under the app dir', () => {
    expect(addonPath({ packaged: true, resourcesPath: '/R', appPath: '/A/app.asar' })).toBe(path.join('/R', 'seilink', 'seilink.node'));
    expect(addonPath({ packaged: false, resourcesPath: '/R', appPath: '/A' })).toBe(path.join('/A', 'resources', 'seilink', 'seilink.node'));
  });

  it('reports a missing addon on a supported OS', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'seilink-native-'));
    expect(addonAvailability({ platform: 'win32', packaged: true, resourcesPath: dir, appPath: dir })).toEqual({ ok: false, failure: 'addon_missing' });
    mkdirSync(path.join(dir, 'seilink'));
    writeFileSync(path.join(dir, 'seilink', 'seilink.node'), '');
    expect(addonAvailability({ platform: 'darwin', packaged: true, resourcesPath: dir, appPath: dir })).toEqual({ ok: true, file: path.join(dir, 'seilink', 'seilink.node') });
  });
});
