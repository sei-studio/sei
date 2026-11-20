import { describe, expect, it } from 'vitest';
import type { McInstall } from './ipc';
import { classifyFailReason, mcScanFound, setupErrorCode, setupStepProps } from './setupTelemetry';

const ALLOWED_KEYS = new Set([
  'game',
  'step',
  'outcome',
  'error_code',
  'store',
  'reason',
  'found',
  'launchers',
  'bedrock',
  'ended',
  'wait_ms',
  'version_ok',
]);

describe('setupStepProps (game_setup_step shape)', () => {
  it('keeps the minimal start shape', () => {
    expect(setupStepProps({ game: 'stardew', step: 'smapi_download', outcome: 'start', store: 'steam' })).toEqual({
      game: 'stardew',
      step: 'smapi_download',
      outcome: 'start',
      store: 'steam',
    });
  });

  it('always carries an error_code on a fail', () => {
    expect(setupStepProps({ game: 'minecraft', step: 'fabric', outcome: 'fail' })).toMatchObject({ error_code: 'UNKNOWN' });
    expect(setupStepProps({ game: 'minecraft', step: 'fabric', outcome: 'fail', error_code: 'FABRIC_INSTALL_FAILED', reason: 'network' })).toEqual({
      game: 'minecraft',
      step: 'fabric',
      outcome: 'fail',
      error_code: 'FABRIC_INSTALL_FAILED',
      reason: 'network',
    });
  });

  it('never passes free text, paths or unknown enums through', () => {
    const props = setupStepProps({
      game: 'minecraft',
      step: 'C:\\Users\\alice\\AppData' as never,
      outcome: 'fail',
      error_code: 'could not write C:\\Users\\alice\\.minecraft',
      store: '/home/alice/.minecraft',
      reason: 'alice' as never,
      found: 'everything' as never,
      launchers: ['vanilla', '/Users/alice', 'prism', 'vanilla'],
      ended: 'whenever' as never,
      wait_ms: -5,
    });
    expect(props).toEqual({
      game: 'minecraft',
      step: 'unknown',
      outcome: 'fail',
      error_code: 'UNKNOWN',
      store: 'unknown',
      launchers: 'prism,vanilla',
    });
    for (const k of Object.keys(props)) expect(ALLOWED_KEYS.has(k)).toBe(true);
    expect(JSON.stringify(props)).not.toMatch(/alice/);
  });

  it('reads the class off a "CLASS: detail" message', () => {
    expect(setupErrorCode('SMAPI_INSTALL_FAILED: could not reach C:\\x')).toBe('SMAPI_INSTALL_FAILED');
    expect(setupErrorCode('MC_SCAN_BEDROCK_ONLY')).toBe('MC_SCAN_BEDROCK_ONLY');
    expect(setupErrorCode('lowercase stuff')).toBe('UNKNOWN');
    expect(setupErrorCode(null)).toBe('UNKNOWN');
  });

  it('rounds wait_ms and keeps booleans', () => {
    expect(
      setupStepProps({ game: 'minecraft', step: 'lan_wait', outcome: 'ok', ended: 'world_open', wait_ms: 1234.6, bedrock: true, version_ok: false }),
    ).toEqual({ game: 'minecraft', step: 'lan_wait', outcome: 'ok', ended: 'world_open', wait_ms: 1235, bedrock: true, version_ok: false });
  });
});

describe('classifyFailReason', () => {
  it.each([
    ['EPERM: operation not permitted, rename', 'permission'],
    ['Access to the path is denied', 'permission'],
    ['EBUSY: resource busy or locked', 'locked'],
    ['getaddrinfo ENOTFOUND dl.sei.gg', 'network'],
    ['https://x: 503', 'network'],
    ['ENOSPC: no space left on device', 'disk_full'],
    ['stalled', 'timeout'],
    ['cancelled', 'cancelled'],
    ['StardewModdingAPI.exe was removed, likely by antivirus', 'antivirus'],
    ['Close Stardew Valley: the game is still running', 'game_running'],
    ['', 'other'],
  ])('%s -> %s', (msg, want) => {
    expect(classifyFailReason(msg)).toBe(want);
  });
});

describe('mcScanFound', () => {
  const inst = { id: 'a', kind: 'vanilla' } as McInstall;
  it('ranks java > other launcher > bedrock > launcher only > none', () => {
    const others = [{ launcher: 'prism' as const, label: 'x', mc_version: null, loader: null }];
    expect(mcScanFound([inst], { others, bedrock: true, launcherInstalled: true })).toBe('java');
    expect(mcScanFound([], { others, bedrock: true, launcherInstalled: true })).toBe('other_launcher');
    expect(mcScanFound([], { others: [], bedrock: true, launcherInstalled: true })).toBe('bedrock_only');
    expect(mcScanFound([], { others: [], bedrock: false, launcherInstalled: true })).toBe('launcher_only');
    expect(mcScanFound([], null)).toBe('none');
  });
});
