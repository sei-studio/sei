/**
 * Don't Starve Together install detection + mod install (game-adapters M2,
 * 260908). No download: the mod ships inside the DST game pack
 * (`<packRoot>/assets/dst-mod/sei/`, or `native/dst-mod/sei/` in dev, see
 * resolveModSource) and is COPIED into the game's local mods folder, then
 * force-enabled through `<mods>/modsettings.lua` (an engine-supported
 * developer hook read by Klei's modindex.lua). Game updates and Steam
 * "verify files" rewrite that file, so enable() is re-applied on every Sei
 * launch and before every summon.
 *
 * Upgrades (260925): installMod runs on every Launch from Sei and copies the
 * pack's mod over the installed one, so a newer helper lands on the next
 * launch. When modinfo.lua says the pack's copy is newer than the installed
 * one, the old folder is removed first, so a script the new version dropped
 * does not linger. The folder holds no user settings (DST keeps mod
 * configuration in the save data, not the mod folder).
 *
 * Paths (research report 4.4):
 *   Windows  <Steam>\steamapps\common\Don't Starve Together\mods\
 *   macOS    <Steam>/steamapps/common/Don't Starve Together/dontstarve_steam.app/Contents/mods/
 *   Linux    <Steam>/steamapps/common/Don't Starve Together/mods/  (best effort)
 * Steam roots: the Windows registry SteamPath (HKCU\Software\Valve\Steam),
 * then per-platform defaults; every library in steamapps/libraryfolders.vdf
 * is searched for app 322330.
 *
 * Everything that touches the disk or the OS goes through an injectable
 * `deps` object so the tests run against fixtures.
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DstInstallState } from '../../../shared/dstIpc';
import { DST_STEAM_APP_ID } from '../../../shared/dstIpc';
import { findGameProcess, type GameProcessState } from './process';
import { packModIsNewer } from '../modVersion';

export const DST_INSTALL_DIR_NAME = "Don't Starve Together";
export const MOD_ID = 'sei';

export interface InstallDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(p: string): Promise<boolean>;
  readText(p: string): Promise<string | null>;
  writeText(p: string, text: string): Promise<void>;
  copyDir(from: string, to: string): Promise<void>;
  /** Remove a directory tree (no error when it is already gone). */
  removeDir(p: string): Promise<void>;
  listDir(p: string): Promise<string[]>;
  /** Windows only: HKCU\Software\Valve\Steam\SteamPath, or null. */
  registrySteamPath(): Promise<string | null>;
  /** Modification time (epoch ms) of a file, or null when missing (260909). */
  mtime(p: string): Promise<number | null>;
  /** Whether the game is running and since when (260909). */
  gameProcess(): Promise<GameProcessState>;
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

async function registrySteamPath(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = /SteamPath\s+REG_SZ\s+(.+)$/im.exec(String(stdout));
        resolve(m ? m[1].trim() : null);
      },
    );
  });
}

export function defaultDeps(): InstallDeps {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    exists,
    readText,
    writeText: async (p, text) => {
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, text, 'utf8');
    },
    copyDir: async (from, to) => {
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to, { recursive: true, force: true });
    },
    removeDir: async (p) => {
      await rm(p, { recursive: true, force: true });
    },
    listDir: async (p) => {
      try {
        return await readdir(p);
      } catch {
        return [];
      }
    },
    registrySteamPath,
    mtime: async (p) => {
      try {
        return (await stat(p)).mtimeMs;
      } catch {
        return null;
      }
    },
    gameProcess: () => findGameProcess(),
  };
}

/* ── libraryfolders.vdf ─────────────────────────────────────────────────── */

export interface SteamLibrary {
  path: string;
  apps: string[];
}

/**
 * Parse Valve's KeyValues text (libraryfolders.vdf) into libraries. Tolerant
 * of both the modern `"0" { "path" "..." "apps" { "322330" "..." } }` shape
 * and the legacy `"1" "D:\\Games"` entries. Backslashes are unescaped.
 */
export function parseLibraryFolders(vdf: string): SteamLibrary[] {
  const tokens = vdf.match(/"(?:[^"\\]|\\.)*"|\{|\}/g) ?? [];
  const unq = (t: string): string => t.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  const out: SteamLibrary[] = [];
  // A tiny recursive-descent over the token stream.
  let i = 0;
  function parseBlock(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === '}') return obj;
      if (t === '{') continue;
      const key = unq(t);
      const next = tokens[i];
      if (next === '{') {
        i++;
        obj[key] = parseBlock();
      } else if (next != null && next !== '}') {
        i++;
        obj[key] = unq(next);
      }
    }
    return obj;
  }
  const root = parseBlock();
  const folders = (root.libraryfolders ?? root.LibraryFolders ?? root) as Record<string, unknown>;
  for (const [k, v] of Object.entries(folders)) {
    if (typeof v === 'string') {
      if (/^\d+$/.test(k)) out.push({ path: v, apps: [] });
      continue;
    }
    if (v && typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      const p = typeof rec.path === 'string' ? rec.path : null;
      if (!p) continue;
      const apps = rec.apps && typeof rec.apps === 'object' ? Object.keys(rec.apps as object) : [];
      out.push({ path: p, apps });
    }
  }
  return out;
}

