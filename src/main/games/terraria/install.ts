/**
 * Terraria / tModLoader detection and the companion mod install (261113).
 *
 * The mod is SIDELOADED: SeiCompanion.tmod is copied from the game pack into
 * `<tModLoader save folder>/Mods/`, listed in `Mods/enabled.json`, and
 * `<save folder>/SeiCompanion/link.json` gets the port and a per-install
 * token. It is never published to the Steam Workshop.
 *
 * Save folder (tModLoader's Main.SavePath):
 *   Windows  Documents\My Games\Terraria\tModLoader
 *   macOS    ~/Library/Application Support/Terraria/tModLoader
 *   Linux    $XDG_DATA_HOME/Terraria/tModLoader (~/.local/share/...)
 *
 * The game itself is found through Steam's libraryfolders.vdf (Terraria
 * 105600 and tModLoader 1281930); only Steam ships tModLoader to players.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parseVdf } from '../stardew/install';
import {
  TERRARIA_DEFAULT_PORT,
  TERRARIA_MOD_NAME,
  TERRARIA_STEAM_APP_ID,
  TML_STEAM_APP_ID,
  type TerrariaSetupState,
} from '../../../shared/terrariaIpc';

/** Where the built mod sits inside the game pack (and the repo, in dev). */
export const TERRARIA_MOD_PACK_PATH = ['assets', 'terraria-mod', `${TERRARIA_MOD_NAME}.tmod`] as const;

export interface TerrariaInstallEnv {
  platform: 'darwin' | 'win32' | 'linux';
  home: string;
  /** Windows Documents folder (OneDrive can move it); defaults to ~/Documents. */
  documents?: string;
  /** XDG_DATA_HOME on Linux. */
  xdgDataHome?: string | null;
  /** Windows registry read (Steam's install path). */
  readRegistry?: (hive: 'HKLM' | 'HKCU', key: string, name: string) => Promise<string | null>;
  /** Root of the downloaded game pack (or the repo root in dev). */
  getPackRoot: () => Promise<string>;
}

export function defaultEnv(): TerrariaInstallEnv {
  return {
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    home: homedir(),
    xdgDataHome: process.env.XDG_DATA_HOME || null,
    documents: undefined,
    readRegistry: async (hive, key, name) => {
      if (process.platform !== 'win32') return null;
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { parseRegQuery } = await import('../stardew/install');
      try {
        const { stdout } = await promisify(execFile)('reg', ['query', `${hive}\\${key}`, '/v', name], { windowsHide: true, timeout: 5000 });
        return parseRegQuery(String(stdout), name);
      } catch {
        return null;
      }
    },
    getPackRoot: async () => {
      const { ensurePack } = await import('../packs');
      return ensurePack('terraria');
    },
  };
}

/* ── Pure helpers ────────────────────────────────────────────────────── */

/** tModLoader's save folder for this OS (Main.SavePath). */
export function tmlSaveDir(env: Pick<TerrariaInstallEnv, 'platform' | 'home' | 'documents' | 'xdgDataHome'>): string {
  if (env.platform === 'win32') {
    return path.win32.join(env.documents ?? path.win32.join(env.home, 'Documents'), 'My Games', 'Terraria', 'tModLoader');
  }
  if (env.platform === 'darwin') return path.posix.join(env.home, 'Library', 'Application Support', 'Terraria', 'tModLoader');
  return path.posix.join(env.xdgDataHome || path.posix.join(env.home, '.local', 'share'), 'Terraria', 'tModLoader');
}

