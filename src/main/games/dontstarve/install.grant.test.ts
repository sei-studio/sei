/**
 * macOS one-click DST helper install (260925): the decision logic of
 * installMod's grant path, over an in-memory disk that refuses writes inside
 * the game bundle until the Open panel grants the mods folder (the measured
 * com.apple.macl behavior), and a fake Finder that is exempt from the gate.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { installMod, rewriteModSettings, type InstallDeps, type MacGrant } from './install';

const ROOT = '/Users/me/Library/Application Support/Steam';
const INSTALL = path.join(ROOT, 'steamapps', 'common', "Don't Starve Together");
const APP = path.join(INSTALL, 'dontstarve_steam.app');
const MODS = path.join(APP, 'Contents', 'mods');
const PACK_MOD = '/pack/assets/dst-mod/sei';
const STAGE = '/tmp/sei-dst-1';
/** Two wrong folders: the second showing ends the panel route. */
const WRONG_TWICE = ['/Users/me/Desktop', '/Users/me/Downloads'];
const VDF = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${ROOT}"\n\t\t"apps"\n\t\t{\n\t\t\t"322330"\t\t"1"\n\t\t}\n\t}\n}\n`;
const SHIPPED_SETTINGS = '--ForceEnableMod("kioskmode_dst")\n';

interface Disk {
  files: Map<string, string>;
  modes: Map<string, number>;
  /** The Open panel grant: writes under MODS are EPERM until true. */
  granted: boolean;
}

const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + path.sep);

function eperm(p: string): Error {
  return Object.assign(new Error(`EPERM: operation not permitted, open '${p}'`), { code: 'EPERM' });
}

function makeDisk(opts: { platform?: NodeJS.Platform; installed?: string | null; settings?: string | null; packVersion?: string } = {}) {
  const disk: Disk = { files: new Map(), modes: new Map(), granted: false };
  const put = (p: string, text: string, mode = 0o644): void => {
    disk.files.set(p, text);
    disk.modes.set(p, mode);
  };
  put(path.join(ROOT, 'steamapps', 'libraryfolders.vdf'), VDF);
  put(path.join(PACK_MOD, 'modinfo.lua'), `name = "Sei"\nversion = "${opts.packVersion ?? '0.3.0'}"\n`);
  put(path.join(PACK_MOD, 'modmain.lua'), '-- main\n');
  put(path.join(PACK_MOD, 'scripts', 'tool.sh'), '#!/bin/sh\n', 0o755);
  if (opts.installed !== null && opts.installed !== undefined) {
    put(path.join(MODS, 'sei', 'modinfo.lua'), `name = "Sei"\nversion = "${opts.installed}"\n`);
    put(path.join(MODS, 'sei', 'stale.lua'), '-- dropped in the new version\n');
  }
  if (opts.settings !== null) put(path.join(MODS, 'modsettings.lua'), opts.settings ?? SHIPPED_SETTINGS);

  const guard = (p: string): void => {
    if (under(p, MODS) && !disk.granted) throw eperm(p);
  };
  const listUnder = (dir: string): string[] => [...disk.files.keys()].filter((p) => under(p, dir) && p !== dir);
  const copyTree = (from: string, to: string, fixMode?: number): void => {
    for (const p of listUnder(from)) {
      const dest = path.join(to, path.relative(from, p));
      disk.files.set(dest, disk.files.get(p)!);
      disk.modes.set(dest, fixMode ?? disk.modes.get(p) ?? 0o644);
    }
  };
  const platform = opts.platform ?? 'darwin';
  const deps: InstallDeps = {
    platform,
    home: '/Users/me',
    env: {},
    exists: async (p) => disk.files.has(p) || listUnder(p).length > 0 || p === INSTALL,
    readText: async (p) => disk.files.get(p) ?? null,
    writeText: async (p, text) => {
      guard(p);
      put(p, text);
    },
    copyDir: async (from, to) => {
      guard(to);
      copyTree(from, to);
    },
    removeDir: async (p) => {
      guard(p);
      for (const f of listUnder(p)) {
        disk.files.delete(f);
        disk.modes.delete(f);
      }
    },
    listDir: async () => [],
    registrySteamPath: async () => null,
    mtime: async (p) => (disk.files.has(p) ? 1000 : null),
    gameProcess: async () => ({ running: false, startedAt: null }),
  };
  return { disk, deps, copyTree, listUnder };
}