/* ── detection ──────────────────────────────────────────────────────────── */

export function steamRootCandidates(deps: Pick<InstallDeps, 'platform' | 'home' | 'env'>): string[] {
  const { platform, home, env } = deps;
  if (platform === 'win32') {
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    return [path.join(pf86, 'Steam'), path.join(pf, 'Steam')];
  }
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Steam')];
  return [path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam'), path.join(home, '.steam', 'root')];
}

/** Where the game's local mods folder lives inside an install. */
export function modsDirFor(installPath: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') return path.join(installPath, 'dontstarve_steam.app', 'Contents', 'mods');
  return path.join(installPath, 'mods');
}

export interface DstInstallLocation {
  installPath: string;
  modsDir: string;
}

/**
 * Find the DST install: every Steam root's libraryfolders.vdf, each library's
 * `steamapps/common/Don't Starve Together`. Returns the location or the list
 * of places searched (for the not-installed copy).
 */
export async function findDstInstall(deps: InstallDeps = defaultDeps()): Promise<{ found: DstInstallLocation | null; searched: string[] }> {
  const roots: string[] = [];
  const reg = await deps.registrySteamPath().catch(() => null);
  if (reg) roots.push(reg);
  for (const c of steamRootCandidates(deps)) if (!roots.includes(c)) roots.push(c);
  const libraries: string[] = [];
  for (const root of roots) {
    const vdf = await deps.readText(path.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (vdf) {
      for (const lib of parseLibraryFolders(vdf)) {
        // Prefer libraries that list the app; keep the rest as fallbacks.
        if (lib.apps.includes(String(DST_STEAM_APP_ID))) libraries.unshift(lib.path);
        else libraries.push(lib.path);
      }
    }
    if (!libraries.includes(root)) libraries.push(root);
  }
  const searched: string[] = [];
  for (const lib of libraries) {
    const installPath = path.join(lib, 'steamapps', 'common', DST_INSTALL_DIR_NAME);
    if (searched.includes(installPath)) continue;
    searched.push(installPath);
    if (await deps.exists(installPath)) {
      return { found: { installPath, modsDir: modsDirFor(installPath, deps.platform) }, searched };
    }
  }
  return { found: null, searched };
}

/* ── modsettings.lua ────────────────────────────────────────────────────── */

const FORCE_LINE = `ForceEnableMod("${MOD_ID}")`;
const WARN_LINE = 'DisableLocalModWarning()';
const MARKER = '-- Added by Sei (the companion helper). Safe to leave in place.';

/**
 * Ensure ForceEnableMod("sei") and DisableLocalModWarning() are present as
 * live lines, preserving everything else (Klei ships this file with the
 * hooks commented out as documentation). Idempotent: running it on its own
 * output returns the same text.
 */
export function rewriteModSettings(existing: string | null): string {
  const text = existing ?? '';
  const lines = text.split(/\r?\n/);
  const isLive = (l: string, needle: string): boolean => {
    const s = l.trim();
    return s.startsWith(needle) && !s.startsWith('--');
  };
  const hasForce = lines.some((l) => isLive(l, FORCE_LINE));
  const hasWarn = lines.some((l) => isLive(l, WARN_LINE));
  if (hasForce && hasWarn) return text;
  const out = [...lines];
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  if (!out.some((l) => l.trim() === MARKER)) {
    if (out.length) out.push('');
    out.push(MARKER);
  }
  if (!hasForce) out.push(FORCE_LINE);
  if (!hasWarn) out.push(WARN_LINE);
  return out.join('\n') + '\n';
}

/* ── the mod source (game pack) ─────────────────────────────────────────── */

/**
 * Where the mod lives relative to a pack root. The pack builder copies
 * `native/dst-mod/sei` to `assets/dst-mod/sei` (scripts/build-game-pack.mjs);
 * in dev the pack root IS the repo root, so the native path is the fallback.
 */
export const MOD_SOURCE_RELATIVE = ['assets/dst-mod/sei', 'native/dst-mod/sei'] as const;

export async function resolveModSource(packRoot: string, deps: Pick<InstallDeps, 'exists'> = defaultDeps()): Promise<string | null> {
  for (const rel of MOD_SOURCE_RELATIVE) {
    const p = path.join(packRoot, ...rel.split('/'));
    if (await deps.exists(path.join(p, 'modinfo.lua'))) return p;
  }
  return null;
}

export function modVersionFrom(modinfo: string | null): string | null {
  if (!modinfo) return null;
  const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(modinfo);
  return m ? m[1] : null;
}

/* ── the three operations the GameModule exposes ────────────────────────── */

/**
 * Did the running game start before the helper landed? Mods are indexed once
 * at game start, so a game older than the newer of the two files Sei writes
 * (the mod folder's modinfo.lua, modsettings.lua) has not loaded it. Unknown
 * start time = no claim (false): the launch panel would otherwise nag a
 * player whose game is fine, and a live heartbeat settles it anyway.
 */
export function needsRestart(proc: GameProcessState, modInfoMtime: number | null, settingsMtime: number | null): boolean {
  if (!proc.running || proc.startedAt == null) return false;
  const landed = Math.max(modInfoMtime ?? 0, settingsMtime ?? 0);
  return landed > 0 && proc.startedAt < landed;
}

export async function detectInstall(deps: InstallDeps = defaultDeps()): Promise<DstInstallState> {
  const { found, searched } = await findDstInstall(deps);
  if (!found) return { kind: 'not_found', searched };
  const modDir = path.join(found.modsDir, MOD_ID);
  const modInfoPath = path.join(modDir, 'modinfo.lua');
  const settingsPath = path.join(found.modsDir, 'modsettings.lua');
  const modinfo = await deps.readText(modInfoPath);
  const settings = await deps.readText(settingsPath);
  const enabled = settings != null && rewriteModSettings(settings) === settings;
  const modInstalled = modinfo != null;
  const proc = await deps.gameProcess().catch((): GameProcessState => ({ running: false, startedAt: null }));
  const restart =
    modInstalled && enabled
      ? needsRestart(proc, await deps.mtime(modInfoPath), await deps.mtime(settingsPath))
      : false;
  return {
    kind: 'found',
    installPath: found.installPath,
    modsDir: found.modsDir,
    modInstalled,
    modVersion: modVersionFrom(modinfo),
    enabled,
    gameRunning: proc.running,
    needsRestart: restart,
  };
}

/** Copy the mod from the pack into the game and force-enable it. */
export async function installMod(
  opts: { packRoot: string; onProgress?: (step: string) => void },
  deps: InstallDeps = defaultDeps(),
): Promise<DstInstallState> {
  const { found, searched } = await findDstInstall(deps);
  if (!found) return { kind: 'not_found', searched };
  const src = await resolveModSource(opts.packRoot, deps);
  if (!src) {
    return { kind: 'error', error: 'GAME_INSTALL_FAILED', message: `The helper mod files are missing from ${opts.packRoot}.` };
  }
  const dest = path.join(found.modsDir, MOD_ID);
  try {
    const installed = await deps.readText(path.join(dest, 'modinfo.lua'));
    const packVersion = modVersionFrom(await deps.readText(path.join(src, 'modinfo.lua')));
    if (installed != null && packModIsNewer(packVersion, modVersionFrom(installed))) {
      opts.onProgress?.('replacing');
      await deps.removeDir(dest);
    }
    opts.onProgress?.('copying');
    await deps.copyDir(src, dest);
    opts.onProgress?.('enabling');
    await enableMod(found.modsDir, deps);
  } catch (err) {
    return installError(err, deps.platform);
  }
  return detectInstall(deps);
}

/**
 * Classify a copy/write failure. On macOS an EPERM inside the game bundle is
 * the App Management gate, not a broken disk: measured 260909 on macOS 26,
 * `mkdir dontstarve_steam.app/Contents/mods/sei` fails with EPERM from an
 * unprivileged process (the folder is owner-writable; the refusal is TCC).
 */
export function installError(err: unknown, platform: NodeJS.Platform): DstInstallState {
  const e = err as NodeJS.ErrnoException;
  const message = String(e?.message ?? err);
  const permission = platform === 'darwin' && (e?.code === 'EPERM' || /operation not permitted/i.test(message));
  return permission
    ? { kind: 'error', error: 'GAME_INSTALL_FAILED', message, permission: true }
    : { kind: 'error', error: 'GAME_INSTALL_FAILED', message };
}

/** Re-apply modsettings.lua (idempotent; cheap; called on launch + summon). */
export async function enableMod(modsDir: string, deps: InstallDeps = defaultDeps()): Promise<void> {
  const p = path.join(modsDir, 'modsettings.lua');
  const existing = await deps.readText(p);
  const next = rewriteModSettings(existing);
  if (next !== existing) await deps.writeText(p, next);
}
