/**
 * 260929 OS permission flows: the Settings URL allowlist and per-OS choice,
 * the Screen Recording probe verdict, and the one-shot relaunch resume flag.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_SETTINGS_URLS,
  RESUME_FILE,
  SETTINGS_URLS,
  assertAllowedSettingsUrl,
  clearResume,
  macMajor,
  normalizeStatus,
  parseResume,
  screenProbeSeesOtherApps,
  settingsUrlFor,
  takeResume,
  writeResume,
} from './osPermissions';
import { PERMISSION_RESUME_TTL_MS } from '../../shared/permissionsIpc';

describe('settings URL allowlist', () => {
  it('holds exactly the five briefed URLs', () => {
    expect([...ALLOWED_SETTINGS_URLS].sort()).toEqual(
      [
        'ms-settings:privacy-microphone',
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone',
        'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
      ].sort(),
    );
  });

  it('accepts every allowlisted URL', () => {
    for (const url of Object.values(SETTINGS_URLS)) expect(() => assertAllowedSettingsUrl(url)).not.toThrow();
  });

  it.each([
    'https://sei.gg',
    'ms-settings:privacy-webcam',
    'ms-settings:',
    'ms-settings:privacy-microphone ',
    'MS-SETTINGS:privacy-microphone',
    'ms-settings:privacy-microphone&x=1',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    'x-apple.systempreferences:com.apple.preference.security',
    'file:///Applications/Calculator.app',
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone#x',
    '',
  ])('rejects %j', (url) => {
    expect(() => assertAllowedSettingsUrl(url)).toThrow();
  });
});

describe('settingsUrlFor', () => {
  it('picks System Settings on macOS 13 and later', () => {
    for (const v of ['13.0.0', '14.5.0', '15.1', '26.0.1']) {
      expect(settingsUrlFor('mic', 'darwin', v)).toBe(SETTINGS_URLS.macMicModern);
      expect(settingsUrlFor('screen', 'darwin', v)).toBe(SETTINGS_URLS.macScreenModern);
    }
  });

  it('picks System Preferences before Ventura', () => {
    for (const v of ['12.7.4', '11.0', '10.15.7']) {
      expect(settingsUrlFor('mic', 'darwin', v)).toBe(SETTINGS_URLS.macMicLegacy);
      expect(settingsUrlFor('screen', 'darwin', v)).toBe(SETTINGS_URLS.macScreenLegacy);
    }
  });

  it('falls back to the modern page when the version cannot be read', () => {
    expect(settingsUrlFor('mic', 'darwin', '')).toBe(SETTINGS_URLS.macMicModern);
    expect(settingsUrlFor('screen', 'darwin', 'garbage')).toBe(SETTINGS_URLS.macScreenModern);
  });

  it('Windows has a mic page and no screen gate; Linux has neither', () => {
    expect(settingsUrlFor('mic', 'win32', '10.0.22631')).toBe(SETTINGS_URLS.winMic);
    expect(settingsUrlFor('screen', 'win32', '10.0.22631')).toBeNull();
    expect(settingsUrlFor('mic', 'linux', '6.8.0')).toBeNull();
    expect(settingsUrlFor('screen', 'linux', '6.8.0')).toBeNull();
  });

  it('every URL it can return is allowlisted', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const v of ['10.15', '12.0', '13.0', '26.0', '']) {
        for (const kind of ['mic', 'screen'] as const) {
          const url = settingsUrlFor(kind, platform, v);
          if (url) expect(ALLOWED_SETTINGS_URLS.has(url)).toBe(true);
        }
      }
    }
  });

  it('macMajor parses the leading component', () => {
    expect(macMajor('14.5.0')).toBe(14);
    expect(macMajor('26')).toBe(26);
    expect(macMajor('')).toBe(0);
  });
});

describe('normalizeStatus', () => {
  it('passes the known values and maps the rest to unknown', () => {
    for (const v of ['granted', 'denied', 'restricted', 'not-determined']) expect(normalizeStatus(v)).toBe(v);
    expect(normalizeStatus('limited')).toBe('unknown');
    expect(normalizeStatus(undefined)).toBe('unknown');
  });
});

describe('screenProbeSeesOtherApps', () => {
  it('is false with only screens and Sei windows (what macOS returns without the grant)', () => {
    expect(
      screenProbeSeesOtherApps([
        { id: 'screen:1:0', name: 'Entire Screen' },
        { id: 'window:12:0', name: 'Sei' },
        { id: 'window:13:0', name: 'Sei - Call' },
      ]),
    ).toBe(false);
    expect(screenProbeSeesOtherApps([])).toBe(false);
  });

  it('is true once any other app window is listed', () => {
    expect(
      screenProbeSeesOtherApps([
        { id: 'window:12:0', name: 'Sei' },
        { id: 'window:40:0', name: 'Minecraft 1.21.1' },
      ]),
    ).toBe(true);
    // "Seiko Watch" is not Sei.
    expect(screenProbeSeesOtherApps([{ id: 'window:41:0', name: 'Seiko Watch' }])).toBe(true);
  });
});

describe('resume flag', () => {
  let dir: string;
  const CHAR = '0f8fad5b-d9cb-469f-a165-70867728950e';

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sei-perm-resume-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips once, then is gone', () => {
    writeResume(dir, { kind: 'share-screen', characterId: CHAR }, 1_000);
    expect(takeResume(dir, 2_000)).toEqual({ kind: 'share-screen', characterId: CHAR });
    expect(takeResume(dir, 2_000)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('carries the call kind too', () => {
    writeResume(dir, { kind: 'call', characterId: CHAR }, 1_000);
    expect(takeResume(dir, 1_500)).toEqual({ kind: 'call', characterId: CHAR });
  });

  it('expires after the TTL, and the stale file is deleted', () => {
    writeResume(dir, { kind: 'share-screen', characterId: CHAR }, 1_000);
    expect(takeResume(dir, 1_000 + PERMISSION_RESUME_TTL_MS + 1)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is honored right up to the TTL', () => {
    writeResume(dir, { kind: 'share-screen', characterId: CHAR }, 1_000);
    expect(takeResume(dir, 1_000 + PERMISSION_RESUME_TTL_MS)).not.toBeNull();
  });

  it('ignores a flag stamped far in the future (clock jumped back)', () => {
    writeResume(dir, { kind: 'share-screen', characterId: CHAR }, 10_000_000);
    expect(takeResume(dir, 1_000)).toBeNull();
  });

  it('treats malformed files as no flag and deletes them', () => {
    writeFileSync(path.join(dir, RESUME_FILE), '{not json');
    expect(takeResume(dir)).toBeNull();
    writeFileSync(path.join(dir, RESUME_FILE), JSON.stringify({ resume: { kind: 'rm -rf', characterId: CHAR }, at: Date.now() }));
    expect(takeResume(dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('clearResume removes it and tolerates a missing file', () => {
    writeResume(dir, { kind: 'share-screen', characterId: CHAR });
    clearResume(dir);
    clearResume(dir);
    expect(takeResume(dir)).toBeNull();
  });

  it('parseResume rejects bad kinds and ids', () => {
    expect(parseResume({ kind: 'share-screen', characterId: CHAR })).toEqual({ kind: 'share-screen', characterId: CHAR });
    expect(parseResume({ kind: 'share-screen', characterId: '../../etc' })).toBeNull();
    expect(parseResume({ kind: 'share-screen', characterId: '' })).toBeNull();
    expect(parseResume({ kind: 'screen', characterId: CHAR })).toBeNull();
    expect(parseResume(null)).toBeNull();
    expect(parseResume('share-screen')).toBeNull();
  });
});
