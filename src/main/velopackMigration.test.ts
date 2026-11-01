/**
 * The NSIS side of the Velopack migration, end to end on a temp folder: feed,
 * download, signature (skipped: unsigned build), Setup start, state file. The
 * Setup start is a mocked spawn, the rest is the real code (T293: a busy
 * Setup start is retried and re-checked, and a start that keeps failing goes
 * through the ordinary failure path).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dir: '',
  feed: {} as Record<string, unknown>,
  setupBytes: Buffer.alloc(0),
  spawn: vi.fn(),
  waitForExit: vi.fn(),
  ciMark: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '0.6.90',
    getPath: (name: string) => path.join(h.dir, name),
    whenReady: () => Promise.resolve(),
    quit: () => {},
  },
  net: {
    fetch: async (url: string) => {
      const name = url.split('/').pop()!;
      if (name in h.feed) return new Response(JSON.stringify(h.feed[name]));
      if (name === 'Sei-win-Setup.exe') return new Response(h.setupBytes);
      return new Response('', { status: 404 });
    },
  },
  shell: { readShortcutLink: () => ({ target: '' }), writeShortcutLink: () => false },
}));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('./winPowerShell', () => ({ waitForExit: h.waitForExit }));
vi.mock('./velopackBoot', () => ({
  ciMark: h.ciMark,
  pidAlive: () => false,
  userDataInstallId: () => 'install-1',
  velopackInstalled: () => false,
  velopackLog: () => {},
}));
vi.mock('./bootContext', () => ({ noteNeutralExit: () => {} }));
vi.mock('./configStore', () => ({ loadConfig: async () => ({}) }));
vi.mock('./lazyAnalytics', () => ({ loadAnalytics: async () => ({ capture: h.capture }) }));
// The real layout helpers build Windows paths; on this host the Velopack copy
// Setup "installs" has to be findable with the host's own separators.
vi.mock('./velopackMigrationPolicy', async (importOriginal) => {
  const real = await importOriginal<typeof import('./velopackMigrationPolicy')>();
  return {
    ...real,
    velopackRootFor: (local: string) => path.join(local, 'Sei'),
    velopackLaunchTarget: (root: string) => path.join(root, 'current', 'Sei.exe'),
  };
});

const { installVelopackForTest } = await import('./velopackMigration');
const { SPAWN_BUSY_DELAYS_MS } = await import('./velopackSpawnRetry');

const nsis = { dir: '', exe: '', uninstaller: '', perMachine: false };
const deps = { isUpdateReady: () => false, handOff: vi.fn() };
const env = { LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA };

function spawnError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${code}`), { code, syscall: 'spawn' });
}

function fakeChild() {
  return { pid: undefined, once: () => {}, on: () => {} };
}

/** What Setup --silent leaves behind when it works. */
function installVelopackCopy(): void {
  const root = path.join(h.dir, 'local', 'Sei');
  mkdirSync(path.join(root, 'current'), { recursive: true });
  for (const f of ['current/Sei.exe', 'current/sq.version', 'Update.exe']) writeFileSync(path.join(root, f), 'x');
}

function migrationState(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(h.dir, 'userData', 'velopack-migration.json'), 'utf8'));
}

function tempLeft(): string[] {
  return readdirSync(path.join(h.dir, 'temp')).filter((n) => n.startsWith('sei-migration-'));
}

/** Handles this process holds on `file` (Linux only; elsewhere 0). */
function openHandlesTo(file: string): number {
  if (process.platform !== 'linux') return 0;
  return readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === file;
    } catch {
      return false;
    }
  }).length;
}

function marks(name: string): Record<string, unknown>[] {
  return h.ciMark.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, unknown>);
}

/** Runs the install with fake setTimeout (retry waits, the post-Setup grace) and real I/O. */
async function runInstall(): Promise<void> {
  let settled = false;
  const p = installVelopackForTest(nsis, deps).finally(() => {
    settled = true;
  });
  for (let i = 0; !settled && i < 5000; i++) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(50);
  }
  await p;
}

