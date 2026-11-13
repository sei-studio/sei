/**
 * Factorio install detection + the sei-companion mod install (261113).
 *
 * Where Factorio lives (the research facts this module is built on; the
 * Windows standalone and both macOS layouts still need a check on a real
 * install, see the package report):
 *
 *   Windows standalone  C:\Program Files\Factorio\bin\x64\factorio.exe
 *   Windows Steam       <library>\steamapps\common\Factorio\bin\x64\factorio.exe
 *   macOS standalone    /Applications/factorio.app/Contents/MacOS/factorio
 *   macOS Steam         <library>/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio
 *   Linux (best effort) <library>/steamapps/common/Factorio/bin/x64/factorio, ~/factorio/bin/x64/factorio
 *
 * The game's version is `version` in `<root>/data/base/info.json`, where
 * `<root>` is the folder holding `data/` (the install folder on Windows and
 * Linux, `factorio.app/Contents` on macOS). Only 2.1 is supported: the mod's
 * info.json says `factorio_version: "2.1"` and Factorio refuses a mod built
 * for another minor version.
 *
 * Factorio's write-data folder (mods/, mod-list.json, factorio-current.log):
 * `%APPDATA%\Factorio` on Windows, `~/Library/Application Support/factorio` on
 * macOS, `~/.factorio` on Linux, unless `<root>/config-path.cfg` says
 * `use-system-read-write-data-directories=false` (the portable zip), in which
 * case it is `<root>` itself.
 *
 * The mod: Factorio loads a mod from `mods/<name>_<version>/` (or a zip of
 * the same name), so the pack's `sei-companion` folder is copied in as
 * `sei-companion_<version>` and every other `sei-companion_*` copy is removed
 * (two versions side by side is a load error). Then `mods/mod-list.json`
 * gets `{name: "sei-companion", enabled: true}`, every other entry kept.
 * Nothing is written while Factorio runs: it reads the mods folder once at
 * start and writes mod-list.json back when it quits, which would undo the
 * enable.
 *
 * Everything that touches the disk or the OS goes through `deps`, so the
 * tests run against an in-memory fixture.
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  FACTORIO_MOD_NAME,
  FACTORIO_STEAM_APP_ID,
  FACTORIO_SUPPORTED_VERSION,
  type FactorioInstallInfo,
  type FactorioSetupState,
  type FactorioStore,
} from '../../../shared/factorioIpc';
import { parseLibraryFolders, steamRootCandidates } from '../dontstarve/install';
import { packModIsNewer, parseModVersion } from '../modVersion';
import { isFactorioRunning } from './process';

export const FACTORIO_STEAM_DIR = 'Factorio';

export interface FactorioInstallDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(p: string): Promise<boolean>;
  readText(p: string): Promise<string | null>;
  /** Write a file atomically (temp + rename), creating the folder. */
  writeTextAtomic(p: string, text: string): Promise<void>;
  copyDir(from: string, to: string): Promise<void>;
  /** Remove a file or a directory tree (no error when it is already gone). */
  remove(p: string): Promise<void>;
  listDir(p: string): Promise<string[]>;
  /** Windows only: a value under HKCU\Software\Valve\Steam, or null. */
  registrySteam(value: 'SteamPath' | 'SteamExe'): Promise<string | null>;
  gameRunning(): Promise<boolean | null>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

function registrySteam(value: 'SteamPath' | 'SteamExe'): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', value], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = new RegExp(`${value}\\s+REG_SZ\\s+(.+)$`, 'im').exec(String(stdout));
      resolve(m ? m[1].trim() : null);
    });
  });
}

export function defaultInstallDeps(): FactorioInstallDeps {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    exists,
    readText,
    writeTextAtomic: async (p, text) => {
      await mkdir(path.dirname(p), { recursive: true });
      const tmp = `${p}.sei-${process.pid}.tmp`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, p);
    },
    copyDir: async (from, to) => {
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to, { recursive: true, force: true });
    },
    remove: async (p) => {
      await rm(p, { recursive: true, force: true });
    },
    listDir: async (p) => {
      try {
        return await readdir(p);
      } catch {
        return [];
      }
    },
    registrySteam,
    gameRunning: () => isFactorioRunning(),
  };
}

