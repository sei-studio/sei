/**
 * The Velopack self-repair runtime on a temp folder: state file across
 * "launches", the feed (repair rule, setup manifest, rollout), the Setup
 * download with its sha256, the signature gate, and the hand-off to the
 * runner. The runner itself is PowerShell and runs in velopack-update.yml
 * (repair-* scenarios); here its spawn is mocked and reports `started`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dir: '',
  version: '0.7.0',
  installed: true,
  feed: {} as Record<string, unknown>,
  status: {} as Record<string, number>,
  setupBytes: Buffer.alloc(0),
  fetched: [] as string[],
  spawn: vi.fn(),
  quit: vi.fn(),
  checkSigned: vi.fn(),
  ciMark: vi.fn(),
  pidAlive: vi.fn(() => false),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => h.version,
    getPath: (name: string) => path.join(h.dir, name),
    quit: h.quit,
  },
  nativeTheme: { shouldUseDarkColors: false },
  net: {
    fetch: async (url: string) => {
      h.fetched.push(url);
      const name = url.split('/').pop()!;
      if (h.status[name]) return new Response('', { status: h.status[name] });
      if (name in h.feed) return new Response(JSON.stringify(h.feed[name]));
      if (name === 'Sei-win-Setup.exe') return new Response(h.setupBytes);
      return new Response('', { status: 404 });
    },
  },
}));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('./velopackBoot', () => ({
  ciMark: h.ciMark,
  pidAlive: h.pidAlive,
  userDataInstallId: () => 'install-1',
  velopackInstalled: () => h.installed,
  velopackLog: () => {},
}));
vi.mock('./bootContext', () => ({ noteNeutralExit: () => {} }));
vi.mock('./configStore', () => ({ loadConfig: async () => ({}) }));
vi.mock('./velopackVerify', () => ({ checkSigned: h.checkSigned }));
vi.mock('./winPowerShell', () => ({ powerShellExe: () => 'powershell.exe', powerShellEnv: (e: NodeJS.ProcessEnv) => e }));
vi.mock('./updateProgressHelper', () => ({
  buildHelperConfig: () => ({}),
  launchUpdateProgressHelper: async () => ({ ready: false, reason: 'test', dir: '', kill: () => {} }),
}));
// The real layout helpers build Windows paths; this host needs its own separators.
vi.mock('./velopackFastApply', async (importOriginal) => {
  const real = await importOriginal<typeof import('./velopackFastApply')>();
  return { ...real, velopackPathsFor: (exe: string) => real.velopackPathsFor(exe, path) };
});
vi.mock('./velopackMigrationPolicy', async (importOriginal) => {
  const real = await importOriginal<typeof import('./velopackMigrationPolicy')>();
  return { ...real, velopackRootFor: (local: string) => path.join(local, 'Sei') };
});

const repair = await import('./velopackRepair');
const { REPAIR_STATE_FILE, FAILURE_THRESHOLD, MAX_REPAIR_ATTEMPTS, repairBucket } = await import('./velopackRepairPolicy');
const { rolloutBucket } = await import('./velopackFastApply');

const env = { LOCALAPPDATA: process.env.LOCALAPPDATA, SEI_VELOPACK_CI: process.env.SEI_VELOPACK_CI };
const realExecPath = process.execPath;
let root = '';
const deps = { progress: vi.fn(), failed: vi.fn(), ready: vi.fn() };

function state(): Record<string, any> {
  return JSON.parse(readFileSync(path.join(h.dir, 'userData', REPAIR_STATE_FILE), 'utf8'));
}

/** Runs timers and waits until no repair or hand-off is in flight (the download is real I/O). */
async function settle(): Promise<void> {
  const until = Date.now() + 10_000;
  for (;;) {
    await vi.runAllTimersAsync();
    if (!repair.__test.busy() || Date.now() > until) return;
    await new Promise((r) => setImmediate(r));
  }
}

function launch(opts: { safeMode?: boolean } = {}): void {
  repair.__test.newLaunch();
  repair.initVelopackRepair({ safeMode: opts.safeMode ?? false });
  repair.scheduleVelopackRepair(deps);
}