beforeEach(() => {
  h.dir = mkdtempSync(path.join(os.tmpdir(), 'sei-migration-test-'));
  for (const d of ['userData', 'temp', 'local']) mkdirSync(path.join(h.dir, d));
  process.env.LOCALAPPDATA = path.join(h.dir, 'local');
  process.env.APPDATA = path.join(h.dir, 'appData');
  nsis.dir = path.join(h.dir, 'nsis');
  h.setupBytes = randomBytes(3 * 1024 * 1024 + 17);
  h.feed = {
    'migration.win.json': { percent: 100, epoch: 0 },
    'setup.win.json': {
      version: '0.6.91',
      tag: 'v0.6.91',
      file: 'Sei-win-Setup.exe',
      sha256: createHash('sha256').update(h.setupBytes).digest('hex'),
      size: h.setupBytes.length,
    },
  };
  h.spawn.mockReset();
  h.waitForExit.mockReset().mockResolvedValue({ code: 0, timedOut: false });
  h.ciMark.mockReset();
  h.capture.mockReset();
  deps.handOff.mockReset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  process.env.LOCALAPPDATA = env.LOCALAPPDATA;
  process.env.APPDATA = env.APPDATA;
  rmSync(h.dir, { recursive: true, force: true });
});

describe('installVelopack: starting Setup', () => {
  it('retries a busy Setup, then installs', async () => {
    const handlesAtFirstStart: number[] = [];
    h.spawn
      .mockImplementationOnce((file: string) => {
        // The download's own write handle is closed before Setup starts.
        handlesAtFirstStart.push(openHandlesTo(file));
        throw spawnError('EBUSY');
      })
      .mockImplementationOnce(() => {
        installVelopackCopy();
        return fakeChild();
      });
    await runInstall();

    expect(handlesAtFirstStart).toEqual([0]);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.spawn.mock.calls[1][1]).toEqual(['--silent']);
    expect(marks('migration-setup-busy')).toEqual([{ retry: 1, ms: SPAWN_BUSY_DELAYS_MS[0] }]);
    expect(marks('migration-failed')).toEqual([]);
    expect(marks('migration-installed')).toEqual([expect.objectContaining({ version: '0.6.91', spawnRetries: 1 })]);
    expect(migrationState()).toMatchObject({ phase: 'installed', attempts: 1, version: '0.6.91' });
    expect(migrationState().pid).toBeUndefined();
    expect(h.capture).toHaveBeenCalledWith('velopack_migration', expect.objectContaining({ phase: 'installed', spawn_retries: 1 }));
    expect(deps.handOff).toHaveBeenCalledTimes(1);
    expect(tempLeft()).toEqual([]);
  });

  it('fails the attempt through the normal path when Setup stays busy', async () => {
    h.spawn.mockImplementation(() => {
      throw spawnError('EBUSY');
    });
    await runInstall();

    expect(h.spawn).toHaveBeenCalledTimes(SPAWN_BUSY_DELAYS_MS.length + 1);
    expect(h.waitForExit).not.toHaveBeenCalled();
    expect(marks('migration-installing')).toHaveLength(1);
    expect(marks('migration-failed')).toEqual([
      { error: 'setup: spawn EBUSY', spawnRetries: SPAWN_BUSY_DELAYS_MS.length },
    ]);
    // Not left at 'installing' (which a later Velopack launch reads as installed).
    expect(migrationState()).toMatchObject({ phase: 'failed', attempts: 1, error: 'setup: spawn EBUSY' });
    expect(migrationState().pid).toBeUndefined();
    expect(h.capture).toHaveBeenCalledWith('velopack_migration', {
      phase: 'failed',
      attempt: 1,
      error: 'setup: spawn EBUSY',
      spawn_retries: SPAWN_BUSY_DELAYS_MS.length,
    });
    expect(deps.handOff).not.toHaveBeenCalled();
    expect(tempLeft()).toEqual([]);
  });

  it('fails at once on an error other than EBUSY', async () => {
    h.spawn.mockImplementation(() => {
      throw spawnError('EPERM');
    });
    await runInstall();

    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(marks('migration-setup-busy')).toEqual([]);
    expect(marks('migration-failed')).toEqual([{ error: 'setup: spawn EPERM', spawnRetries: 0 }]);
    expect(migrationState()).toMatchObject({ phase: 'failed', error: 'setup: spawn EPERM' });
    expect(tempLeft()).toEqual([]);
  });

  it('never starts a Setup that changed while it was busy', async () => {
    h.spawn.mockImplementation((file: string) => {
      // Whatever held it rewrote it: same size, other bytes.
      writeFileSync(file, randomBytes(h.setupBytes.length));
      throw spawnError('EBUSY');
    });
    await runInstall();

    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(marks('migration-failed')).toEqual([{ error: 'setup: setup changed after its check', spawnRetries: 1 }]);
    expect(migrationState()).toMatchObject({ phase: 'failed' });
    expect(existsSync(path.join(h.dir, 'local', 'Sei'))).toBe(false);
    expect(tempLeft()).toEqual([]);
  });
});
