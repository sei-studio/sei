import { describe, it, expect } from 'vitest';
import { isSeilinkHostLaunch, parseSeilinkHostArgs, seilinkHostArgv, SEILINK_HOST_FLAG } from './hostArgs';

describe('seilink host launch args', () => {
  it('round-trips through argv', () => {
    const argv = ['/Applications/Sei.app/Contents/MacOS/Sei', ...seilinkHostArgv({ ipc: '/tmp/sei-seilink-1.sock', userData: '/u/SeiLinkHost', test: false })];
    expect(isSeilinkHostLaunch(argv)).toBe(true);
    expect(parseSeilinkHostArgs(argv)).toEqual({ ipc: '/tmp/sei-seilink-1.sock', userData: '/u/SeiLinkHost', test: false });
  });

  it('keeps values with = and spaces, and the test switch', () => {
    const argv = ['electron', '/app', ...seilinkHostArgv({ ipc: '\\\\.\\pipe\\sei-seilink-9', userData: 'C:\\Users\\a b\\AppData\\Roaming\\Sei=x\\SeiLinkHost', test: true })];
    expect(parseSeilinkHostArgs(argv)).toEqual({ ipc: '\\\\.\\pipe\\sei-seilink-9', userData: 'C:\\Users\\a b\\AppData\\Roaming\\Sei=x\\SeiLinkHost', test: true });
  });

  it('is not a host launch without the flag, and unusable without the pipe or userData', () => {
    expect(isSeilinkHostLaunch(['Sei', '--seilink-ipc=x'])).toBe(false);
    expect(parseSeilinkHostArgs(['Sei', '--seilink-ipc=x', '--seilink-userdata=y'])).toBeNull();
    expect(parseSeilinkHostArgs(['Sei', SEILINK_HOST_FLAG, '--seilink-userdata=y'])).toBeNull();
    expect(parseSeilinkHostArgs(['Sei', SEILINK_HOST_FLAG, '--seilink-ipc=x'])).toBeNull();
  });
});
