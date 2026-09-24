import { describe, expect, it } from 'vitest';
import {
  findRemoteDebuggingSwitches,
  isStableVersion,
  remoteDebuggingVerdict,
  switchName,
} from './remoteDebugPolicy';

const EXE = '/Applications/Sei.app/Contents/MacOS/Sei';
const CDP = [EXE, '--remote-debugging-port=9335'];

function verdict(argv: string[], isPackaged: boolean, version: string, platform: NodeJS.Platform = 'darwin') {
  return remoteDebuggingVerdict({ argv, isPackaged, version, platform });
}

describe('remoteDebuggingVerdict', () => {
  it('blocks a packaged stable build launched with --remote-debugging-port', () => {
    expect(verdict(CDP, true, '0.6.5')).toEqual({ block: true, found: ['remote-debugging-port'] });
  });

  it('allows a packaged beta build (installed-app CDP testing)', () => {
    expect(verdict(CDP, true, '0.6.5-beta.3')).toEqual({ block: false, found: ['remote-debugging-port'] });
  });

  it('allows dev (unpackaged) regardless of version', () => {
    expect(verdict(CDP, false, '0.6.5').block).toBe(false);
    expect(verdict(CDP, false, '0.6.5-beta.3').block).toBe(false);
  });

  it('allows a packaged stable build with unrelated flags', () => {
    const argv = [EXE, '--enable-logging', '--lang=en', '-psn_0_12345', '/Users/me/world.sei', 'sei://auth'];
    expect(verdict(argv, true, '0.6.5')).toEqual({ block: false, found: [] });
  });

  it('blocks every debugging switch family on stable', () => {
    for (const arg of [
      '--remote-debugging-pipe',
      '--remote-debugging-address=0.0.0.0',
      '--remote-debugging-io-pipes=3,4',
      '--inspect',
      '--inspect=9229',
      '--inspect-brk',
      '--inspect-port=0',
      '--js-flags=--allow-natives-syntax',
      '--debug-port=9229',
    ]) {
      expect(verdict([EXE, arg], true, '1.0.0').block, arg).toBe(true);
    }
  });

  it('catches single-dash and mixed-case spellings Chromium accepts', () => {
    expect(verdict([EXE, '-remote-debugging-port=1'], true, '1.0.0').block).toBe(true);
    expect(verdict([EXE, '--Remote-Debugging-Port=1'], true, '1.0.0').block).toBe(true);
  });

  it('treats /switch as a switch only on Windows', () => {
    const argv = ['C:\\Sei\\Sei.exe', '/remote-debugging-port=1'];
    expect(verdict(argv, true, '1.0.0', 'win32').block).toBe(true);
    expect(verdict(argv, true, '1.0.0', 'darwin').block).toBe(false);
  });

  it('ignores argv[0] (the executable path)', () => {
    expect(verdict(['--remote-debugging-port=1'], true, '1.0.0').block).toBe(false);
  });

  it('uses the Chromium command-line probe even when argv looks clean', () => {
    const v = remoteDebuggingVerdict({
      argv: [EXE],
      isPackaged: true,
      version: '1.0.0',
      platform: 'darwin',
      hasSwitch: (n) => n === 'remote-debugging-pipe',
    });
    expect(v).toEqual({ block: true, found: ['remote-debugging-pipe'] });
  });

  it('a throwing probe does not hide an argv hit', () => {
    const v = remoteDebuggingVerdict({
      argv: CDP,
      isPackaged: true,
      version: '1.0.0',
      platform: 'darwin',
      hasSwitch: () => {
        throw new Error('boom');
      },
    });
    expect(v.block).toBe(true);
  });
});

describe('helpers', () => {
  it('isStableVersion', () => {
    expect(isStableVersion('0.6.5')).toBe(true);
    expect(isStableVersion('0.6.5-beta.3')).toBe(false);
    expect(isStableVersion('1.0.0-rc.1')).toBe(false);
  });

  it('switchName strips prefix and value', () => {
    expect(switchName('--remote-debugging-port=9', 'darwin')).toBe('remote-debugging-port');
    expect(switchName('plain', 'darwin')).toBeNull();
    expect(switchName('--', 'darwin')).toBeNull();
  });

  it('dedupes argv and probe hits', () => {
    expect(findRemoteDebuggingSwitches(CDP, 'darwin', (n) => n === 'remote-debugging-port')).toEqual([
      'remote-debugging-port',
    ]);
  });
});