/* ── where the game is ──────────────────────────────────────────────────── */

/** `path` for the target platform (tests run Windows fixtures on Linux). */
function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

export interface FactorioCandidate {
  binary: string;
  /** The folder holding data/ (and config-path.cfg). */
  root: string;
  store: FactorioStore;
}

/** The executable and data root inside one install folder (a Steam `common/Factorio`, or a standalone root). */
export function layoutFor(installDir: string, platform: NodeJS.Platform, store: FactorioStore): FactorioCandidate {
  const p = pathFor(platform);
  if (platform === 'darwin') {
    // Steam keeps the bundle inside common/Factorio; a standalone install IS the bundle.
    const app = installDir.endsWith('.app') ? installDir : p.join(installDir, 'factorio.app');
    return { binary: p.join(app, 'Contents', 'MacOS', 'factorio'), root: p.join(app, 'Contents'), store };
  }
  const exe = platform === 'win32' ? 'factorio.exe' : 'factorio';
  return { binary: p.join(installDir, 'bin', 'x64', exe), root: installDir, store };
}

/** Standalone (non-Steam) install folders to try, per platform. */
export function standaloneDirs(deps: Pick<FactorioInstallDeps, 'platform' | 'home' | 'env'>): string[] {
  const { platform, home, env } = deps;
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return [path.win32.join(pf, 'Factorio'), path.win32.join(pf86, 'Factorio')];
  }
  if (platform === 'darwin') return ['/Applications/factorio.app', path.posix.join(home, 'Applications', 'factorio.app')];
  return [path.posix.join(home, 'factorio')];
}

/** Steam library roots that may hold common/Factorio, the ones listing app 427520 first. */
async function steamLibraries(deps: FactorioInstallDeps): Promise<string[]> {
  const p = pathFor(deps.platform);
  const roots: string[] = [];
  const reg = await deps.registrySteam('SteamPath').catch(() => null);
  if (reg) roots.push(reg);
  for (const c of steamRootCandidates(deps)) if (!roots.includes(c)) roots.push(c);
  const libraries: string[] = [];
  for (const root of roots) {
    const vdf = await deps.readText(p.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (vdf) {
      for (const lib of parseLibraryFolders(vdf)) {
        if (libraries.includes(lib.path)) continue;
        if (lib.apps.includes(String(FACTORIO_STEAM_APP_ID))) libraries.unshift(lib.path);
        else libraries.push(lib.path);
      }
    }
    if (!libraries.includes(root)) libraries.push(root);
  }
  return libraries;
}

/** Every candidate install location, in search order: Steam libraries, then standalone. */
export async function candidateInstalls(deps: FactorioInstallDeps): Promise<FactorioCandidate[]> {
  const p = pathFor(deps.platform);
  const out: FactorioCandidate[] = [];
  for (const lib of await steamLibraries(deps)) {
    out.push(layoutFor(p.join(lib, 'steamapps', 'common', FACTORIO_STEAM_DIR), deps.platform, 'steam'));
  }
  for (const dir of standaloneDirs(deps)) out.push(layoutFor(dir, deps.platform, 'standalone'));
  return out;
}

/* ── version ────────────────────────────────────────────────────────────── */

/** `version` from data/base/info.json text, or null. */
export function versionFromInfoJson(text: string | null): string | null {
  if (!text) return null;
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === 'string' && parseModVersion(v) ? v : null;
  } catch {
    return null;
  }
}

