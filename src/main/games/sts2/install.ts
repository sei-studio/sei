/**
 * Slay the Spire 2: install detection and the Sei mod copy (261115).
 *
 * The game is Steam-only. It sits in `<library>/steamapps/common/Slay the
 * Spire 2/`: on Windows the folder holds the .exe and `mods/`; on macOS it
 * holds `SlayTheSpire2.app`, whose mods folder is INSIDE the bundle at
 * `Contents/MacOS/mods/` (community mod docs; the game's own data folder is
 * `Contents/Resources/data_sts2_macos_arm64/`). A mod is two flat files in
 * that folder: `<id>.dll` and the `<id>.json` manifest (upstream neuro-sts2's
 * PostBuild copies exactly these two). The player turns a new mod on in the
 * game (Settings, Mods, then a consent dialog); Sei cannot do that for them.
 *
 * macOS: writes inside the bundle need the one-time App Management grant,
 * the same gate as Don't Starve Together (games/dontstarve/install.ts
 * grantAndInstall). Only the mod copy writes there; the per-session link and
 * the status heartbeats live outside the bundle (link.ts).
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { STS2_MOD_ID, type Sts2InstallInfo } from '../../../shared/sts2Ipc';
import { parseLibraryFolders, steamRootCandidates } from '../dontstarve/install';

export const STS2_INSTALL_DIR_NAME = 'Slay the Spire 2';
/** Where the built mod sits under a pack root (and in the repo, tracked like assets/stardew-mod). */
export const MOD_SOURCE_RELATIVE = path.join('assets', 'sts2-mod', STS2_MOD_ID);
export const MOD_FILES = [`${STS2_MOD_ID}.dll`, `${STS2_MOD_ID}.json`] as const;

export interface Sts2InstallDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(p: string): Promise<boolean>;
  isDir(p: string): Promise<boolean>;
  readText(p: string): Promise<string | null>;
  readBytes(p: string): Promise<Buffer | null>;
  listDir(p: string): Promise<string[]>;
  /** Copy one file, creating the folder; replaces atomically where the OS allows. */
  copyFile(from: string, to: string): Promise<void>;
  removeFile(p: string): Promise<void>;
  /** Windows only: HKCU\Software\Valve\Steam\SteamPath, or null. */
  registrySteamPath(): Promise<string | null>;
}