function setManifest(version: string, bytes: Buffer): void {
  h.setupBytes = bytes;
  h.feed['setup.win.json'] = {
    version,
    tag: `v${version}`,
    file: 'Sei-win-Setup.exe',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

/** The runner's first stage: it writes `started` once its second stage runs. */
function runnerStarts(): void {
  h.spawn.mockImplementation((_exe: string, args: string[]) => {
    const dir = args[args.indexOf('-Dir') + 1];
    writeFileSync(path.join(dir, 'started'), '4242');
    return { once: () => {}, on: () => {}, pid: 4242 };
  });
}

/** Fails `n` launches with a download failure whose package URL answers. */
async function failDownloads(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    launch();
    await repair.noteUpdaterFailure('download', { detail: 'ENOTDIR', probe: { url: 'http://feed/pkg.nupkg' } });
  }
}

beforeEach(() => {
  h.dir = mkdtempSync(path.join(os.tmpdir(), 'sei-repair-test-'));
  root = path.join(h.dir, 'local', 'Sei');
  mkdirSync(path.join(root, 'current'), { recursive: true });
  mkdirSync(path.join(root, 'packages'), { recursive: true });
  mkdirSync(path.join(h.dir, 'temp'), { recursive: true });
  writeFileSync(path.join(root, 'current', 'sq.version'), '<package/>');
  writeFileSync(path.join(root, 'current', 'Sei.exe'), 'exe');
  writeFileSync(path.join(root, 'Update.exe'), 'upd');
  process.env.LOCALAPPDATA = path.join(h.dir, 'local');
  delete process.env.SEI_VELOPACK_CI;
  process.execPath = path.join(root, 'current', 'Sei.exe');
  h.version = '0.7.0';
  h.installed = true;
  h.feed = { 'pkg.nupkg': {} };
  h.status = {};
  h.fetched = [];
  setManifest('0.7.1', randomBytes(4096));
  h.spawn.mockReset();
  h.quit.mockReset();
  h.ciMark.mockReset();
  h.checkSigned.mockReset().mockResolvedValue({ ok: true, skipped: true });
  h.pidAlive.mockReset().mockReturnValue(false);
  for (const f of Object.values(deps)) f.mockReset();
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  repair.__test.reset();
  process.execPath = realExecPath;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(h.dir, { recursive: true, force: true });
});

describe('detection', () => {
  it('does nothing outside a Velopack layout', () => {
    process.execPath = path.join(h.dir, 'nsis', 'Sei.exe');
    launch();
    expect(repair.velopackLayoutBroken()).toBe(false);
    expect(existsSync(path.join(h.dir, 'userData', REPAIR_STATE_FILE))).toBe(false);
  });

  it('a missing Update.exe is decisive: updates hold and electron-updater stays off', () => {
    rmSync(path.join(root, 'Update.exe'));
    launch();
    expect(repair.velopackLayoutBroken()).toBe(true);
    expect(repair.repairHoldsUpdates()).toBe(true);
    expect(state()).toMatchObject({ streak: 1, lastFailure: { kind: 'update-exe-missing' } });
  });

  it('a Velopack layout Velopack no longer recognises is decisive too', () => {
    h.installed = false;
    launch();
    expect(state().lastFailure.kind).toBe('not-installed');
  });

  it('counts a failure only when the feed answers, once per launch', async () => {
    launch();
    await repair.noteUpdaterFailure('check', { probe: { url: 'http://feed/releases.win.json', json: true } });
    expect(state().streak ?? 0).toBe(0); // 404: offline or a broken feed is not a broken install
    h.feed['releases.win.json'] = { Assets: [{ Version: '0.7.1' }] };
    await repair.noteUpdaterFailure('check', { probe: { url: 'http://feed/releases.win.json', json: true } });
    await repair.noteUpdaterFailure('download', { probe: { url: 'http://feed/pkg.nupkg' } });
    expect(state().streak).toBe(1);
  });

  it(`holds updates once ${FAILURE_THRESHOLD} launches failed, and a healthy check clears the streak`, async () => {
    await failDownloads(FAILURE_THRESHOLD - 1);
    expect(repair.repairHoldsUpdates()).toBe(false);
    launch();
    repair.noteUpdaterHealthy();
    expect(state().streak).toBe(0);
    await failDownloads(FAILURE_THRESHOLD);
    expect(repair.repairHoldsUpdates()).toBe(true);
  });

  it('counts an apply that did not take on the next launch', () => {
    launch();
    repair.noteApplyLaunched('0.7.1');
    launch();
    expect(state()).toMatchObject({ streak: 1, lastFailure: { kind: 'apply-no-effect', target: '0.7.1' } });
  });

  it('a normal update resets streak and attempts', async () => {
    await failDownloads(2);
    const s = state();
    writeFileSync(path.join(h.dir, 'userData', REPAIR_STATE_FILE), JSON.stringify({ ...s, attempts: 3 }));
    h.version = '0.7.1';
    launch();
    expect(state()).toMatchObject({ streak: 0, attempts: 0, lastVersion: '0.7.1' });
  });
});

describe('repair', () => {
  it('downloads, verifies and hands off to the runner (safe mode: at once)', async () => {
    rmSync(path.join(root, 'Update.exe'));
    runnerStarts();
    launch({ safeMode: true });
    await settle();
    expect(deps.progress).toHaveBeenCalled();
    expect(deps.ready).toHaveBeenCalledWith(expect.any(Function), '0.7.1', true);
    expect(h.checkSigned).toHaveBeenCalledTimes(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const [, args] = h.spawn.mock.calls[0];
    const dir = args[args.indexOf('-Dir') + 1] as string;
    const cfg = JSON.parse(readFileSync(path.join(dir, 'runner.json'), 'utf8'));
    expect(cfg).toMatchObject({ root, sha256: (h.feed['setup.win.json'] as { sha256: string }).sha256, waitPid: process.pid });
    expect(readFileSync(cfg.setup)).toEqual(h.setupBytes);
    expect(readFileSync(path.join(dir, 'sei-repair-runner.ps1'), 'utf8')).toContain('--silent --installto');
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ attempts: 1, handoff: { attempt: 1, from: '0.7.0', target: '0.7.1', mode: 'safe', dir } });
    expect(state().reports.at(-1)).toMatchObject({ phase: 'triggered', trigger: 'update-exe-missing', mode: 'safe' });
  });

  it('the next launch reads the result: repaired, with the time to recover', async () => {
    rmSync(path.join(root, 'Update.exe'));
    runnerStarts();
    launch({ safeMode: true });
    await settle();
    const dir = state().handoff.dir as string;
    writeFileSync(path.join(root, 'Update.exe'), 'upd');
    writeFileSync(path.join(dir, 'result.txt'), 'setup-exit 0\r\n');
    h.version = '0.7.1';
    launch();
    const s = state();
    expect(s.handoff).toBeUndefined();
    expect(s.streak).toBe(0);
    expect(s.reports.at(-1)).toMatchObject({ phase: 'repaired', attempt: 1, from: '0.7.0', to: '0.7.1', same_version: false });
    expect(repair.repairHoldsUpdates()).toBe(false);
    // the queue drains once
    expect(repair.takeRepairReports().map((r) => r.phase)).toEqual(['triggered', 'repaired']);
    expect(repair.takeRepairReports()).toEqual([]);
  });

  it('a launch while the runner is installing leaves', async () => {
    rmSync(path.join(root, 'Update.exe'));
    runnerStarts();
    launch({ safeMode: true });
    await settle();
    h.pidAlive.mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    launch();
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });

  it('normal mode offers the restart and does not hand off by itself', async () => {
    runnerStarts();
    await failDownloads(FAILURE_THRESHOLD);
    await settle();
    expect(deps.ready).toHaveBeenCalledWith(expect.any(Function), '0.7.1', false);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(state().ready).toMatchObject({ attempt: 1, manifest: { version: '0.7.1' } });
    // the button
    deps.ready.mock.calls[0][0]();
    await settle();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.quit).toHaveBeenCalled();
  });

  it('the next launch hands off a Setup an earlier run downloaded', async () => {
    runnerStarts();
    await failDownloads(FAILURE_THRESHOLD);
    await settle();
    expect(h.spawn).not.toHaveBeenCalled();
    repair.__test.newLaunch();
    repair.initVelopackRepair({ safeMode: false });
    expect(repair.repairHoldsUpdates()).toBe(true);
    await expect(repair.handOffRepairAtLaunch()).resolves.toBe(true);
    expect(state().handoff).toMatchObject({ mode: 'launch' });
  });

  it('a Setup that changed after its check is not run', async () => {
    runnerStarts();
    await failDownloads(FAILURE_THRESHOLD);
    await settle();
    writeFileSync(state().ready.file, 'tampered');
    launch();
    await expect(repair.handOffRepairAtLaunch()).resolves.toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(state().reports.at(-1)).toMatchObject({ phase: 'failed', stage: 'handoff', class: 'setup-changed' });
  });

  it('fails closed on a bad signature', async () => {
    h.checkSigned.mockResolvedValue({ ok: false, reason: 'NotSigned' });
    rmSync(path.join(root, 'Update.exe'));
    launch({ safeMode: true });
    await settle();
    expect(deps.ready).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(state().reports.at(-1)).toMatchObject({ phase: 'failed', stage: 'signature' });
    expect(repair.repairHoldsUpdates()).toBe(false);
  });

  it('a sha256 mismatch never gets to the signature check', async () => {
    h.feed['setup.win.json'] = { ...(h.feed['setup.win.json'] as object), sha256: 'b'.repeat(64) };
    rmSync(path.join(root, 'Update.exe'));
    launch({ safeMode: true });
    await settle();
    expect(h.checkSigned).not.toHaveBeenCalled();
    expect(state().reports.at(-1)).toMatchObject({ phase: 'failed', stage: 'download' });
  });

  it('a runner that never starts leaves Sei open', async () => {
    h.spawn.mockImplementation(() => ({ once: () => {}, on: () => {} }));
    rmSync(path.join(root, 'Update.exe'));
    launch({ safeMode: true });
    await settle();
    expect(h.quit).not.toHaveBeenCalled();
    expect(state().handoff).toBeUndefined();
    expect(state().reports.at(-1)).toMatchObject({ phase: 'failed', class: 'runner-blocked' });
  });
});

