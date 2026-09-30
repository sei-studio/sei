/**
 * installer_first_launch (260926): the once-per-install marker and the event
 * shape. The marker is device-global and created exclusively, so the event can
 * fire at most once per userData dir, and never for an install that predates
 * this code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    runningUnderARM64Translation: false,
    getPath: () => '/Applications/Sei.app/Contents/MacOS/Sei',
    isInApplicationsFolder: () => true,
  },
}));

import {
  INSTALL_MARKER_FILE,
  PRIOR_STATE_ENTRIES,
  recordLaunch,
  noteLaunch,
  takeInstallerFirstLaunch,
  macAppLocation,
  installerFirstLaunchProps,
  type FirstLaunchEnv,
} from './firstLaunch';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sei-firstlaunch-'));
  takeInstallerFirstLaunch(); // clear any process-level state from a prior test
});
afterEach(() => {
  try { chmodSync(dir, 0o755); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('recordLaunch', () => {
  it('fresh userData: classifies fresh and writes the marker', () => {
    expect(recordLaunch(dir, '0.6.5', new Date('2026-09-26T00:00:00Z'))).toBe('fresh');
    const marker = JSON.parse(readFileSync(path.join(dir, INSTALL_MARKER_FILE), 'utf8'));
    expect(marker).toEqual({ kind: 'fresh', first_version: '0.6.5', first_launch_at: '2026-09-26T00:00:00.000Z' });
  });

  it('every later launch is seen, never fresh again', () => {
    expect(recordLaunch(dir, '0.6.5')).toBe('fresh');
    expect(recordLaunch(dir, '0.6.5')).toBe('seen');
    expect(recordLaunch(dir, '0.6.6')).toBe('seen');
  });

  it('userData dir that does not exist yet is created (fresh)', () => {
    const nested = path.join(dir, 'Sei');
    expect(recordLaunch(nested, '0.6.5')).toBe('fresh');
    expect(existsSync(path.join(nested, INSTALL_MARKER_FILE))).toBe(true);
  });

  it('Chromium-only files do not count as prior Sei state', () => {
    mkdirSync(path.join(dir, 'Local Storage'));
    writeFileSync(path.join(dir, 'Preferences'), '{}');
    mkdirSync(path.join(dir, 'logs'));
    expect(recordLaunch(dir, '0.6.5')).toBe('fresh');
  });

  it.each(PRIOR_STATE_ENTRIES)('existing install (%s present): upgrade, marker written, then seen', (entry) => {
    if (entry.endsWith('.json') || entry.endsWith('.bin')) writeFileSync(path.join(dir, entry), '{}');
    else mkdirSync(path.join(dir, entry));
    expect(recordLaunch(dir, '0.6.5')).toBe('upgrade');
    expect(existsSync(path.join(dir, INSTALL_MARKER_FILE))).toBe(true);
    expect(recordLaunch(dir, '0.6.5')).toBe('seen');
  });

  it('marker that cannot be written: unrecorded, and stays unrecorded (never fresh)', () => {
    if (process.getuid?.() === 0) return; // root ignores dir permissions
    chmodSync(dir, 0o555);
    expect(recordLaunch(dir, '0.6.5')).toBe('unrecorded');
    expect(recordLaunch(dir, '0.6.5')).toBe('unrecorded');
  });
});

describe('noteLaunch + takeInstallerFirstLaunch', () => {
  it('fresh install: true exactly once in the process', () => {
    expect(noteLaunch(dir, '0.6.5')).toBe('fresh');
    expect(takeInstallerFirstLaunch()).toBe(true);
    expect(takeInstallerFirstLaunch()).toBe(false);
  });

  it('second launch of the same install: false', () => {
    noteLaunch(dir, '0.6.5');
    takeInstallerFirstLaunch();
    expect(noteLaunch(dir, '0.6.5')).toBe('seen');
    expect(takeInstallerFirstLaunch()).toBe(false);
  });

  it('upgrade from an install that predates the marker: false', () => {
    mkdirSync(path.join(dir, 'profiles'));
    expect(noteLaunch(dir, '0.6.5')).toBe('upgrade');
    expect(takeInstallerFirstLaunch()).toBe(false);
  });
});

describe('macAppLocation', () => {
  const home = '/Users/pat';
  it.each([
    ['/Applications/Sei.app/Contents/MacOS/Sei', true, 'applications'],
    ['/Users/pat/Applications/Sei.app/Contents/MacOS/Sei', true, 'applications'],
    ['/private/var/folders/x/y/T/AppTranslocation/ABCD-1234/d/Sei.app/Contents/MacOS/Sei', false, 'translocated'],
    ['/Volumes/Sei 0.6.5-arm64/Sei.app/Contents/MacOS/Sei', false, 'volume'],
    ['/Users/pat/Downloads/Sei.app/Contents/MacOS/Sei', false, 'downloads'],
    ['/Users/pat/Desktop/Sei.app/Contents/MacOS/Sei', false, 'other'],
  ] as const)('%s → %s', (exe, inApps, expected) => {
    expect(macAppLocation(exe, home, inApps)).toBe(expected);
  });

  it('empty home never matches downloads', () => {
    expect(macAppLocation('/Downloads/Sei.app/Contents/MacOS/Sei', '', false)).toBe('other');
  });
});

describe('installerFirstLaunchProps', () => {
  const mac: FirstLaunchEnv = {
    platform: 'darwin',
    arch: 'arm64',
    osVersion: '26.0.1',
    packaged: true,
    arm64Translation: false,
    exePath: '/private/var/folders/x/AppTranslocation/1/d/Sei.app/Contents/MacOS/Sei',
    homeDir: '/Users/pat',
    inApplications: false,
  };

  it('macOS: platform facts plus location, no paths', () => {
    const props = installerFirstLaunchProps(mac);
    expect(props).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      os_version: '26.0.1',
      packaged: true,
      arm64_translation: false,
      in_applications: false,
      translocated: true,
      app_location: 'translocated',
    });
    for (const v of Object.values(props)) {
      if (typeof v === 'string') expect(v).not.toContain('/');
    }
  });

  it('macOS Intel build on Apple silicon reports the translation', () => {
    const props = installerFirstLaunchProps({ ...mac, arch: 'x64', arm64Translation: true, exePath: '/Applications/Sei.app/Contents/MacOS/Sei', inApplications: true });
    expect(props).toMatchObject({ arch: 'x64', arm64_translation: true, in_applications: true, translocated: false, app_location: 'applications' });
  });

  it('Windows: no macOS-only keys', () => {
    const props = installerFirstLaunchProps({ ...mac, platform: 'win32', arch: 'x64', osVersion: '10.0.26100', exePath: 'C:\\Users\\pat\\AppData\\Local\\Programs\\Sei\\Sei.exe' });
    expect(props).toEqual({ platform: 'win32', arch: 'x64', os_version: '10.0.26100', packaged: true, arm64_translation: false });
  });
});