interface FakeGrantOpts {
  /** One answer per panel showing: a path, or null for cancel. */
  picks: (string | null)[];
  /** Does picking an accepted folder actually grant it? (default true) */
  pickGrants?: boolean;
  finderFails?: boolean;
  /** Finder "succeeds" but nothing lands. */
  finderNoop?: boolean;
}

function fakeGrant(d: ReturnType<typeof makeDisk>, o: FakeGrantOpts) {
  const calls = { picks: [] as { defaultPath: string; hint: boolean }[], finder: [] as { sources: string[]; dest: string }[], chmod: [] as string[] };
  const picks = [...o.picks];
  const grant: MacGrant = {
    async pickFolder(opts) {
      calls.picks.push(opts);
      const answer = picks.shift() ?? null;
      const bare = answer?.replace(/\/+$/, '');
      if (bare != null && (bare === MODS || bare === APP) && o.pickGrants !== false) d.disk.granted = true;
      return answer;
    },
    async finderDuplicate(sources, dest) {
      calls.finder.push({ sources, dest });
      if (o.finderFails) throw new Error('Finder copy failed: Not authorized to send Apple events to Finder. (-1743)');
      if (o.finderNoop) return;
      for (const src of sources) {
        const target = path.join(dest, path.basename(src));
        if (d.disk.files.has(src)) {
          d.disk.files.set(target, d.disk.files.get(src)!);
          d.disk.modes.set(target, 0o644);
        } else {
          // Replacing a folder replaces it whole.
          for (const f of d.listUnder(target)) d.disk.files.delete(f);
          d.copyTree(src, target, 0o644);
        }
      }
    },
    realpath: async (p) => p.replace(/\/+$/, ''),
    makeTempDir: async () => STAGE,
    fileModes: async (dir) => d.listUnder(dir).map((p) => ({ rel: path.relative(dir, p), mode: d.disk.modes.get(p) ?? 0o644 })),
    chmod: async (p, mode) => {
      calls.chmod.push(p);
      if (under(p, MODS) && !d.disk.granted) throw eperm(p);
      d.disk.modes.set(p, mode);
    },
  };
  return { grant, calls };
}

const settingsOk = (d: ReturnType<typeof makeDisk>): boolean => {
  const s = d.disk.files.get(path.join(MODS, 'modsettings.lua'));
  return s != null && rewriteModSettings(s) === s;
};