/** Steam's own folder candidates (libraryfolders.vdf lives in <root>/steamapps). */
export function steamRoots(platform: TerrariaInstallEnv['platform'], home: string, registryPath: string | null = null): string[] {
  if (platform === 'win32') {
    const out = registryPath ? [registryPath.replace(/\//g, '\\')] : [];
    out.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
    return out;
  }
  if (platform === 'darwin') return [path.posix.join(home, 'Library', 'Application Support', 'Steam')];
  return [
    path.posix.join(home, '.steam', 'steam'),
    path.posix.join(home, '.local', 'share', 'Steam'),
    path.posix.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
  ];
}

/** Which of the given Steam app ids libraryfolders.vdf lists as installed. */
export function steamAppsInLibraries(vdfText: string, appIds: number[]): Set<number> {
  const found = new Set<number>();
  let root: Record<string, unknown>;
  try {
    root = parseVdf(vdfText);
  } catch {
    return found;
  }
  const libraries = (root.libraryfolders ?? root.LibraryFolders) as Record<string, unknown> | undefined;
  if (!libraries || typeof libraries !== 'object') return found;
  for (const entry of Object.values(libraries)) {
    const apps = (entry as Record<string, unknown> | null)?.apps as Record<string, unknown> | undefined;
    if (!apps || typeof apps !== 'object') continue;
    for (const id of appIds) if (String(id) in apps) found.add(id);
  }
  return found;
}

/** Read a 7-bit-length-prefixed .NET string. */
function readNetString(buf: Buffer, off: number): { s: string; next: number } | null {
  let n = 0;
  let shift = 0;
  let o = off;
  for (;;) {
    if (o >= buf.length || shift > 28) return null;
    const b = buf[o++];
    n |= (b & 0x7f) << shift;
    shift += 7;
    if (b < 0x80) break;
  }
  if (o + n > buf.length) return null;
  return { s: buf.toString('utf8', o, o + n), next: o + n };
}

/**
 * Name and version from a .tmod header: "TMOD", tML version, 20-byte hash,
 * 256-byte signature, uint32 length, then the mod name and version.
 */
export function readTmodHeader(buf: Buffer): { tml: string; name: string; version: string } | null {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'TMOD') return null;
  const tml = readNetString(buf, 4);
  if (!tml) return null;
  const name = readNetString(buf, tml.next + 20 + 256 + 4);
  if (!name) return null;
  const version = readNetString(buf, name.next);
  if (!version) return null;
  return { tml: tml.s, name: name.s, version: version.s };
}

/** "0.1.10" > "0.1.9". Non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** enabled.json with the mod added (other entries kept, order kept). */
export function withModEnabled(raw: string | null, name: string = TERRARIA_MOD_NAME): string[] {
  let list: unknown = [];
  try {
    list = raw ? JSON.parse(raw) : [];
  } catch {
    list = [];
  }
  const names = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  return names.includes(name) ? names : [...names, name];
}

export interface TerrariaLink {
  port: number;
  token: string;
}

export function parseLink(raw: string | null): TerrariaLink | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { port?: unknown; token?: unknown };
    const port = typeof j.port === 'number' && Number.isInteger(j.port) ? j.port : null;
    const token = typeof j.token === 'string' ? j.token : '';
    if (port == null || token.length < 16) return null;
    return { port, token };
  } catch {
    return null;
  }
}

export function newToken(): string {
  return randomBytes(24).toString('hex');
}

/* ── IO ──────────────────────────────────────────────────────────────── */

async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export const paths = {
  mods: (saveDir: string) => path.join(saveDir, 'Mods'),
  tmod: (saveDir: string) => path.join(saveDir, 'Mods', `${TERRARIA_MOD_NAME}.tmod`),
  enabled: (saveDir: string) => path.join(saveDir, 'Mods', 'enabled.json'),
  link: (saveDir: string) => path.join(saveDir, TERRARIA_MOD_NAME, 'link.json'),
};

export async function readLink(saveDir: string): Promise<TerrariaLink | null> {
  return parseLink(await readText(paths.link(saveDir)));
}