/** Is this game version the one the mod supports (same major.minor)? null = unknown. */
export function isSupportedVersion(version: string | null): boolean | null {
  const v = parseModVersion(version);
  if (!v) return null;
  const want = parseModVersion(FACTORIO_SUPPORTED_VERSION)!;
  return v.parts[0] === want.parts[0] && (v.parts[1] ?? 0) === (want.parts[1] ?? 0);
}

/* ── the write-data folder ──────────────────────────────────────────────── */

/** Parse config-path.cfg: false when it turns the system data folders off. */
export function usesSystemDataDirs(cfg: string | null): boolean {
  if (!cfg) return true;
  const m = /^\s*use-system-read-write-data-directories\s*=\s*(\w+)/m.exec(cfg);
  return !m || m[1].toLowerCase() !== 'false';
}

export function systemUserDataDir(deps: Pick<FactorioInstallDeps, 'platform' | 'home' | 'env'>): string {
  if (deps.platform === 'win32') {
    const appData = deps.env.APPDATA ?? path.win32.join(deps.home, 'AppData', 'Roaming');
    return path.win32.join(appData, 'Factorio');
  }
  if (deps.platform === 'darwin') return path.posix.join(deps.home, 'Library', 'Application Support', 'factorio');
  return path.posix.join(deps.home, '.factorio');
}

export async function userDataDirFor(c: FactorioCandidate, deps: FactorioInstallDeps): Promise<string> {
  const cfg = await deps.readText(pathFor(deps.platform).join(c.root, 'config-path.cfg'));
  return usesSystemDataDirs(cfg) ? systemUserDataDir(deps) : c.root;
}

/* ── mod-list.json ──────────────────────────────────────────────────────── */

interface ModListEntry {
  name: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * The mod-list.json text with sei-companion enabled, every other entry kept
 * as it was (order and extra fields included). Throws on text that is not a
 * mod list, so a file Sei cannot read is never replaced. Idempotent.
 */
export function enableInModList(existing: string | null): string {
  let doc: { mods: ModListEntry[]; [key: string]: unknown };
  if (existing == null || existing.trim() === '') {
    // Never written by Factorio yet. `base` is listed the way Factorio lists
    // it; the DLC mods (space-age, quality, elevated-rails) are left to the
    // game, which adds what it finds on its next start.
    doc = { mods: [{ name: 'base', enabled: true }] };
  } else {
    const parsed = JSON.parse(existing) as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { mods?: unknown }).mods)) {
      throw new Error('mod-list.json is not a Factorio mod list');
    }
    doc = parsed as typeof doc;
  }
  const mods = doc.mods.filter((m): m is ModListEntry => !!m && typeof m === 'object' && typeof (m as ModListEntry).name === 'string');
  const mine = mods.find((m) => m.name === FACTORIO_MOD_NAME);
  if (mine) mine.enabled = true;
  else mods.push({ name: FACTORIO_MOD_NAME, enabled: true });
  return JSON.stringify({ ...doc, mods }, null, 2) + '\n';
}

/** Does mod-list.json leave sei-companion on? A missing file or entry = on (Factorio's default for a new mod). */
export function modEnabledIn(modList: string | null): boolean {
  if (modList == null) return true;
  try {
    const mods = (JSON.parse(modList) as { mods?: ModListEntry[] }).mods;
    const mine = Array.isArray(mods) ? mods.find((m) => m?.name === FACTORIO_MOD_NAME) : undefined;
    return mine ? mine.enabled !== false : true;
  } catch {
    return false;
  }
}

/* ── the mod in the mods folder ─────────────────────────────────────────── */

const MOD_ENTRY_RE = new RegExp(`^${FACTORIO_MOD_NAME.replace(/-/g, '\\-')}(?:_(.+?))?(\\.zip)?$`);

/** Is this mods/ entry a copy of the mod (folder or zip, versioned or not)? Returns its version from the name. */
export function parseModEntry(name: string): { version: string | null; zip: boolean } | null {
  const m = MOD_ENTRY_RE.exec(name);
  if (!m) return null;
  return { version: m[1] ?? null, zip: !!m[2] };
}

