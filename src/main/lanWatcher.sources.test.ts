/**
 * Issue #52 end to end through watchLan: netstat cannot see the world, a
 * fallback source can, and only a verified port is reported, with the source
 * recorded once per world.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./hostClient', () => ({
  cmdlineForPid: vi.fn(async () => ''),
  classifyCmdline: vi.fn(() => 'unknown'),
  hasForgeLaunchTarget: vi.fn(() => false),
}));
vi.mock('./hostSetup', () => ({ inspectHostMods: vi.fn(async () => ({ seiSkinMod: false, otherModCount: null })) }));

import type { LanState } from '../shared/ipc';
import { getLanDiagnosis } from './lanSources';
import { lanFoundProps, watchLan, type LanFoundMeta } from './lanWatcher';
import type { McStatus } from './mcPing';
import type { FallbackContext, FallbackSnapshot, WinLanFallback } from './winLanFallback';
import type { LanSource } from './lanSources';
import type { ListeningPort } from './listeningPorts';

const WORLD = 63711;
const status = (port: number): McStatus => ({ port, motd: 'New World', versionName: '26.1', protocol: 775, forgeModCount: null });
const ping = vi.fn(async (port: number) => (port === WORLD ? status(port) : Promise.reject(new Error('ECONNREFUSED'))));

function fakeFallback(snap: Partial<FallbackSnapshot>) {
  const fb = {
    candidates: vi.fn((_ctx: FallbackContext): FallbackSnapshot => ({
      lists: [],
      java: 'running' as const,
      pending: false,
      statelessFailed: false,
      brokenStateSeen: false,
      beaconActive: false,
      ...snap,
    })),
    noteFound: vi.fn((_source: LanSource) => undefined),
    idle: async () => undefined,
    stop: vi.fn(() => undefined),
  };
  const typed: WinLanFallback = fb;
  void typed;
  return fb;
}

async function firstState(opts: Parameters<typeof watchLan>[0] extends infer O ? Omit<O, 'onUpdate'> : never) {
  const states: LanState[] = [];
  const found: LanFoundMeta[] = [];
  const w = watchLan({ ...opts, onUpdate: (s) => states.push(s), onFound: (m) => found.push(m) });
  const fresh = await w.checkNow();
  w.stop();
  return { fresh, states, found };
}

const netstatRows: ListeningPort[] = [{ port: 135, pid: 1196, command: 'svchost.exe' }];

describe('watchLan with the Windows fallback', () => {
  afterEach(() => ping.mockClear());

  it('netstat misses the port; a stateless_enum hint is verified and reported', async () => {
    const fb = fakeFallback({
      brokenStateSeen: true,
      beaconActive: true,
      lists: [
        { source: 'stateless_enum', ports: [{ port: WORLD, pid: 17240, command: 'javaw.exe' }] },
        { source: 'multicast', ports: [{ port: WORLD, pid: null, command: '' }] },
      ],
    });
    const { fresh, found } = await firstState({ platform: 'win32', listPorts: async () => netstatRows, ping, fallback: fb });
    expect(fresh).toMatchObject({ kind: 'open', port: WORLD, motd: 'New World' });
    expect(fb.noteFound).toHaveBeenCalledWith('stateless_enum');
    expect(found).toHaveLength(1);
    expect(lanFoundProps(found[0])).toEqual({
      source: 'stateless_enum',
      sources: 'stateless_enum,multicast',
      java_owned: true,
      win_state0: true,
      beacon_active: true,
    });
    expect(getLanDiagnosis()).toBeNull();
  });

  it('multicast alone finds it when PowerShell is blocked', async () => {
    const fb = fakeFallback({ statelessFailed: true, beaconActive: true, lists: [{ source: 'multicast', ports: [{ port: WORLD, pid: null, command: '' }] }] });
    const { fresh, found } = await firstState({ platform: 'win32', listPorts: async () => netstatRows, ping, fallback: fb });
    expect(fresh).toMatchObject({ kind: 'open', port: WORLD });
    expect(found[0].source).toBe('multicast');
  });

  it('a healthy netstat finds the world first and the fallback is never consulted', async () => {
    const fb = fakeFallback({});
    const { fresh, found } = await firstState({
      platform: 'win32',
      listPorts: async () => [...netstatRows, { port: WORLD, pid: 17240, command: 'javaw.exe' }],
      ping,
      fallback: fb,
    });
    expect(fresh).toMatchObject({ kind: 'open', port: WORLD });
    expect(fb.candidates).not.toHaveBeenCalled();
    expect(fb.noteFound).toHaveBeenCalledWith('netstat');
    expect(found[0]).toMatchObject({ source: 'netstat', sources: ['netstat'] });
  });

  it('an unverified hint is not reported; the diagnosis says why', async () => {
    const fb = fakeFallback({ brokenStateSeen: true, lists: [{ source: 'stateless_enum', ports: [{ port: 50000, pid: 17240, command: 'javaw.exe' }] }] });
    const { fresh, found } = await firstState({ platform: 'win32', listPorts: async () => netstatRows, ping, fallback: fb });
    expect(fresh).toEqual({ kind: 'closed' });
    expect(found).toEqual([]);
    expect(getLanDiagnosis()).toEqual({ discovery: 'unverified', brokenStateSeen: true });
  });

  it('netstat failing but a fallback finding the world is open, not unavailable', async () => {
    const fb = fakeFallback({ lists: [{ source: 'multicast', ports: [{ port: WORLD, pid: null, command: '' }] }] });
    const { fresh } = await firstState({ platform: 'win32', listPorts: async () => Promise.reject(new Error('ENOENT')), ping, fallback: fb });
    expect(fresh).toMatchObject({ kind: 'open', port: WORLD });
    expect(fb.candidates).toHaveBeenCalledWith({ primaryFailed: true, primaryListenerCount: 0 });
  });

  it('macOS / Linux: no fallback, lsof source, unavailable when lsof fails', async () => {
    const ok = await firstState({ platform: 'darwin', listPorts: async () => [{ port: WORLD, pid: 1, command: 'java' }], ping });
    expect(ok.found[0].source).toBe('lsof');
    const bad = await firstState({ platform: 'darwin', listPorts: async () => Promise.reject(new Error('no lsof')), ping });
    expect(bad.fresh).toEqual({ kind: 'unavailable' });
    expect(getLanDiagnosis()?.discovery).toBe('enum_failed');
  });
});