async function tmodVersionAt(p: string): Promise<string | null> {
  try {
    const fh = await fs.open(p, 'r');
    try {
      const buf = Buffer.alloc(1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return readTmodHeader(buf.subarray(0, bytesRead))?.version ?? null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** Steam apps installed (null when no Steam library file was readable). */
async function steamApps(env: TerrariaInstallEnv): Promise<Set<number> | null> {
  const reg = env.platform === 'win32' ? ((await env.readRegistry?.('HKCU', 'Software\\Valve\\Steam', 'SteamPath')) ?? null) : null;
  let any = false;
  const found = new Set<number>();
  for (const root of steamRoots(env.platform, env.home, reg)) {
    const text = await readText(path.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (text == null) continue;
    any = true;
    for (const id of steamAppsInLibraries(text, [TERRARIA_STEAM_APP_ID, TML_STEAM_APP_ID])) found.add(id);
  }
  return any ? found : null;
}

export async function packTmodPath(env: TerrariaInstallEnv): Promise<string | null> {
  try {
    const p = path.join(await env.getPackRoot(), ...TERRARIA_MOD_PACK_PATH);
    return (await exists(p)) ? p : null;
  } catch {
    return null;
  }
}

/** Detection only, no writes. `packRoot` is only read when the pack is already on disk. */
export async function detectTerraria(env: TerrariaInstallEnv = defaultEnv(), opts: { packVersion?: string | null } = {}): Promise<TerrariaSetupState & { saveDir: string }> {
  const saveDir = tmlSaveDir(env);
  const apps = await steamApps(env);
  const tmod = paths.tmod(saveDir);
  const modVersion = await tmodVersionAt(tmod);
  const enabled = withModEnabled(await readText(paths.enabled(saveDir)), '\u0000');
  return {
    saveDir,
    terrariaInstalled: apps ? apps.has(TERRARIA_STEAM_APP_ID) : null,
    tmlInstalled: apps ? apps.has(TML_STEAM_APP_ID) : null,
    saveDirFound: await exists(saveDir),
    modInstalled: modVersion != null,
    modVersion,
    packVersion: opts.packVersion ?? null,
    modEnabled: enabled.includes(TERRARIA_MOD_NAME),
    linked: (await readLink(saveDir)) != null,
  };
}

/**
 * Copy the pack's .tmod into Mods/ (when missing or older), list it in
 * enabled.json and write link.json (keeping an existing token). The copy goes
 * through a temp file and a rename, so a half-written .tmod never sits where
 * tModLoader looks. Creates the save folder when tModLoader has not run yet.
 */
export async function installTerrariaMod(env: TerrariaInstallEnv = defaultEnv(), opts: { force?: boolean } = {}): Promise<{ upgraded: boolean; from: string | null; to: string; link: TerrariaLink }> {
  const src = path.join(await env.getPackRoot(), ...TERRARIA_MOD_PACK_PATH);
  const buf = await fs.readFile(src).catch(() => null);
  const header = buf ? readTmodHeader(buf) : null;
  if (!buf || !header || header.name !== TERRARIA_MOD_NAME) {
    throw new Error(`GAME_INSTALL_FAILED: the companion mod build is missing or unreadable at ${src}`);
  }
  const saveDir = tmlSaveDir(env);
  await fs.mkdir(paths.mods(saveDir), { recursive: true });
  const dest = paths.tmod(saveDir);
  const from = await tmodVersionAt(dest);
  const upgraded = opts.force === true || from == null || compareVersions(header.version, from) > 0;
  if (upgraded) {
    const tmp = `${dest}.sei-tmp`;
    await fs.writeFile(tmp, buf);
    try {
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        throw new Error('GAME_INSTALL_FAILED: tModLoader has the mod file open. Close tModLoader, then try again.');
      }
      throw err;
    }
  }
  const enabledPath = paths.enabled(saveDir);
  const enabled = withModEnabled(await readText(enabledPath));
  await fs.writeFile(enabledPath, JSON.stringify(enabled, null, 2) + '\n', 'utf8');

  const linkPath = paths.link(saveDir);
  const existing = parseLink(await readText(linkPath));
  const link: TerrariaLink = existing ?? { port: TERRARIA_DEFAULT_PORT, token: newToken() };
  if (!existing) {
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.writeFile(linkPath, JSON.stringify(link, null, 2) + '\n', 'utf8');
  }
  return { upgraded, from, to: header.version, link };
}

/** The pack's mod version, or null when the pack is not on disk. */
export async function packModVersion(env: TerrariaInstallEnv): Promise<string | null> {
  const p = await packTmodPath(env);
  return p ? tmodVersionAt(p) : null;
}