export function defaultInstallDeps(): Sts2InstallDeps {
  const tryStat = async (p: string) => {
    try {
      return await stat(p);
    } catch {
      return null;
    }
  };
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    exists: async (p) => (await tryStat(p)) != null,
    isDir: async (p) => (await tryStat(p))?.isDirectory() === true,
    readText: async (p) => {
      try {
        return await readFile(p, 'utf8');
      } catch {
        return null;
      }
    },
    readBytes: async (p) => {
      try {
        return await readFile(p);
      } catch {
        return null;
      }
    },
    listDir: async (p) => {
      try {
        return await readdir(p);
      } catch {
        return [];
      }
    },
    copyFile: async (from, to) => {
      await mkdir(path.dirname(to), { recursive: true });
      const tmp = `${to}.sei-tmp`;
      await copyFile(from, tmp);
      await rename(tmp, to);
    },
    removeFile: async (p) => {
      await rm(p, { force: true });
    },
    registrySteamPath: async () => {
      if (process.platform !== 'win32') return null;
      const { execFile } = await import('node:child_process');
      return new Promise((resolve) => {
        execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
          if (err) return resolve(null);
          const m = /SteamPath\s+REG_SZ\s+(.+)$/im.exec(String(stdout));
          resolve(m ? m[1].trim() : null);
        });
      });
    },
  };
}

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Every Steam library folder, the Steam roots first. Deduped, order kept. */
export async function steamLibraries(deps: Sts2InstallDeps): Promise<string[]> {
  const p = pathFor(deps.platform);
  const roots = steamRootCandidates(deps);
  const reg = deps.platform === 'win32' ? await deps.registrySteamPath().catch(() => null) : null;
  if (reg) roots.unshift(reg.replace(/\//g, '\\'));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    const key = deps.platform === 'darwin' || deps.platform === 'win32' ? dir.toLowerCase() : dir;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(dir);
    }
  };
  for (const root of roots) {
    const vdf = await deps.readText(p.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (vdf == null && !(await deps.exists(root))) continue;
    add(root);
    for (const lib of vdf ? parseLibraryFolders(vdf) : []) add(lib.path);
  }
  return out;
}

/** The game's executable inside a found install, or null. */
export async function findBinary(gameDir: string, deps: Sts2InstallDeps): Promise<{ binary: string; bundle: string | null } | null> {
  const p = pathFor(deps.platform);
  const entries = await deps.listDir(gameDir);
  if (deps.platform === 'darwin') {
    const apps = entries.filter((e) => e.toLowerCase().endsWith('.app'));
    apps.sort((a, b) => Number(/spire/i.test(b)) - Number(/spire/i.test(a)));
    for (const app of apps) {
      const macos = p.join(gameDir, app, 'Contents', 'MacOS');
      for (const name of await deps.listDir(macos)) {
        if (name === 'mods' || name.startsWith('.')) continue;
        const full = p.join(macos, name);
        if (!(await deps.isDir(full))) return { binary: full, bundle: p.join(gameDir, app) };
      }
    }
    return null;
  }
  const exes = entries.filter((e) => /\.exe$/i.test(e) && !/crash|unins|redist|setup|helper/i.test(e));
  exes.sort((a, b) => Number(/slay|sts2|spire/i.test(b)) - Number(/slay|sts2|spire/i.test(a)));
  if (deps.platform !== 'win32') {
    // Linux (dev and tests): a native build would be an extensionless binary.
    const bin = entries.find((e) => /^(SlayTheSpire2|Slay the Spire 2)(\.x86_64)?$/i.test(e));
    if (bin) return { binary: p.join(gameDir, bin), bundle: null };
  }
  return exes.length ? { binary: p.join(gameDir, exes[0]), bundle: null } : null;
}

/** Where the game reads mods from, for a found install. */
export function modsDirFor(gameDir: string, bundle: string | null, platform: NodeJS.Platform): string {
  const p = pathFor(platform);
  if (platform === 'darwin' && bundle) return p.join(bundle, 'Contents', 'MacOS', 'mods');
  return p.join(gameDir, 'mods');
}

export interface Sts2Found extends Sts2InstallInfo {
  modsDir: string;
}

export async function findSts2Install(deps: Sts2InstallDeps): Promise<{ found: Sts2Found | null; searched: string[] }> {
  const p = pathFor(deps.platform);
  const searched: string[] = [];
  for (const lib of await steamLibraries(deps)) {
    const gameDir = p.join(lib, 'steamapps', 'common', STS2_INSTALL_DIR_NAME);
    searched.push(gameDir);
    if (!(await deps.isDir(gameDir))) continue;
    const bin = await findBinary(gameDir, deps);
    if (!bin) continue;
    return {
      found: { gameDir: bin.bundle ?? gameDir, binary: bin.binary, store: 'steam', modsDir: modsDirFor(gameDir, bin.bundle, deps.platform) },
      searched,
    };
  }
  return { found: null, searched };
}

/** The manifest's version string, or null. */
export function manifestVersion(text: string | null): string | null {
  if (!text) return null;
  try {
    const v = (JSON.parse(text.replace(/^﻿/, '')) as { version?: unknown }).version;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The pack's mod folder, or null when the build is missing. */
export async function resolveModSource(packRoot: string, deps: Sts2InstallDeps): Promise<string | null> {
  const pp = pathFor(deps.platform);
  const src = pp.join(packRoot, 'assets', 'sts2-mod', STS2_MOD_ID);
  for (const f of MOD_FILES) if (!(await deps.exists(pp.join(src, f)))) return null;
  return src;
}

export interface ModStatus {
  installed: boolean;
  version: string | null;
  /** Byte-identical to the pack's build (false when there is no pack build to compare). */
  current: boolean;
}

export async function modStatus(modsDir: string, packSource: string | null, deps: Sts2InstallDeps): Promise<ModStatus> {
  const p = pathFor(deps.platform);
  const [dll, json] = await Promise.all(MOD_FILES.map((f) => deps.readBytes(p.join(modsDir, f))));
  const installed = dll != null && json != null;
  const version = manifestVersion(json ? json.toString('utf8') : null);
  if (!installed || !packSource) return { installed, version, current: false };
  const [pDll, pJson] = await Promise.all(MOD_FILES.map((f) => deps.readBytes(p.join(packSource, f))));
  const current = pDll != null && pJson != null && sha(pDll) === sha(dll) && sha(pJson) === sha(json);
  return { installed, version, current };
}

export class Sts2InstallError extends Error {
  constructor(
    readonly reason: 'mod_missing' | 'permission' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

/** Is this a macOS App Management refusal (a write inside the .app bundle)? */
export function isPermissionError(err: unknown, platform: NodeJS.Platform): boolean {
  const e = err as NodeJS.ErrnoException;
  return platform === 'darwin' && (e?.code === 'EPERM' || /operation not permitted/i.test(String(e?.message ?? err)));
}

/** Copy the two mod files in. Throws Sts2InstallError. */
export async function installMod(opts: { packRoot: string; modsDir: string }, deps: Sts2InstallDeps): Promise<void> {
  const src = await resolveModSource(opts.packRoot, deps);
  if (!src) throw new Sts2InstallError('mod_missing', `GAME_INSTALL_FAILED: The Sei mod for Slay the Spire 2 is missing from ${opts.packRoot}.`);
  const p = pathFor(deps.platform);
  try {
    // The manifest last: a half-copied mod without its manifest is not loaded.
    await deps.copyFile(p.join(src, MOD_FILES[0]), p.join(opts.modsDir, MOD_FILES[0]));
    await deps.copyFile(p.join(src, MOD_FILES[1]), p.join(opts.modsDir, MOD_FILES[1]));
  } catch (err) {
    if (isPermissionError(err, deps.platform)) {
      throw new Sts2InstallError('permission', 'GAME_INSTALL_FAILED: macOS needs your OK before Sei can add its mod to Slay the Spire 2.');
    }
    throw new Sts2InstallError('failed', `GAME_INSTALL_FAILED: ${(err as Error)?.message ?? err}`);
  }
}

/** Test seam: write helper for fake file systems (atomic write of a small JSON file). */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  await rename(tmp, file);
}