describe('installMod on macOS without a grant (260925)', () => {
  it('writes straight away when the folder is already granted: no panel, no Finder', async () => {
    const d = makeDisk();
    d.disk.granted = true;
    const { grant, calls } = fakeGrant(d, { picks: [] });
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(s).toMatchObject({ kind: 'found', modInstalled: true, modVersion: '0.3.0', enabled: true });
    expect(calls.picks).toHaveLength(0);
    expect(calls.finder).toHaveLength(0);
  });

  it('EPERM shows the Open panel on the mods folder; picking it grants and the retry installs', async () => {
    const d = makeDisk();
    const { grant, calls } = fakeGrant(d, { picks: [MODS] });
    const steps: string[] = [];
    const s = await installMod({ packRoot: '/pack', grant, onProgress: (x) => steps.push(x) }, d.deps);
    expect(s).toMatchObject({ kind: 'found', modInstalled: true, enabled: true });
    expect(calls.picks).toEqual([{ defaultPath: MODS, hint: false }]);
    expect(calls.finder).toHaveLength(0);
    expect(steps).toEqual(['copying', 'asking', 'copying', 'enabling']);
    expect(d.disk.modes.get(path.join(MODS, 'sei', 'scripts', 'tool.sh'))).toBe(0o755);
    expect(settingsOk(d)).toBe(true);
    expect(d.disk.files.get(path.join(MODS, 'modsettings.lua'))).toContain('--ForceEnableMod("kioskmode_dst")');
  });

  it('accepts the .app bundle itself (it grants the whole bundle)', async () => {
    const d = makeDisk();
    const { grant, calls } = fakeGrant(d, { picks: [APP + '/'] });
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(s).toMatchObject({ kind: 'found', modInstalled: true, enabled: true });
    expect(calls.picks).toHaveLength(1);
    expect(calls.finder).toHaveLength(0);
  });

  it('a wrong folder re-shows the panel once with the hint, then installs', async () => {
    const d = makeDisk();
    const { grant, calls } = fakeGrant(d, { picks: [path.join(APP, 'Contents'), MODS] });
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(s).toMatchObject({ kind: 'found', modInstalled: true, enabled: true });
    expect(calls.picks).toEqual([
      { defaultPath: MODS, hint: false },
      { defaultPath: MODS, hint: true },
    ]);
    expect(calls.finder).toHaveLength(0);
  });

  it('a wrong folder twice goes to Finder', async () => {
    const d = makeDisk();
    const { grant, calls } = fakeGrant(d, { picks: ['/Users/me/Desktop', '/Users/me/Downloads'] });
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(calls.picks).toHaveLength(2);
    expect(calls.finder).toHaveLength(1);
    expect(s).toMatchObject({ kind: 'found', modInstalled: true, enabled: true });
  });

  it('cancel means no: the permission error, no Finder, nothing staged', async () => {
    const d = makeDisk({ installed: '0.2.0' });
    const { grant, calls } = fakeGrant(d, { picks: [null] });
    const steps: string[] = [];
    const s = await installMod({ packRoot: '/pack', grant, onProgress: (x) => steps.push(x) }, d.deps);
    expect(s).toMatchObject({ kind: 'error', error: 'GAME_INSTALL_FAILED', permission: true });
    expect(steps).toEqual(['replacing', 'asking']);
    expect(calls.picks).toHaveLength(1);
    expect(calls.finder).toHaveLength(0);
    expect(d.disk.files.get(path.join(MODS, 'sei', 'modinfo.lua'))).toContain('0.2.0');
    expect(d.listUnder(STAGE)).toEqual([]);
  });

  it('a hinted re-show that is cancelled is still a no', async () => {
    const d = makeDisk();
    const { grant, calls } = fakeGrant(d, { picks: ['/Users/me/Desktop', null] });
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(s).toMatchObject({ kind: 'error', permission: true });
    expect(calls.picks).toHaveLength(2);
    expect(calls.finder).toHaveLength(0);
  });

  it('the Finder copy: staged mod + new modsettings.lua, verified, staging removed', async () => {
    const d = makeDisk({ installed: '0.2.0' });
    const { grant, calls } = fakeGrant(d, { picks: WRONG_TWICE });
    const steps: string[] = [];
    const s = await installMod({ packRoot: '/pack', grant, onProgress: (x) => steps.push(x) }, d.deps);
    expect(s).toMatchObject({ kind: 'found', modInstalled: true, modVersion: '0.3.0', enabled: true });
    expect(steps).toEqual(['replacing', 'asking', 'asking', 'finder']);
    expect(calls.finder).toEqual([{ sources: [path.join(STAGE, 'sei'), path.join(STAGE, 'modsettings.lua')], dest: MODS }]);
    // The upgrade replaced the folder whole: the dropped script is gone.
    expect(d.disk.files.has(path.join(MODS, 'sei', 'stale.lua'))).toBe(false);
    expect(settingsOk(d)).toBe(true);
    // Finder reset the executable to 0644; the chmod was tried and refused (no grant), which is not fatal.
    expect(calls.chmod).toEqual([path.join(MODS, 'sei', 'scripts', 'tool.sh')]);
    expect(d.listUnder(STAGE)).toEqual([]);
  });

  it('Finder copies only the mod when modsettings.lua is already right', async () => {
    const d = makeDisk({ settings: rewriteModSettings(SHIPPED_SETTINGS) });
    const { grant, calls } = fakeGrant(d, { picks: WRONG_TWICE });
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(s).toMatchObject({ kind: 'found', modInstalled: true, enabled: true });
    expect(calls.finder[0].sources).toEqual([path.join(STAGE, 'sei')]);
  });

  it('an accepted folder whose retry still EPERMs goes to Finder', async () => {
    const d = makeDisk();
    const { grant, calls } = fakeGrant(d, { picks: [MODS], pickGrants: false });
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(calls.picks).toHaveLength(1);
    expect(calls.finder).toHaveLength(1);
    expect(s).toMatchObject({ kind: 'found', modInstalled: true, enabled: true });
  });

  it('both routes failing returns the permission error, with the staging cleaned up', async () => {
    const d = makeDisk();
    const { grant, calls } = fakeGrant(d, { picks: WRONG_TWICE, finderFails: true });
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(s).toMatchObject({ kind: 'error', error: 'GAME_INSTALL_FAILED', permission: true });
    expect(calls.finder).toHaveLength(1);
    expect(d.listUnder(STAGE)).toEqual([]);
  });

  it('a Finder copy that did not land is a failure, not a success', async () => {
    const d = makeDisk();
    const { grant } = fakeGrant(d, { picks: WRONG_TWICE, finderNoop: true });
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(s).toMatchObject({ kind: 'error', permission: true });
    expect(d.listUnder(STAGE)).toEqual([]);
  });

  it('a panel that throws (window gone) is not an answer: it goes to Finder', async () => {
    const d = makeDisk();
    const { grant, calls } = fakeGrant(d, { picks: [] });
    grant.pickFolder = async () => {
      throw new Error('window destroyed');
    };
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(calls.finder).toHaveLength(1);
    expect(s).toMatchObject({ kind: 'found', modInstalled: true, enabled: true });
  });

  it('a non-permission failure after the grant is reported as it is, without Finder', async () => {
    const d = makeDisk();
    const { grant, calls } = fakeGrant(d, { picks: [MODS] });
    const copy = d.deps.copyDir;
    d.deps.copyDir = async (from, to) => {
      if (d.disk.granted) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return copy(from, to);
    };
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(s).toEqual({ kind: 'error', error: 'GAME_INSTALL_FAILED', message: 'ENOSPC: no space left on device' });
    expect(calls.finder).toHaveLength(0);
  });
});

