import { describe, expect, it } from 'vitest';
import { findSteamExe, launchPlan, logSaysSocketFailed, watchLinkLog, type LogWatchDeps } from './launch';
import { memFs } from './testFs';

describe('launchPlan', () => {
  it('starts a standalone binary with the link flag', () => {
    const plan = launchPlan({ binary: 'C:\\Program Files\\Factorio\\bin\\x64\\factorio.exe', root: 'C:\\Program Files\\Factorio', store: 'standalone' }, 34990, 'win32', null);
    expect(plan).toEqual({ cmd: 'C:\\Program Files\\Factorio\\bin\\x64\\factorio.exe', args: ['--enable-lua-udp', '34990'], cwd: 'C:\\Program Files\\Factorio\\bin\\x64', via: 'standalone' });
  });

  it('goes through steam.exe -applaunch on Windows Steam', () => {
    const plan = launchPlan({ binary: 'D:\\S\\steamapps\\common\\Factorio\\bin\\x64\\factorio.exe', root: 'D:\\S\\steamapps\\common\\Factorio', store: 'steam' }, 34991, 'win32', 'C:\\Steam\\steam.exe');
    expect(plan.cmd).toBe('C:\\Steam\\steam.exe');
    expect(plan.args).toEqual(['-applaunch', '427520', '--enable-lua-udp', '34991']);
  });

  it('runs the inner binary with SteamAppId on macOS Steam', () => {
    const bin = '/Users/you/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio';
    const plan = launchPlan({ binary: bin, root: '', store: 'steam' }, 34990, 'darwin', null);
    expect(plan.cmd).toBe(bin);
    expect(plan.args).toEqual(['--enable-lua-udp', '34990']);
    expect(plan.env).toEqual({ SteamAppId: '427520', SteamGameId: '427520' });
  });

  it('never uses the game port', () => {
    for (const via of ['standalone', 'steam'] as const) {
      const plan = launchPlan({ binary: '/x/factorio', root: '/x', store: via }, 34990, 'darwin', null);
      expect(plan.args).not.toContain('34197');
    }
  });
});

describe('findSteamExe', () => {
  it('prefers the registry, normalising its forward slashes', async () => {
    const { deps } = memFs('win32', { 'C:\\Program Files (x86)\\Steam\\steam.exe': 'x' }, { registry: { SteamExe: 'c:/program files (x86)/steam/steam.exe' } });
    // memFs paths are case-sensitive; the registry spelling differs, so the default folder wins here.
    expect(await findSteamExe(deps)).toBe('C:\\Program Files (x86)\\Steam\\steam.exe');
    const exact = memFs('win32', { 'E:\\Steam\\steam.exe': 'x' }, { registry: { SteamExe: 'E:/Steam/steam.exe' } });
    expect(await findSteamExe(exact.deps)).toBe('E:\\Steam\\steam.exe');
    expect(await findSteamExe(memFs('win32', {}).deps)).toBeNull();
  });
});

describe('the link log watch', () => {
  it('matches Factorio socket failure line', () => {
    expect(logSaysSocketFailed('  12.3 Error ... Opening Lua UDP Socket failed: bind failed')).toBe(true);
    expect(logSaysSocketFailed('  0.5 Info Lua UDP socket opened on 34990')).toBe(false);
    expect(logSaysSocketFailed(null)).toBe(false);
  });

  function fakeClock(files: { text: string | null; mtime: number | null }): LogWatchDeps & { tick(): Promise<void>; pending: number } {
    let now = 1000;
    let queue: Array<() => void> = [];
    const d = {
      readText: async () => files.text,
      mtime: async () => files.mtime,
      setTimer: (fn: () => void, ms: number) => {
        queue.push(() => {
          now += ms;
          fn();
        });
        return queue.length;
      },
      clearTimer: () => {
        queue = [];
      },
      now: () => now,
      async tick() {
        const q = queue;
        queue = [];
        for (const f of q) f();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
      },
      get pending() {
        return queue.length;
      },
    };
    return d;
  }

  it('fires once on this start\'s failure, ignores an older log, and stops after the timeout', async () => {
    const files = { text: 'Opening Lua UDP Socket failed', mtime: 0 as number | null };
    const clock = fakeClock(files);
    let failures = 0;
    watchLinkLog('/log', { since: 10_000, onFailure: () => failures++, timeoutMs: 10_000, intervalMs: 2000 }, clock);
    await clock.tick(); // the previous start's log (mtime 0): ignored
    expect(failures).toBe(0);
    files.mtime = 12_000;
    await clock.tick();
    expect(failures).toBe(1);
    expect(clock.pending).toBe(0);

    const quiet = fakeClock({ text: 'all good', mtime: 5000 });
    watchLinkLog('/log', { since: 1000, onFailure: () => failures++, timeoutMs: 5000, intervalMs: 2000 }, quiet);
    for (let i = 0; i < 6; i++) await quiet.tick();
    expect(quiet.pending).toBe(0);
    expect(failures).toBe(1);
  });
});