export function modFolderName(version: string): string {
  return `${FACTORIO_MOD_NAME}_${version}`;
}

/**
 * Where the mod sits relative to a pack root. The pack builder copies
 * native/factorio-mod/sei-companion to assets/factorio-mod/sei-companion
 * (scripts/build-game-pack.mjs); in dev the pack root IS the repo root, so
 * the native path is the fallback. sei-testkit never ships.
 */
export const MOD_SOURCE_RELATIVE = ['assets/factorio-mod/sei-companion', 'native/factorio-mod/sei-companion'] as const;

export async function resolveModSource(packRoot: string, deps: Pick<FactorioInstallDeps, 'exists'>): Promise<string | null> {
  for (const rel of MOD_SOURCE_RELATIVE) {
    const p = path.join(packRoot, ...rel.split('/'));
    if (await deps.exists(path.join(p, 'info.json'))) return p;
  }
  return null;
}

/** The mod's own version from its info.json (name must be sei-companion). */
export function modVersionFromInfo(text: string | null): string | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { name?: unknown; version?: unknown };
    return j.name === FACTORIO_MOD_NAME && typeof j.version === 'string' && parseModVersion(j.version) ? j.version : null;
  } catch {
    return null;
  }
}

interface InstalledMod {
  entries: string[];
  version: string | null;
}

async function installedMod(modsDir: string, deps: FactorioInstallDeps): Promise<InstalledMod> {
  const p = pathFor(deps.platform);
  const entries = (await deps.listDir(modsDir)).filter((n) => parseModEntry(n) != null);
  let version: string | null = null;
  for (const e of entries) {
    const parsed = parseModEntry(e)!;
    // A folder's own info.json is the truth; a zip only has its name.
    const v = parsed.zip ? parsed.version : (modVersionFromInfo(await deps.readText(p.join(modsDir, e, 'info.json'))) ?? parsed.version);
    if (v && (!version || packModIsNewer(v, version))) version = v;
  }
  return { entries, version };
}

/* ── detection ──────────────────────────────────────────────────────────── */

async function describe(c: FactorioCandidate, deps: FactorioInstallDeps): Promise<FactorioInstallInfo> {
  const version = versionFromInfoJson(await deps.readText(pathFor(deps.platform).join(c.root, 'data', 'base', 'info.json')));
  return { binary: c.binary, store: c.store, version, supported: isSupportedVersion(version) };
}

export interface FoundInstall {
  candidate: FactorioCandidate;
  info: FactorioInstallInfo;
}

/**
 * Every install on this machine, the best first: a supported 2.1 install
 * beats one whose version is unknown, which beats an unsupported one; Steam
 * before standalone otherwise (search order).
 */
export async function findInstalls(deps: FactorioInstallDeps): Promise<{ found: FoundInstall[]; searched: string[] }> {
  const found: FoundInstall[] = [];
  const searched: string[] = [];
  for (const c of await candidateInstalls(deps)) {
    if (searched.includes(c.binary)) continue;
    searched.push(c.binary);
    if (await deps.exists(c.binary)) found.push({ candidate: c, info: await describe(c, deps) });
  }
  const rank = (f: FoundInstall): number => (f.info.supported === true ? 0 : f.info.supported == null ? 1 : 2);
  found.sort((a, b) => rank(a) - rank(b));
  return { found, searched };
}

export interface DetectExtras {
  /** The Sei link port Factorio was last started with (the module's memory). */
  port: number | null;
  portInUse: boolean;
}

