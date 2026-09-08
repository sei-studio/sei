/**
 * Stardew Valley install support (game-adapters M1, 260908).
 *
 * Three jobs, all main-process:
 *   1. FIND THE GAME: a TypeScript port of the LOGIC of SMAPI's GameScanner
 *      (LGPL-3.0; logic only, no code): Windows registry keys (Steam app
 *      413150, GOG), Steam's libraryfolders.vdf, the default install folders
 *      per OS and store, and ~/stardewvalley.targets. A folder is valid when
 *      it holds `Stardew Valley.dll` (1.5.5+; the 1.6 line is what SMAPI 4.5
 *      supports). macOS: the folder is `<app>/Contents/MacOS`.
 *   2. INSTALL SMAPI: download the official installer zip (mirror first,
 *      then GitHub; size shown; 60 s connect budget; AbortSignal), extract
 *      it, run `SMAPI.Installer --install --no-prompt --game-path <dir>`.
 *      SMAPI is LGPL and is never vendored; this is the same install its own
 *      `install on <OS>` script performs, minus the prompts.
 *   3. PLACE THE MOD: copy <packRoot>/assets/stardew-mod/SeiCompanion into
 *      <game>/Mods/SeiCompanion and write config.json with a fresh token +
 *      port (an existing token is kept, so a re-run never breaks a running
 *      game's pairing).
 *
 * Pure helpers (parseVdf, parseRegQuery, defaultInstallPaths, classify...)
 * are exported for tests; the I/O functions take an `env` for the same
 * reason (see install.test.ts).
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import {
  SMAPI_INSTALLER_ASSET,
  SMAPI_INSTALLER_ORIGIN_URL,
  SMAPI_VERSION,
  STARDEW_DEFAULT_PORT,
  STARDEW_MOD_FOLDER,
  STARDEW_MOD_PACK_PATH,
  StardewModConfigSchema,
  type StardewInstallProgressEvent,
  type StardewInstallState,
  type StardewModConfig,
} from '../../../shared/stardewIpc';
import { DL_MIRROR_BASE, MIRROR_CONNECT_TIMEOUT_MS } from '../../speech/mirrors';

const execFileAsync = promisify(execFile);
const STEAM_APP_ID = '413150';
const GOG_REGISTRY_ID = '1453375253';
const DOWNLOAD_TIMEOUT_MS = 60_000;
const STALL_MS = 30_000;

/* ── Environment (overridable for tests) ─────────────────────────────── */

export interface StardewInstallEnv {
  platform: 'darwin' | 'win32' | 'linux';
  home: string;
  /** Read a Windows registry value (HKLM/HKCU path + name). Null when absent. */
  readRegistry: (hive: 'HKLM' | 'HKCU', key: string, name: string) => Promise<string | null>;
  /** Where the built mod lives (a pack root or the repo root in dev). */
  getPackRoot: () => Promise<string>;
  /** Temp dir for the installer zip. */
  tmpDir: () => string;
  fetch: typeof fetch;
  /** SMAPI installer download sources, mirror first. */
  smapiSources: () => { url: string; connectTimeoutMs?: number }[];
  /** Run the extracted SMAPI installer (overridable so tests can fake it). */
  runInstaller: (installerPath: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  now: () => number;
}

export function defaultEnv(): StardewInstallEnv {
  return {
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    home: homedir(),
    readRegistry: readRegistryValue,
    getPackRoot: async () => {
      const { ensurePack } = await import('../packs');
      return ensurePack('stardew');
    },
    tmpDir: () => {
      // Lazy: `paths` needs Electron's app; tests never reach it.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { paths } = require('../../paths') as typeof import('../../paths');
      return path.join(paths.userData(), 'tmp');
    },
    fetch: (input, init) => fetch(input, init),
    smapiSources: () => [
      { url: `${DL_MIRROR_BASE}/stardew/${SMAPI_INSTALLER_ASSET}`, connectTimeoutMs: MIRROR_CONNECT_TIMEOUT_MS },
      { url: SMAPI_INSTALLER_ORIGIN_URL },
    ],
    runInstaller: async (installerPath, args, cwd) => {
      const { stdout, stderr } = await execFileAsync(installerPath, args, { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
    },
    now: () => Date.now(),
  };
}

/* ── Pure helpers ────────────────────────────────────────────────────── */

/** Minimal Valve KeyValues (VDF) parser: nested objects of string values. */
export function parseVdf(text: string): Record<string, unknown> {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])|\/\/[^\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    else if (m[2] !== undefined) tokens.push(m[2]);
  }
  let i = 0;
  const parseObject = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    while (i < tokens.length) {
      const tok = tokens[i++];
      if (tok === '}') return out;
      if (tok === '{') continue;
      const next = tokens[i];
      if (next === '{') {
        i++;
        out[tok] = parseObject();
      } else if (next !== undefined && next !== '}') {
        i++;
        out[tok] = next;
      }
    }
    return out;
  };
  return parseObject();
}