describe('installMod without a click (a game launch, 260925)', () => {
  it('never shows a dialog; a refused refresh of a current, enabled helper counts as success', async () => {
    const d = makeDisk({ installed: '0.3.0', settings: rewriteModSettings(SHIPPED_SETTINGS) });
    const s = await installMod({ packRoot: '/pack' }, d.deps);
    expect(s).toMatchObject({ kind: 'found', modInstalled: true, modVersion: '0.3.0', enabled: true });
  });

  it('returns the permission error when a newer helper or the enable line is actually needed', async () => {
    const older = makeDisk({ installed: '0.2.0', settings: rewriteModSettings(SHIPPED_SETTINGS) });
    expect(await installMod({ packRoot: '/pack' }, older.deps)).toMatchObject({ kind: 'error', permission: true });
    const reset = makeDisk({ installed: '0.3.0' });
    expect(await installMod({ packRoot: '/pack' }, reset.deps)).toMatchObject({ kind: 'error', permission: true });
    const missing = makeDisk();
    expect(await installMod({ packRoot: '/pack' }, missing.deps)).toMatchObject({ kind: 'error', permission: true });
  });
});

describe('installMod off macOS', () => {
  it('Windows EPERM is a plain error and never reaches the grant', async () => {
    const d = makeDisk({ platform: 'win32' });
    const { grant, calls } = fakeGrant(d, { picks: [MODS] });
    // findDstInstall on win32 looks elsewhere; point it at the same fixture.
    d.deps.registrySteamPath = async () => ROOT;
    d.deps.copyDir = async (_from, to) => {
      throw eperm(to);
    };
    const s = await installMod({ packRoot: '/pack', grant }, d.deps);
    expect(calls.picks).toHaveLength(0);
    expect(calls.finder).toHaveLength(0);
    expect(s).toMatchObject({ kind: 'error', error: 'GAME_INSTALL_FAILED' });
    expect(s).not.toHaveProperty('permission');
  });
});
