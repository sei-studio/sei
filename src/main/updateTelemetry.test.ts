import { describe, expect, it } from 'vitest';
import { FailureDedupe, classifyUpdateError, durationMs, installOutcome, toMb, updaterKind } from './updateTelemetry';

describe('updaterKind', () => {
  it('names each update path', () => {
    expect(updaterKind('win32', false)).toBe('nsis');
    expect(updaterKind('win32', true)).toBe('velopack');
    expect(updaterKind('darwin', false)).toBe('squirrel_mac');
    expect(updaterKind('linux', false)).toBe('appimage');
    expect(updaterKind('freebsd', false)).toBe('other');
  });
});

describe('classifyUpdateError', () => {
  it.each([
    ['net::ERR_INTERNET_DISCONNECTED', 'offline'],
    ['getaddrinfo ENOTFOUND dl.sei.gg', 'offline'],
    ['connect ETIMEDOUT 1.2.3.4:443', 'timeout'],
    ['HttpError: 404 Not Found', 'http_4xx'],
    ['Cannot download "https://x/y.zip", status 503: Service Unavailable', 'http_5xx'],
    ['sha512 checksum mismatch, expected abc', 'checksum'],
    ['Could not get code signature for running application', 'signature'],
    ['update 0.7.2 failed its signature check (publisher mismatch)', 'signature'],
    ['ENOSPC: no space left on device, write', 'disk'],
    ['EPERM: operation not permitted, rename', 'permission'],
    ['something odd happened', 'other'],
  ])('%s -> %s', (msg, cls) => {
    expect(classifyUpdateError(msg)).toBe(cls);
  });

  it('never echoes the message back', () => {
    const cls = classifyUpdateError('C:\\Users\\someone\\AppData\\Local\\Sei failed');
    expect(cls).toBe('other');
  });
});

describe('FailureDedupe', () => {
  it('lets one failure per stage and class through', () => {
    const d = new FailureDedupe();
    expect(d.first('check', 'offline')).toBe(true);
    expect(d.first('check', 'offline')).toBe(false);
    expect(d.first('download', 'offline')).toBe(true);
    expect(d.first('check', 'http_5xx')).toBe(true);
  });
});

describe('toMb / durationMs', () => {
  it('rounds to one decimal and drops unknown sizes', () => {
    expect(toMb(36_412_345)).toBe(36.4);
    expect(toMb(0)).toBeUndefined();
    expect(toMb(null)).toBeUndefined();
    expect(toMb(Number.NaN)).toBeUndefined();
  });
  it('drops durations that cannot be right', () => {
    expect(durationMs(1_000, 3_500)).toBe(2_500);
    expect(durationMs(5_000, 1_000)).toBeUndefined();
    expect(durationMs(undefined, 1_000)).toBeUndefined();
    expect(durationMs(0, 2 * 24 * 3600 * 1000)).toBeUndefined();
  });
});

describe('installOutcome', () => {
  const t = { startedAt: 10_000, fromVersion: '0.7.1' };
  it('times a launch on the new version', () => {
    expect(installOutcome(t, '0.7.2', 13_480)).toEqual({ kind: 'installed', ms: 3_480 });
  });
  it('flags a relaunch on the same version as no effect', () => {
    expect(installOutcome(t, '0.7.1', 20_000)).toEqual({ kind: 'no_effect' });
  });
  it('ignores old or impossible records', () => {
    expect(installOutcome(t, '0.7.2', 10_000 + 31 * 60_000)).toBeNull();
    expect(installOutcome(t, '0.7.1', 10_000 + 31 * 60_000)).toBeNull();
    expect(installOutcome(t, '0.7.2', 9_000)).toBeNull();
    expect(installOutcome(null, '0.7.2', 20_000)).toBeNull();
  });
});