/**
 * The Stardew Valley folder listed in Steam's libraryfolders.vdf, if the app
 * is installed in one of the libraries (app key 413150). Returns the library
 * path joined with steamapps/common/Stardew Valley (plus Contents/MacOS on
 * macOS), or null.
 */
export function stardewPathFromLibraryFolders(vdfText: string, platform: StardewInstallEnv['platform']): string | null {
  let root: Record<string, unknown>;
  try {
    root = parseVdf(vdfText);
  } catch {
    return null;
  }
  const libraries = (root.libraryfolders ?? root.LibraryFolders) as Record<string, unknown> | undefined;
  if (!libraries || typeof libraries !== 'object') return null;
  for (const entry of Object.values(libraries)) {
    if (!entry || typeof entry !== 'object') continue;
    const lib = entry as Record<string, unknown>;
    const apps = lib.apps as Record<string, unknown> | undefined;
    const libPath = typeof lib.path === 'string' ? lib.path : null;
    if (!libPath || !apps || !(STEAM_APP_ID in apps)) continue;
    const base = path.join(libPath.replace(/\\\\/g, '\\'), 'steamapps', 'common', 'Stardew Valley');
    return platform === 'darwin' ? path.join(base, 'Contents', 'MacOS') : base;
  }
  return null;
}

/** Parse `reg query` output for one value. */
export function parseRegQuery(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line);
    if (m && m[1].toLowerCase() === name.toLowerCase()) return m[3].trim() || null;
  }
  return null;
}

async function readRegistryValue(hive: 'HKLM' | 'HKCU', key: string, name: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('reg', ['query', `${hive}\\${key}`, '/v', name, '/reg:64'], { windowsHide: true, timeout: 5000 });
    return parseRegQuery(String(stdout), name);
  } catch {
    try {
      const { stdout } = await execFileAsync('reg', ['query', `${hive}\\${key}`, '/v', name], { windowsHide: true, timeout: 5000 });
      return parseRegQuery(String(stdout), name);
    } catch {
      return null;
    }
  }
}