export async function detectFactorio(deps: FactorioInstallDeps = defaultInstallDeps(), extras: DetectExtras = { port: null, portInUse: false }): Promise<FactorioSetupState & { candidate?: FactorioCandidate }> {
  const { found, searched } = await findInstalls(deps);
  if (found.length === 0) return { kind: 'not_found', searched };
  const best = found[0];
  const userDataDir = await userDataDirFor(best.candidate, deps);
  const modsDir = pathFor(deps.platform).join(userDataDir, 'mods');
  const mod = await installedMod(modsDir, deps);
  const modList = await deps.readText(pathFor(deps.platform).join(modsDir, 'mod-list.json'));
  const gameRunning = await deps.gameRunning().catch(() => null);
  return {
    kind: 'found',
    install: best.info,
    others: found.slice(1).map((f) => f.info),
    userDataDir,
    modsDir,
    modInstalled: mod.entries.length > 0,
    modVersion: mod.version,
    modEnabled: modEnabledIn(modList),
    gameRunning,
    port: extras.port,
    portInUse: extras.portInUse,
    candidate: best.candidate,
  };
}

/** Strip the main-only `candidate` before a state crosses IPC. */
export function publicState(s: FactorioSetupState & { candidate?: FactorioCandidate }): FactorioSetupState {
  if (s.kind !== 'found') return s;
  const { candidate: _drop, ...rest } = s;
  return rest;
}

/* ── install ────────────────────────────────────────────────────────────── */

export class FactorioInstallError extends Error {
  constructor(
    readonly reason: 'not_found' | 'game_running' | 'mod_missing' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

/** Is the installed copy current (same or newer than the pack's) and switched on? Read-only. */
export async function modIsCurrent(packRoot: string, modsDir: string, deps: FactorioInstallDeps): Promise<boolean> {
  const src = await resolveModSource(packRoot, deps);
  if (!src) return true; // nothing to compare against; keep what is there
  const packVersion = modVersionFromInfo(await deps.readText(path.join(src, 'info.json')));
  const mod = await installedMod(modsDir, deps);
  if (mod.entries.length !== 1) return false; // missing, or stale copies beside it
  if (!mod.version || packModIsNewer(packVersion, mod.version)) return false;
  const want = packVersion ? modFolderName(packVersion) : null;
  if (want && mod.entries[0] !== want) return false;
  return modEnabledIn(await deps.readText(pathFor(deps.platform).join(modsDir, 'mod-list.json')));
}

/**
 * Copy the pack's mod into `<modsDir>/sei-companion_<version>`, remove every
 * other copy, and enable it in mod-list.json. Refuses while Factorio runs
 * (an unknown process state is not a refusal: the player pressed the
 * button, and a failed listing must not block them).
 */
export async function installMod(
  opts: { packRoot: string; modsDir: string },
  deps: FactorioInstallDeps = defaultInstallDeps(),
): Promise<{ version: string; folder: string }> {
  if ((await deps.gameRunning().catch(() => null)) === true) {
    throw new FactorioInstallError('game_running', 'Factorio is running. Close it, then add the mod again.');
  }
  const src = await resolveModSource(opts.packRoot, deps);
  if (!src) throw new FactorioInstallError('mod_missing', `The Sei mod is missing from the Factorio game pack (${opts.packRoot}).`);
  const version = modVersionFromInfo(await deps.readText(path.join(src, 'info.json')));
  if (!version) throw new FactorioInstallError('mod_missing', 'The Sei mod in the game pack has no readable version.');
  const p = pathFor(deps.platform);
  const folder = modFolderName(version);
  const dest = p.join(opts.modsDir, folder);
  try {
    // Read the mod list FIRST: a file Sei cannot parse stops the install
    // before anything in the folder changes.
    const listPath = p.join(opts.modsDir, 'mod-list.json');
    const nextList = enableInModList(await deps.readText(listPath));
    for (const entry of await deps.listDir(opts.modsDir)) {
      if (parseModEntry(entry) != null) await deps.remove(p.join(opts.modsDir, entry));
    }
    await deps.copyDir(src, dest);
    await deps.writeTextAtomic(listPath, nextList);
  } catch (err) {
    throw new FactorioInstallError('failed', String((err as Error)?.message ?? err));
  }
  return { version, folder };
}