describe('guard rails', () => {
  it('the kill switch (percent 0) holds the repair and it is reported once', async () => {
    h.feed['repair.win.json'] = { percent: 0, epoch: 0 };
    rmSync(path.join(root, 'Update.exe'));
    launch();
    await settle();
    launch();
    await settle();
    expect(h.fetched.some((u) => u.endsWith('Sei-win-Setup.exe'))).toBe(false);
    expect(state().reports.filter((r: { phase: string }) => r.phase === 'held')).toEqual([{ phase: 'held', reason: 'disabled' }]);
    expect(repair.repairHoldsUpdates()).toBe(false);
  });

  it('a partial rule follows the install bucket', async () => {
    h.feed['repair.win.json'] = { percent: repairBucket('install-1'), epoch: 0 };
    rmSync(path.join(root, 'Update.exe'));
    launch();
    await settle();
    expect(state().reports.at(-1)).toMatchObject({ phase: 'held', reason: 'disabled' });
  });

  it('an unreadable rule holds it this time', async () => {
    h.status['repair.win.json'] = 503;
    rmSync(path.join(root, 'Update.exe'));
    launch();
    await settle();
    expect(state().reports.at(-1)).toMatchObject({ phase: 'held', reason: 'rule-unreachable' });
  });

  it('never installs a version the rollout holds from this install, and falls back to a remembered one', async () => {
    // A healthy launch on 0.7.0 remembered 0.7.0's Setup.
    const old = randomBytes(2048);
    setManifest('0.7.0', old);
    launch();
    await settle();
    expect(state().setups.map((x: { version: string }) => x.version)).toEqual(['0.7.0']);
    // 0.7.1 is out, at a percent that leaves this install out.
    setManifest('0.7.1', randomBytes(4096));
    h.setupBytes = old; // the only Setup the feed serves in this test is 0.7.0's
    h.feed['rollout.win.json'] = { version: '0.7.1', percent: rolloutBucket('install-1', '0.7.1') };
    rmSync(path.join(root, 'Update.exe'));
    runnerStarts();
    launch({ safeMode: true });
    await settle();
    expect(state().handoff).toMatchObject({ target: '0.7.0' });
  });

  it('never downgrades', async () => {
    h.version = '0.7.2';
    rmSync(path.join(root, 'Update.exe'));
    launch();
    await settle();
    expect(state().reports.at(-1)).toMatchObject({ phase: 'held', reason: 'no-target' });
  });

  it('only repairs the install at %LOCALAPPDATA%\\Sei', async () => {
    process.env.LOCALAPPDATA = path.join(h.dir, 'elsewhere');
    rmSync(path.join(root, 'Update.exe'));
    launch();
    await settle();
    expect(state().reports.at(-1)).toMatchObject({ phase: 'held', reason: 'unsupported-layout' });
  });

  it(`gives up after ${MAX_REPAIR_ATTEMPTS} attempts, one per process`, async () => {
    h.spawn.mockImplementation(() => ({ once: () => {}, on: () => {} })); // runner never starts
    rmSync(path.join(root, 'Update.exe'));
    for (let i = 0; i < MAX_REPAIR_ATTEMPTS + 2; i++) {
      launch({ safeMode: true });
      await settle();
    }
    const s = state();
    expect(s.attempts).toBe(MAX_REPAIR_ATTEMPTS);
    expect(h.spawn).toHaveBeenCalledTimes(MAX_REPAIR_ATTEMPTS);
    expect(s.reports.filter((r: { phase: string }) => r.phase === 'gave_up')).toEqual([{ phase: 'gave_up', attempts: MAX_REPAIR_ATTEMPTS }]);
  });
});
