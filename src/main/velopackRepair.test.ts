/**
 * The Velopack self-repair runtime on a temp folder: state file across
 * "launches", the feed (repair rule, setup manifest, rollout), the Setup
 * download with its sha256, the signature gate, and the hand-off to the
 * runner. The runner itself is PowerShell and runs in velopack-update.yml
 * (repair-* scenarios); here its spawn is mocked and reports `started`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dir: '',
  version: '0.7.0',
  installed: true,
  feed: {} as Record<string, unknown>,
  status: {} as Record<string, number>,
  setupBytes: Buffer.alloc(0) as Buffer,
  fetched: [] as string[],
  spawn: vi.fn(),
  quit: vi.fn(),
  checkSigned: vi.fn(),
  ciMark: vi.fn(),
  pidRunsImage: vi.fn((_pid: number, _image: string) => false),
  loadError: null as string | null,
  route: 'DIRECT',
  neutralExit: vi.fn(),
  normalNext: vi.fn(),
  config: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => h.version,
    getPath: (name: string) => path.join(h.dir, name),
    quit: h.quit,
  },
  nativeTheme: { shouldUseDarkColors: false },
  session: { defaultSession: { resolveProxy: async () => h.route } },
  net: {
    fetch: async (url: string) => {
      h.fetched.push(url);
      const name = url.split('/').pop()!;
      if (h.status[name]) return new Response('', { status: h.status[name] });
      if (name in h.feed) return new Response(JSON.stringify(h.feed[name]));
      if (name === 'Sei-win-Setup.exe') return new Response(new Uint8Array(h.setupBytes));
      return new Response('', { status: 404 });
    },
  },
}));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('./velopackBoot', () => ({
  ciMark: h.ciMark,
  pidRunsImage: h.pidRunsImage,
  velopackLoadError: () => h.loadError,
  userDataInstallId: () => 'install-1',
  velopackInstalled: () => h.installed,
  velopackLog: () => {},
}));
vi.mock('./bootContext', () => ({ noteNeutralExit: h.neutralExit, requestNormalStartNext: h.normalNext }));
vi.mock('./configStore', () => ({ loadConfig: async () => h.config }));
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
const { runnerConfigJson, REPAIR_RUNNER_PS1 } = await import('./velopackRepairRunner');
const { VELOPACK_REPAIR_ADDED } = await import('../shared/addedLanguageCopy');

const env = { LOCALAPPDATA: process.env.LOCALAPPDATA, SEI_VELOPACK_CI: process.env.SEI_VELOPACK_CI };
const realExecPath = process.execPath;
let root = '';
const deps = { progress: vi.fn(), failed: vi.fn(), ready: vi.fn(), released: vi.fn() };

function state(): Record<string, any> {
  return JSON.parse(readFileSync(path.join(h.dir, 'userData', REPAIR_STATE_FILE), 'utf8'));
}

/** Runs timers and waits until no repair or hand-off is in flight (the download is real I/O). */
async function settle(): Promise<void> {
  const until = Date.now() + 10_000;
  for (;;) {
    await vi.runAllTimersAsync();
    if (!repair.__test.busy() || Date.now() > until) return;
    await sleep(200); // real time: an async removal would have finished
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
  h.pidRunsImage.mockReset().mockReturnValue(false);
  h.neutralExit.mockReset();
  h.normalNext.mockReset();
  h.loadError = null;
  h.route = 'DIRECT';
  h.config = {};
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

  it('a layout Velopack no longer recognises counts per launch, but is not decisive', () => {
    h.installed = false;
    h.loadError = 'UpdateManager: boom';
    launch();
    expect(state()).toMatchObject({ streak: 1, lastFailure: { kind: 'not-installed' } });
    expect(repair.repairHoldsUpdates()).toBe(false);
    launch();
    launch();
    expect(repair.repairHoldsUpdates()).toBe(true);
  });

  it('never counts a failure on the network path', async () => {
    h.feed['releases.win.json'] = { Assets: [{ Version: '0.7.1' }] };
    const probe = { url: 'http://feed/pkg.nupkg' };
    launch();
    await repair.noteUpdaterFailure('download', { detail: 'error sending request: operation timed out', probe });
    await repair.noteUpdaterFailure('check', { detail: 'IO error', probe, viaGithub: true });
    h.route = 'PROXY corp:8080';
    await repair.noteUpdaterFailure('download', { detail: 'ENOTDIR', probe });
    expect(state().streak ?? 0).toBe(0);
    const why = h.ciMark.mock.calls.filter(([n]) => n === 'repair-signal').map(([, d]) => d.why);
    expect(why).toEqual(['network', 'github', 'proxy']);
    h.route = 'DIRECT';
    await repair.noteUpdaterFailure('download', { detail: 'IO error: (os error 183)', probe });
    expect(state().streak).toBe(1);
  });

  it('a check that finds an update or a finished download only clears what it proves', async () => {
    await failDownloads(2);
    repair.noteUpdaterHealthy('found');
    expect(state().streak).toBe(2); // the check worked, the download did not
    repair.noteUpdaterHealthy('downloaded');
    expect(state().streak).toBe(0);
    launch();
    repair.noteApplyLaunched('0.7.1');
    launch();
    repair.noteUpdaterHealthy('found');
    repair.noteUpdaterHealthy('downloaded');
    expect(state()).toMatchObject({ streak: 1, lastFailure: { kind: 'apply-no-effect' } });
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
    // the repaired copy starts normally, also when it is the same version
    expect(h.normalNext).toHaveBeenCalledTimes(1);
    expect(h.neutralExit).toHaveBeenCalledTimes(1);
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
    h.pidRunsImage.mockImplementation((pid, image) => pid === 4242 && image === 'powershell.exe');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    h.neutralExit.mockReset();
    launch();
    expect(exit).toHaveBeenCalledWith(0);
    // a hand-over, not a failed start (no safe mode, no crash report)
    expect(h.neutralExit).toHaveBeenCalledTimes(1);
    expect(h.neutralExit.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
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
    expect(h.normalNext).not.toHaveBeenCalled();
  });

  it('runner.json is pure ASCII for any user name, and the runner reads it as UTF-8', () => {
    for (const user of ['JosÃ©', 'æµ‹è¯•', 'ZoÃ« Ã˜lund']) {
      const cfg = {
        setup: `C:\\Users\\${user}\\AppData\\Local\\Temp\\sei-repair-ab12\\Sei-Setup.exe`,
        sha256: 'a'.repeat(64),
        root: `C:\\Users\\${user}\\AppData\\Local\\Sei`,
        waitPid: 1234,
      };
      const text = runnerConfigJson(cfg);
      expect(text).toMatch(/^[\x20-\x7e]*$/);
      expect(JSON.parse(text)).toEqual(cfg);
    }
    expect(REPAIR_RUNNER_PS1).toMatch(/^[\x00-\x7f]*$/);
    expect(REPAIR_RUNNER_PS1).toContain('[System.IO.File]::ReadAllText($cfgFile, [System.Text.Encoding]::UTF8)');
  });

  it('the hand-off writes runner.json as ASCII', async () => {
    rmSync(path.join(root, 'Update.exe'));
    runnerStarts();
    launch({ safeMode: true });
    await settle();
    const [, args] = h.spawn.mock.calls[0];
    const raw = readFileSync(path.join(args[args.indexOf('-Dir') + 1] as string, 'runner.json'));
    expect([...raw].every((b) => b < 0x80)).toBe(true);
  });

  it('the next launch drops a Setup downloaded for a decisive signal that went away', async () => {
    rmSync(path.join(root, 'Update.exe'));
    launch();
    await settle();
    expect(deps.ready).toHaveBeenCalledWith(expect.any(Function), '0.7.1', false);
    const dir = state().ready.dir as string;
    writeFileSync(path.join(root, 'Update.exe'), 'upd'); // an antivirus put it back
    launch();
    expect(repair.repairHoldsUpdates()).toBe(true);
    await expect(repair.handOffRepairAtLaunch()).resolves.toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ streak: 0 });
    expect(state().ready).toBeUndefined();
    expect(repair.repairHoldsUpdates()).toBe(false);
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
  });

  it('the launch hand-off reads the kill switch of the channel the decision used', async () => {
    runnerStarts();
    await failDownloads(FAILURE_THRESHOLD);
    await settle();
    expect(state().ready.ruleChannel).toBe('win');
    // switched off on that channel since, while the settings now say beta
    h.feed['repair.win.json'] = { percent: 0, epoch: 0 };
    h.config = { advanced_updates: true };
    launch();
    await expect(repair.handOffRepairAtLaunch()).resolves.toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(state().reports.at(-1)).toMatchObject({ phase: 'held', reason: 'disabled' });
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
    await vi.waitFor(() => expect(deps.failed).toHaveBeenCalledWith("Sei couldn't repair its updater this time. It will try again later."));
  });

  it('the failure notice follows the UI language', async () => {
    h.config = { ui_language: 'ja' };
    h.checkSigned.mockResolvedValue({ ok: false, reason: 'NotSigned' });
    rmSync(path.join(root, 'Update.exe'));
    launch({ safeMode: true });
    await settle();
    await vi.waitFor(() => expect(deps.failed).toHaveBeenCalledWith(VELOPACK_REPAIR_ADDED.ja.failed));
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
    // a runner that starts late must still find its cancel file
    const [, args] = h.spawn.mock.calls[0];
    const dir = args[args.indexOf('-Dir') + 1] as string;
    await sleep(200); // real time: an async removal would have finished
    expect(existsSync(path.join(dir, 'cancel'))).toBe(true);
    expect(existsSync(path.join(dir, 'runner.json'))).toBe(true);
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

  it('a refused repair does not hold the next startup check, and a released hold reruns a skipped check', async () => {
    h.feed['repair.win.json'] = { percent: 0, epoch: 0 };
    rmSync(path.join(root, 'Update.exe'));
    launch();
    expect(repair.repairHoldsUpdates()).toBe(true); // nothing refused it yet
    repair.noteCheckHeld();
    await settle();
    expect(deps.released).toHaveBeenCalledTimes(1);
    launch();
    expect(repair.repairHoldsUpdates()).toBe(false); // refused in this epoch: the check goes ahead
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

describe('leftover folders', () => {
  it('removes sei-repair-<hex> folders older than a day, and nothing else', async () => {
    const tmp = path.join(h.dir, 'temp');
    const make = (name: string, ageMs: number) => {
      const d = path.join(tmp, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, 'x'), 'x');
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(d, t, t);
      return d;
    };
    const day = 24 * 60 * 60 * 1000;
    const old = make('sei-repair-0a1b2c3d', 2 * day);
    const fresh = make('sei-repair-11223344', 60_000);
    const otherName = make('sei-repair-notes', 2 * day);
    const unrelated = make('something-else', 2 * day);
    launch();
    await settle();
    await vi.waitFor(() => expect(existsSync(old)).toBe(false));
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(otherName)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});