/** SMAPI's default install folders per OS (GameScanner.GetDefaultInstallPaths). */
export function defaultInstallPaths(platform: StardewInstallEnv['platform'], home: string): string[] {
  const out: string[] = [];
  if (platform === 'darwin') {
    out.push(path.join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'Stardew Valley', 'Contents', 'MacOS'));
    out.push('/Applications/Stardew Valley.app/Contents/MacOS');
  } else if (platform === 'linux') {
    out.push(path.join(home, 'GOG Games', 'Stardew Valley', 'game'));
    out.push(path.join(home, '.steam', 'steam', 'steamapps', 'common', 'Stardew Valley'));
    out.push(path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common', 'Stardew Valley'));
    out.push(path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam', 'steamapps', 'common', 'Stardew Valley'));
  } else {
    for (const programFiles of ['C:\\Program Files', 'C:\\Program Files (x86)']) {
      out.push(`${programFiles}\\GalaxyClient\\Games\\Stardew Valley`);
      out.push(`${programFiles}\\GOG Galaxy\\Games\\Stardew Valley`);
      out.push(`${programFiles}\\GOG Games\\Stardew Valley`);
      out.push(`${programFiles}\\Steam\\steamapps\\common\\Stardew Valley`);
    }
    for (let d = 'C'.charCodeAt(0); d <= 'H'.charCodeAt(0); d++) {
      out.push(`${String.fromCharCode(d)}:\\Program Files\\ModifiableWindowsApps\\Stardew Valley`);
    }
  }
  return out;
}

/** `<GamePath>` from ~/stardewvalley.targets, if present. */
export function gamePathFromTargets(xml: string): string | null {
  const m = /<GamePath>\s*([^<]+?)\s*<\/GamePath>/i.exec(xml);
  return m ? m[1].trim() : null;
}

export function storeFromPath(p: string): StardewInstallState['store'] {
  const lower = p.toLowerCase();
  if (lower.includes('steamapps')) return 'steam';
  if (lower.includes('modifiablewindowsapps')) return 'xbox';
  if (lower.includes('gog') || lower.includes('galaxy')) return 'gog';
  return 'unknown';
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** valid = `Stardew Valley.dll` present; legacy = only a pre-1.5.5 executable. */
export async function classifyGameFolder(dir: string): Promise<'valid' | 'legacy' | 'invalid' | 'none'> {
  if (!(await exists(dir))) return 'none';
  if (await exists(path.join(dir, 'Stardew Valley.dll'))) return 'valid';
  if ((await exists(path.join(dir, 'Stardew Valley.exe'))) || (await exists(path.join(dir, 'StardewValley.exe')))) return 'legacy';
  return 'invalid';
}

/* ── Detection ───────────────────────────────────────────────────────── */

/** Every folder worth checking, custom + registry + Steam libraries + defaults, deduplicated in order. */
export async function candidateGamePaths(env: StardewInstallEnv): Promise<string[]> {
  const out: string[] = [];
  const push = (p: string | null | undefined) => {
    if (!p) return;
    const norm = path.normalize(p.trim().replace(/[\\/]+$/, ''));
    if (!out.some((x) => x.toLowerCase() === norm.toLowerCase())) out.push(norm);
  };
  try {
    const targets = await fs.readFile(path.join(env.home, 'stardewvalley.targets'), 'utf8');
    push(gamePathFromTargets(targets));
  } catch {
    /* no custom path */
  }
  if (env.platform === 'win32') {
    push(await env.readRegistry('HKLM', `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App ${STEAM_APP_ID}`, 'InstallLocation'));
    push(await env.readRegistry('HKLM', `SOFTWARE\\WOW6432Node\\GOG.com\\Games\\${GOG_REGISTRY_ID}`, 'PATH'));
    const steamPath = await env.readRegistry('HKCU', 'Software\\Valve\\Steam', 'SteamPath');
    if (steamPath) {
      const steamRoot = steamPath.replace(/\//g, '\\');
      push(path.join(steamRoot, 'steamapps', 'common', 'Stardew Valley'));
      try {
        const vdf = await fs.readFile(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8');
        push(stardewPathFromLibraryFolders(vdf, env.platform));
      } catch {
        /* no vdf */
      }
    }
  } else {
    const steamRoots =
      env.platform === 'darwin'
        ? [path.join(env.home, 'Library', 'Application Support', 'Steam')]
        : [path.join(env.home, '.steam', 'steam'), path.join(env.home, '.local', 'share', 'Steam')];
    for (const root of steamRoots) {
      try {
        const vdf = await fs.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
        push(stardewPathFromLibraryFolders(vdf, env.platform));
      } catch {
        /* no vdf */
      }
    }
  }
  for (const p of defaultInstallPaths(env.platform, env.home)) push(p);
  return out;
}

export function modDir(gamePath: string): string {
  return path.join(gamePath, 'Mods', STARDEW_MOD_FOLDER);
}

export async function readModConfig(gamePath: string): Promise<StardewModConfig | null> {
  try {
    const raw = await fs.readFile(path.join(modDir(gamePath), 'config.json'), 'utf8');
    const parsed = StardewModConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readModVersion(gamePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(modDir(gamePath), 'manifest.json'), 'utf8');
    const j = JSON.parse(raw) as { Version?: unknown };
    return typeof j.Version === 'string' ? j.Version : null;
  } catch {
    return null;
  }
}

async function readSmapiVersion(gamePath: string): Promise<string | null> {
  // SMAPI writes its version into StardewModdingAPI.deps.json ("StardewModdingAPI/4.5.2").
  try {
    const raw = await fs.readFile(path.join(gamePath, 'StardewModdingAPI.deps.json'), 'utf8');
    const m = /"StardewModdingAPI\/([0-9][^"]*)"/.exec(raw);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** One detection pass: game folder, SMAPI, the mod, its config. */
export async function detectStardew(env: StardewInstallEnv = defaultEnv()): Promise<StardewInstallState> {
  const candidates = await candidateGamePaths(env);
  let gamePath: string | null = null;
  for (const c of candidates) {
    if ((await classifyGameFolder(c)) === 'valid') {
      gamePath = c;
      break;
    }
  }
  const base: StardewInstallState = {
    gamePath,
    candidates,
    smapiInstalled: false,
    smapiVersion: null,
    modInstalled: false,
    modVersion: null,
    modConfig: null,
    store: gamePath ? storeFromPath(gamePath) : 'unknown',
    platform: env.platform,
    ready: false,
  };
  if (!gamePath) return base;
  base.smapiInstalled = await exists(path.join(gamePath, 'StardewModdingAPI.dll'));
  base.smapiVersion = base.smapiInstalled ? await readSmapiVersion(gamePath) : null;
  base.modInstalled = (await exists(path.join(modDir(gamePath), 'SeiCompanion.dll'))) && (await exists(path.join(modDir(gamePath), 'manifest.json')));
  base.modVersion = base.modInstalled ? await readModVersion(gamePath) : null;
  const cfg = base.modInstalled ? await readModConfig(gamePath) : null;
  base.modConfig = cfg ? { port: cfg.Port, hasToken: cfg.Token.length > 0 } : null;
  base.ready = base.smapiInstalled && base.modInstalled && !!cfg && cfg.Token.length > 0;
  return base;
}

/* ── SMAPI download + install ────────────────────────────────────────── */

function composedAbort(timeoutMs: number, signal?: AbortSignal | null): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason ?? new Error('cancelled'));
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Download the SMAPI installer zip, mirror first. Progress reports bytes +
 * total (from Content-Length; 0 when unknown). Throws with a
 * SMAPI_INSTALL_FAILED prefix.
 */
export async function downloadSmapiInstaller(
  env: StardewInstallEnv,
  onProgress: (pct: number, bytes: number, total: number) => void,
  signal?: AbortSignal | null,
): Promise<Buffer> {
  const errors: string[] = [];
  for (const source of env.smapiSources()) {
    const { signal: composed, cleanup } = composedAbort(source.connectTimeoutMs ?? DOWNLOAD_TIMEOUT_MS, signal);
    try {
      const r = await env.fetch(source.url, { signal: composed, headers: { 'user-agent': 'Sei' } });
      if (!r.ok) throw new Error(`${r.status}`);
      cleanup();
      const total = Number(r.headers.get('content-length') ?? 0) || 0;
      const chunks: Buffer[] = [];
      let received = 0;
      let lastTick = env.now();
      if (!r.body) throw new Error('empty body');
      const reader = r.body.getReader();
      for (;;) {
        if (signal?.aborted) throw new Error('cancelled');
        const stall = setTimeout(() => reader.cancel(new Error('stalled')).catch(() => {}), STALL_MS);
        const { done, value } = await reader.read().finally(() => clearTimeout(stall));
        if (done) break;
        if (value) {
          chunks.push(Buffer.from(value));
          received += value.byteLength;
        }
        const now = env.now();
        if (now - lastTick > 150 || (total && received === total)) {
          lastTick = now;
          onProgress(total ? Math.min(99, Math.floor((received / total) * 100)) : 0, received, total);
        }
      }
      const buf = Buffer.concat(chunks);
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('not a zip');
      onProgress(100, buf.length, total || buf.length);
      return buf;
    } catch (err) {
      cleanup();
      if (signal?.aborted) throw new Error('SMAPI_INSTALL_FAILED: cancelled');
      errors.push(`${source.url}: ${(err as Error)?.message ?? err}`);
    }
  }
  throw new Error(`SMAPI_INSTALL_FAILED: could not download ${SMAPI_INSTALLER_ASSET} (${errors.join('; ')})`);
}

/** Extract the installer zip into `dir`; returns the installer executable path for this platform. */
export async function extractSmapiInstaller(zipBytes: Buffer, dir: string, platform: StardewInstallEnv['platform']): Promise<string> {
  const zip = await JSZip.loadAsync(zipBytes);
  await fs.mkdir(dir, { recursive: true });
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    const rel = entry.name.replace(/\\/g, '/');
    if (rel.split('/').some((seg) => seg === '..')) throw new Error('SMAPI_INSTALL_FAILED: unsafe zip entry');
    const dest = path.join(dir, ...rel.split('/'));
    if (entry.dir) {
      await fs.mkdir(dest, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, await entry.async('nodebuffer'));
  }
  const wanted =
    platform === 'win32'
      ? ['internal', 'windows', 'SMAPI.Installer.exe']
      : platform === 'darwin'
        ? ['internal', 'macOS', 'SMAPI.Installer']
        : ['internal', 'linux', 'SMAPI.Installer'];
  // The zip has one top-level folder ("SMAPI 4.5.2 installer"); search for the installer under it.
  const found = await findFile(dir, wanted);
  if (!found) throw new Error(`SMAPI_INSTALL_FAILED: the installer zip has no ${wanted.join('/')}`);
  if (platform !== 'win32') {
    await fs.chmod(found, 0o755).catch(() => {});
    const launcher = path.join(path.dirname(found), 'bundle', 'unix-launcher.sh');
    await fs.chmod(launcher, 0o755).catch(() => {});
  }
  return found;
}

async function findFile(root: string, tail: string[]): Promise<string | null> {
  const direct = path.join(root, ...tail);
  if (await exists(direct)) return direct;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name, ...tail);
    if (await exists(p)) return p;
  }
  return null;
}

/* ── The mod files + config ──────────────────────────────────────────── */

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

/**
 * Copy the built mod into <game>/Mods/SeiCompanion (replacing the previous
 * files, keeping config.json) and write config.json with a token + port.
 */
export async function placeMod(gamePath: string, packRoot: string, opts: { port?: number } = {}): Promise<StardewModConfig> {
  const src = path.join(packRoot, ...STARDEW_MOD_PACK_PATH);
  if (!(await exists(path.join(src, 'SeiCompanion.dll'))) || !(await exists(path.join(src, 'manifest.json')))) {
    throw new Error(
      `GAME_INSTALL_FAILED: the companion mod build is missing at ${src}` +
        ' (on a dev checkout run `npm run build:stardew-mod` on a machine with the game installed)',
    );
  }
  const dest = modDir(gamePath);
  const existing = await readModConfig(gamePath);
  for (const name of ['SeiCompanion.dll', 'SeiCompanion.pdb', 'manifest.json']) {
    await fs.rm(path.join(dest, name), { force: true }).catch(() => {});
  }
  await fs.rm(path.join(dest, 'Assets'), { recursive: true, force: true }).catch(() => {});
  await copyDir(src, dest);
  const config: StardewModConfig = StardewModConfigSchema.parse({
    ...(existing ?? {}),
    Port: opts.port ?? existing?.Port ?? STARDEW_DEFAULT_PORT,
    Token: existing?.Token && existing.Token.length >= 16 ? existing.Token : newToken(),
  });
  await fs.writeFile(path.join(dest, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  return config;
}

/* ── The whole install ───────────────────────────────────────────────── */

export interface InstallStardewOpts {
  onProgress?: (ev: StardewInstallProgressEvent) => void;
  signal?: AbortSignal | null;
  env?: StardewInstallEnv;
}

/**
 * Detect → (SMAPI if missing) → mod files → config. Throws an Error whose
 * message starts with the ErrorClass (GAME_NOT_INSTALLED / SMAPI_INSTALL_FAILED /
 * GAME_INSTALL_FAILED); the IPC handler forwards it and the last progress
 * event carries the same class.
 */
export async function installStardew({ onProgress = () => {}, signal = null, env = defaultEnv() }: InstallStardewOpts = {}): Promise<StardewInstallState> {
  const fail = (error: 'GAME_NOT_INSTALLED' | 'SMAPI_INSTALL_FAILED' | 'GAME_INSTALL_FAILED', message: string): never => {
    onProgress({ stage: 'failed', error, message });
    throw new Error(`${error}: ${message}`);
  };
  onProgress({ stage: 'detecting' });
  const before = await detectStardew(env);
  if (!before.gamePath) {
    fail('GAME_NOT_INSTALLED', `Stardew Valley was not found. Looked in: ${before.candidates.slice(0, 6).join(', ')}`);
  }
  const gamePath = before.gamePath as string;

  if (!before.smapiInstalled) {
    onProgress({ stage: 'smapi-downloading', pct: 0 });
    let zipBytes: Buffer;
    try {
      zipBytes = await downloadSmapiInstaller(env, (pct, bytes, total) => onProgress({ stage: 'smapi-downloading', pct, bytes, total }), signal);
    } catch (err) {
      fail('SMAPI_INSTALL_FAILED', String((err as Error)?.message ?? err).replace(/^SMAPI_INSTALL_FAILED:\s*/, ''));
    }
    onProgress({ stage: 'smapi-installing' });
    const workDir = path.join(env.tmpDir(), `smapi-installer-${env.now().toString(36)}`);
    try {
      const installer = await extractSmapiInstaller(zipBytes!, workDir, env.platform);
      const { stdout, stderr } = await env.runInstaller(installer, ['--install', '--no-prompt', '--game-path', gamePath], path.dirname(installer));
      if (!(await exists(path.join(gamePath, 'StardewModdingAPI.dll')))) {
        const tail = (stdout + '\n' + stderr).trim().split('\n').slice(-6).join(' | ');
        fail('SMAPI_INSTALL_FAILED', `the SMAPI ${SMAPI_VERSION} installer finished but StardewModdingAPI.dll is not in ${gamePath}: ${tail || 'no output'}`);
      }
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (msg.startsWith('SMAPI_INSTALL_FAILED')) throw err;
      fail('SMAPI_INSTALL_FAILED', `${msg}. Close Stardew Valley and try again; if it keeps failing, install SMAPI from smapi.io and re-run this setup.`);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  onProgress({ stage: 'mod-placing' });
  let packRoot: string;
  try {
    packRoot = await env.getPackRoot();
  } catch (err) {
    fail('GAME_INSTALL_FAILED', `could not get the companion mod files: ${String((err as Error)?.message ?? err)}`);
  }
  try {
    onProgress({ stage: 'config-writing' });
    await placeMod(gamePath, packRoot!);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg.startsWith('GAME_INSTALL_FAILED')) {
      onProgress({ stage: 'failed', error: 'GAME_INSTALL_FAILED', message: msg.replace(/^GAME_INSTALL_FAILED:\s*/, '') });
      throw err;
    }
    fail('GAME_INSTALL_FAILED', `could not copy the mod into ${modDir(gamePath)}: ${msg}`);
  }
  const after = await detectStardew(env);
  onProgress({ stage: 'done', state: after });
  return after;
}

/** sha256 of a buffer (exported for the tests' fixture checks). */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/* ── Launch ──────────────────────────────────────────────────────────── */

/**
 * Start the game THROUGH SMAPI. Windows: StardewModdingAPI.exe in the game
 * folder (Steam's overlay/achievements need the launch option instead, see
 * steamLaunchOption). macOS/Linux: the `StardewValley` launcher the SMAPI
 * installer rewired, so the plain launcher already runs SMAPI.
 */
export function launcherPath(gamePath: string, platform: StardewInstallEnv['platform']): { exe: string; via: 'smapi-exe' | 'launcher' } {
  if (platform === 'win32') return { exe: path.join(gamePath, 'StardewModdingAPI.exe'), via: 'smapi-exe' };
  return { exe: path.join(gamePath, 'StardewValley'), via: 'launcher' };
}

export async function spawnGame(gamePath: string, platform: StardewInstallEnv['platform']): Promise<{ via: 'smapi-exe' | 'launcher' }> {
  const { exe, via } = launcherPath(gamePath, platform);
  if (!(await exists(exe))) throw new Error(`GAME_NOT_INSTALLED: ${exe} is missing; run the Stardew setup again`);
  const child = spawn(exe, [], { cwd: gamePath, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  return { via };
}
