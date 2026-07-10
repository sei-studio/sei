/**
 * Minecraft install scanner + bundled-Java locator.
 *
 * Two responsibilities:
 *
 *   1. `scanMcInstalls(opts?)` — walk known launcher / CurseForge directories
 *      on the current platform and return a list of `McInstall` records.
 *      Detects:
 *        - vanilla `.minecraft` on darwin / win32 / linux
 *        - CurseForge `Instances/<name>` subdirectories on darwin / win32
 *      For each install, parses:
 *        - mc_version (from launcher_profiles.json or minecraftinstance.json)
 *        - loader + loader_version (from versions/fabric-loader-*-* or
 *          minecraftinstance.json.baseModLoader.name)
 *        - csl_installed + csl_version (from mods/CustomSkinLoader*.jar)
 *        - sei_enabled (cross-referenced against persisted WizardState)
 *
 *   2. `findBundledJava(mcInstall)` — locate Minecraft's bundled JRE under
 *      `<mcDir>/runtime/java-runtime-gamma/<platform-tag>/...`.
 *      The Mojang launcher installs its own JRE there when the user first
 *      launches a vanilla profile; the wizard probes this BEFORE falling
 *      back to system PATH so we don't ask the user to install Java
 *      themselves. Returns the absolute exe path or null.
 *
 * Cross-platform path safety:
 *   - Every filesystem path is built via `path.join` — never string concat.
 *     The paths.ts audit established this as the cross-platform invariant;
 *     the regression-guard in the acceptance criteria counts `path.join`
 *     occurrences in this file.
 *   - `os.homedir()` resolves to `%USERPROFILE%` on Windows, no special-case
 *     needed (the cli/index.js electronUserDataDir pattern is mirrored here).
 *
 * Sources:
 *   - CONTEXT §"Cross-platform paths"
 *   - Hotspot audit: all paths via path.join
 *   - Mojang launcher docs §"Java runtime directory layout" (the
 *     `runtime/java-runtime-gamma/<platform-tag>/...` structure probed)
 *   - src/bot/cli/index.js L309-321 (platform-branched home-dir pattern)
 */
import crypto from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWizardState } from './wizardStateStore';
import type { McInstall } from '../shared/ipc';

const logger = {
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/** Hard cap on CurseForge subdirectories scanned per Instances dir (DoS guard). */
const MAX_CF_INSTANCES = 50;

/** Test-only optional opts (mainly for unit tests; production calls with no args). */
export interface ScanOpts {
  /** Override `os.homedir()` (e.g. a fixture dir in tests). */
  homedirOverride?: string;
  /** Override `process.platform` (e.g. simulate Windows on a mac CI host). */
  platformOverride?: NodeJS.Platform;
}

/* -------------------------------------------------------------------------- */
/*  Platform-branched candidate-path helpers                                   */
/* -------------------------------------------------------------------------- */

function homeDir(opts?: ScanOpts): string {
  return opts?.homedirOverride ?? os.homedir();
}

function platform(opts?: ScanOpts): NodeJS.Platform {
  return opts?.platformOverride ?? process.platform;
}

/** Windows %APPDATA% with env-var primary, homedir-fallback secondary. */
function appData(opts?: ScanOpts): string {
  return process.env.APPDATA ?? path.join(homeDir(opts), 'AppData', 'Roaming');
}

/**
 * Candidate vanilla `.minecraft` directories. Returns ALL possible paths
 * (typically one per platform); the caller stats each and skips ENOENT.
 */
function vanillaPaths(opts?: ScanOpts): string[] {
  const p = platform(opts);
  if (p === 'darwin') {
    return [path.join(homeDir(opts), 'Library', 'Application Support', 'minecraft')];
  }
  if (p === 'win32') {
    return [path.join(appData(opts), '.minecraft')];
  }
  if (p === 'linux') {
    return [path.join(homeDir(opts), '.minecraft')];
  }
  return [];
}

/**
 * Candidate Lunar Client install directories (260518-o1k D3).
 *   - darwin / linux: `~/.lunarclient`
 *   - win32:          BOTH `%USERPROFILE%\.lunarclient` AND
 *                     `%LOCALAPPDATA%\Programs\lunarclient` (the installer
 *                     uses the LOCALAPPDATA path; the `.lunarclient`
 *                     userprofile path is the runtime data dir created on
 *                     first launch — either being present is sufficient
 *                     to say "Lunar is installed here").
 *
 * Returns absolute candidate paths; caller stats each and skips ENOENT.
 * Every path constructed via `path.join` per cross-platform invariant.
 */
function lunarPaths(opts?: ScanOpts): string[] {
  const p = platform(opts);
  if (p === 'darwin' || p === 'linux') {
    return [path.join(homeDir(opts), '.lunarclient')];
  }
  if (p === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(homeDir(opts), 'AppData', 'Local');
    return [
      path.join(homeDir(opts), '.lunarclient'),
      path.join(localAppData, 'Programs', 'lunarclient'),
    ];
  }
  return [];
}

/**
 * Candidate CurseForge `Instances` roots. CurseForge ships two install
 * variants on Windows — Documents-rooted and home-rooted — so we probe
 * both. macOS has only one canonical path. Linux: CurseForge isn't
 * officially supported, return empty.
 */
function curseforgePaths(opts?: ScanOpts): string[] {
  const p = platform(opts);
  if (p === 'darwin') {
    return [
      path.join(homeDir(opts), 'Library', 'Application Support', 'curseforge', 'minecraft', 'Instances'),
    ];
  }
  if (p === 'win32') {
    return [
      path.join(homeDir(opts), 'curseforge', 'minecraft', 'Instances'),
      path.join(homeDir(opts), 'Documents', 'curseforge', 'minecraft', 'Instances'),
    ];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/*  ID hashing — stable across re-scans                                        */
/* -------------------------------------------------------------------------- */

/**
 * Stable 12-char hash of `${kind}:${absolutePath}`. Survives renames of the
 * Sei userData but breaks when the user actually moves the MC install — at
 * which point a fresh row is correct because the old path no longer exists.
 * 12 hex chars = 48 bits = collisions are infeasible for the handful of
 * installs a single user has.
 */
function idFor(kind: 'vanilla' | 'curseforge' | 'lunar', absPath: string): string {
  return crypto.createHash('sha1').update(`${kind}:${absPath}`).digest('hex').slice(0, 12);
}

/* -------------------------------------------------------------------------- */
/*  Loader + CSL detection helpers                                             */
/* -------------------------------------------------------------------------- */

/**
 * Detect Fabric Loader presence in a vanilla `<mcDir>/versions/` directory.
 * Returns the parsed loader version (group 1 of the regex) if present, else null.
 *
 * Vanilla launcher creates `fabric-loader-<loaderVer>-<mcVer>/` when Fabric
 * is installed against a given MC version. Example: `fabric-loader-0.16.5-1.20.1`.
 */
async function detectFabricLoader(mcDir: string): Promise<{ loaderVersion: string } | null> {
  const versionsDir = path.join(mcDir, 'versions');
  let entries: string[];
  try {
    entries = await fs.readdir(versionsDir);
  } catch (err) {
    if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`mcInstallScan: readdir ${versionsDir} failed: ${(err as Error).message}`);
    }
    return null;
  }
  // Match `fabric-loader-<loaderVer>-<mcVer>`. loaderVer is x.y.z (semver),
  // mcVer is x.y or x.y.z. We capture loaderVer in group 1.
  const re = /^fabric-loader-(\d+\.\d+\.\d+)-(\d+\.\d+(?:\.\d+)?)$/;
  for (const name of entries) {
    const m = re.exec(name);
    if (m) return { loaderVersion: m[1] };
  }
  return null;
}

/**
 * Detect CustomSkinLoader JAR in a `mods/` directory. Returns version (parsed
 * from filename) if a matching JAR is present, else null. ENOENT on the mods
 * dir means the loader hasn't created it yet — return null (not installed).
 */
async function detectCustomSkinLoader(
  modsDir: string,
): Promise<{ installed: boolean; version: string | null }> {
  let entries: string[];
  try {
    entries = await fs.readdir(modsDir);
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { installed: false, version: null };
    }
    logger.warn(`mcInstallScan: readdir ${modsDir} failed: ${(err as Error).message}`);
    return { installed: false, version: null };
  }
  // Case-insensitive match for `CustomSkinLoader-x.y.jar` or
  // `CustomSkinLoader_Fabric-x.y.z.jar` / `CustomSkinLoader_Forge-x.y.z.jar`.
  const nameRe = /^CustomSkinLoader[_-].*\.jar$/i;
  const versionRe = /CustomSkinLoader(?:_Fabric|_Forge)?-(\d+\.\d+(?:\.\d+)?)\.jar/i;
  for (const name of entries) {
    if (nameRe.test(name)) {
      const vm = versionRe.exec(name);
      return { installed: true, version: vm ? vm[1] : null };
    }
  }
  return { installed: false, version: null };
}

/* -------------------------------------------------------------------------- */
/*  Vanilla MC version detection                                               */
/* -------------------------------------------------------------------------- */

/**
 * Pull the most-recently-used MC version from `launcher_profiles.json`.
 * Mojang's launcher writes `selectedProfile` (legacy schema) OR records a
 * `lastUsed` timestamp on each profile (newer schema). Falls back to the
 * first profile with a `lastVersionId` if neither selector field is present.
 */
async function readVanillaMcVersion(mcDir: string): Promise<string | null> {
  const p = path.join(mcDir, 'launcher_profiles.json');
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = parsed as { selectedProfile?: unknown; profiles?: unknown };
  const profiles =
    obj.profiles && typeof obj.profiles === 'object' ? (obj.profiles as Record<string, unknown>) : {};

  // Newer schema: pick the profile with the most recent `lastUsed`.
  let bestId: string | null = null;
  let bestTs = -Infinity;
  for (const [id, entry] of Object.entries(profiles)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { lastUsed?: unknown; lastVersionId?: unknown };
    const ts = typeof e.lastUsed === 'string' ? Date.parse(e.lastUsed) : NaN;
    if (Number.isFinite(ts) && ts > bestTs && typeof e.lastVersionId === 'string') {
      bestTs = ts;
      bestId = id;
    }
  }
  if (bestId) {
    const e = profiles[bestId] as { lastVersionId?: unknown };
    if (typeof e.lastVersionId === 'string') {
      // `lastVersionId` may be `1.20.1` (vanilla), `fabric-loader-0.16.5-1.20.1`
      // (Fabric), or `latest-release`. Strip Fabric prefix; if it's a sentinel
      // like `latest-release`, leave it to the loader-detection path.
      const m = /-(\d+\.\d+(?:\.\d+)?)$/.exec(e.lastVersionId);
      if (m) return m[1];
      return /^\d+\.\d+/.test(e.lastVersionId) ? e.lastVersionId : null;
    }
  }

  // Legacy schema: `selectedProfile` is the key of the chosen profile.
  if (typeof obj.selectedProfile === 'string') {
    const e = profiles[obj.selectedProfile] as { lastVersionId?: unknown } | undefined;
    if (e && typeof e.lastVersionId === 'string') {
      const m = /-(\d+\.\d+(?:\.\d+)?)$/.exec(e.lastVersionId);
      if (m) return m[1];
      return /^\d+\.\d+/.test(e.lastVersionId) ? e.lastVersionId : null;
    }
  }

  // Last-resort fallback: first profile with a lastVersionId.
  for (const entry of Object.values(profiles)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { lastVersionId?: unknown };
    if (typeof e.lastVersionId === 'string') {
      const m = /-(\d+\.\d+(?:\.\d+)?)$/.exec(e.lastVersionId);
      if (m) return m[1];
      if (/^\d+\.\d+/.test(e.lastVersionId)) return e.lastVersionId;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  CurseForge instance parsing                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse a CurseForge `minecraftinstance.json` and pull mc_version + loader.
 * The file is the canonical source of truth for a CF instance (their app
 * writes it on every modpack install/update).
 *
 * `baseModLoader.name` is e.g.:
 *   - `forge-47.2.0` → loader=forge, loader_version=47.2.0
 *   - `fabric-loader-0.15.0-1.20.1` → loader=fabric, loader_version=0.15.0
 *   - empty / missing → null loader (rare; means the instance is vanilla
 *     under the CF launcher, possible but unusual)
 */
async function readCurseforgeInstance(instanceDir: string): Promise<{
  mc_version: string | null;
  loader: 'fabric' | 'forge' | null;
  loader_version: string | null;
}> {
  const p = path.join(instanceDir, 'minecraftinstance.json');
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return { mc_version: null, loader: null, loader_version: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { mc_version: null, loader: null, loader_version: null };
  }
  const obj = parsed as { gameVersion?: unknown; baseModLoader?: unknown };
  const mc_version = typeof obj.gameVersion === 'string' ? obj.gameVersion : null;

  let loader: 'fabric' | 'forge' | null = null;
  let loader_version: string | null = null;
  const bml = obj.baseModLoader as { name?: unknown } | null | undefined;
  if (bml && typeof bml === 'object' && typeof bml.name === 'string') {
    const name = bml.name;
    // Examples:
    //   forge-47.2.0
    //   fabric-loader-0.15.0-1.20.1
    //   neoforge-21.0.143   (treat as forge for our binary fabric/forge switch)
    let m = /^fabric-loader-(\d+\.\d+\.\d+)/.exec(name);
    if (m) {
      loader = 'fabric';
      loader_version = m[1];
    } else {
      m = /^(?:forge|neoforge)-([\d.]+)/.exec(name);
      if (m) {
        loader = 'forge';
        loader_version = m[1];
      }
    }
  }
  return { mc_version, loader, loader_version };
}

/* -------------------------------------------------------------------------- */
/*  Public: scanMcInstalls                                                     */
/* -------------------------------------------------------------------------- */

export async function scanMcInstalls(opts?: ScanOpts): Promise<McInstall[]> {
  const results: McInstall[] = [];
  const state = await loadWizardState();
  const enabledSet = new Set(state.enabledInstallIds);

  // ── Vanilla launcher candidates ────────────────────────────────────────
  for (const vp of vanillaPaths(opts)) {
    try {
      const st = await fs.stat(vp);
      if (!st.isDirectory()) continue;
    } catch (err) {
      if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`mcInstallScan: stat ${vp} failed: ${(err as Error).message}`);
      }
      continue;
    }

    try {
      const id = idFor('vanilla', vp);
      const mc_version = await readVanillaMcVersion(vp);
      const fabric = await detectFabricLoader(vp);
      // Vanilla installs place CSL in the ISOLATED Sei gameDir
      // (<.minecraft>/sei/mods), not the shared <.minecraft>/mods — the wizard
      // moved vanilla setups into <.minecraft>/sei/ (260518-o1k T4/T5) so the
      // user's normal profile stays untouched. Scanning only the shared mods
      // dir reported csl_installed=false for every freshly-set-up vanilla
      // install, which surfaced a false "1 install needs update" in Settings
      // right after a successful skin setup. Check the isolated gameDir first,
      // then fall back to the legacy shared mods dir for pre-isolation setups.
      let csl = await detectCustomSkinLoader(path.join(vp, 'sei', 'mods'));
      if (!csl.installed) {
        csl = await detectCustomSkinLoader(path.join(vp, 'mods'));
      }
      results.push({
        id,
        kind: 'vanilla',
        label: 'Vanilla Launcher',
        path: vp,
        mc_version,
        loader: fabric ? 'fabric' : null,
        loader_version: fabric?.loaderVersion ?? null,
        csl_installed: csl.installed,
        csl_version: csl.version,
        sei_enabled: enabledSet.has(id),
        compatibility: 'full',
      });
    } catch (err) {
      logger.warn(`mcInstallScan: vanilla scan at ${vp} failed: ${(err as Error).message}`);
    }
  }

  // ── CurseForge Instances candidates ────────────────────────────────────
  for (const cfRoot of curseforgePaths(opts)) {
    let entries: string[];
    try {
      entries = await fs.readdir(cfRoot);
    } catch (err) {
      if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`mcInstallScan: readdir ${cfRoot} failed: ${(err as Error).message}`);
      }
      continue;
    }
    // Hard cap to defend against an Instances dir somehow containing thousands
    // of entries (probably a symlink loop or a user with a wild modpack count).
    const slice = entries.slice(0, MAX_CF_INSTANCES);
    for (const name of slice) {
      const instanceDir = path.join(cfRoot, name);
      try {
        const st = await fs.stat(instanceDir);
        if (!st.isDirectory()) continue;
      } catch (err) {
        if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn(`mcInstallScan: stat ${instanceDir} failed: ${(err as Error).message}`);
        }
        continue;
      }
      try {
        const id = idFor('curseforge', instanceDir);
        const meta = await readCurseforgeInstance(instanceDir);
        const csl = await detectCustomSkinLoader(path.join(instanceDir, 'mods'));
        results.push({
          id,
          kind: 'curseforge',
          label: name,
          path: instanceDir,
          mc_version: meta.mc_version,
          loader: meta.loader,
          loader_version: meta.loader_version,
          csl_installed: csl.installed,
          csl_version: csl.version,
          sei_enabled: enabledSet.has(id),
          compatibility: 'full',
        });
      } catch (err) {
        logger.warn(`mcInstallScan: cf scan at ${instanceDir} failed: ${(err as Error).message}`);
      }
    }
  }

  // ── Lunar Client candidates (260518-o1k T3) ────────────────────────────
  // Read-only detection — we never write into Lunar's data directories. The
  // row is surfaced for UX transparency (D3 caption explains we can't drop
  // CSL into Lunar since it doesn't support custom skin mods). The wizard
  // orchestrator (T3 defensive early-return in processOneInstall + T7 UI
  // disabled checkbox) ensures we never attempt to install here.
  for (const vp of lunarPaths(opts)) {
    try {
      const st = await fs.stat(vp);
      if (!st.isDirectory()) continue;
    } catch (err) {
      if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`mcInstallScan: stat ${vp} failed: ${(err as Error).message}`);
      }
      continue;
    }
    try {
      const id = idFor('lunar', vp);
      results.push({
        id,
        kind: 'lunar',
        label: 'Lunar Client',
        path: vp,
        // We don't probe Lunar's mc_version — Lunar manages its own profiles
        // out-of-band and we wouldn't act on the value even if we read it.
        mc_version: null,
        loader: null,
        loader_version: null,
        // We never install CSL into Lunar; the badge stays false.
        csl_installed: false,
        csl_version: null,
        sei_enabled: false,
        compatibility: 'limited',
      });
    } catch (err) {
      logger.warn(`mcInstallScan: lunar scan at ${vp} failed: ${(err as Error).message}`);
    }
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/*  Public: findBundledJava                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Mojang's bundled-JRE component names, NEWEST FIRST. Each MC version pins
 * a specific component; the launcher installs one (or more) of these under
 * `<mcDir>/runtime/`:
 *   - `java-runtime-epsilon`  Java 21 (current — MC 1.21+)
 *   - `java-runtime-delta`    Java 21 (MC 1.20.5+ replacement for gamma)
 *   - `java-runtime-gamma`    Java 17 (MC 1.20.5+ original)
 *   - `java-runtime-beta`     Java 17 (MC 1.18 – 1.20.4)
 *   - `java-runtime-alpha`    Java 16 (MC 1.17)
 *   - `jre-legacy`            Java 8 (pre-1.17 — NOT sufficient for Fabric;
 *                              Fabric Loader requires Java 17. Listed last
 *                              for diagnostic completeness, but if a user's
 *                              MC is pre-1.17 we'll find nothing newer and
 *                              the system-PATH fallback in fabricInstaller
 *                              will surface the right error.)
 *
 * Probed in newest-first order so the wizard ALWAYS picks the freshest
 * available JRE (which satisfies any Fabric Loader version we'd install).
 */
const BUNDLED_JRE_COMPONENTS = [
  'java-runtime-epsilon',
  'java-runtime-delta',
  'java-runtime-gamma',
  'java-runtime-beta',
  'java-runtime-alpha',
  'jre-legacy',
] as const;

/**
 * Locate the Java runtime that Minecraft bundles inside its game directory.
 * Returns the absolute path to a runnable `java` / `javaw` executable, or
 * null if not present.
 *
 * Probed BEFORE system PATH — Minecraft installs its own JRE
 * under `<mcDir>/runtime/<component>/<platform-tag>/...`, and we should
 * use that to honor the "zero manual config" goal. If the user has
 * launched the vanilla profile even once, the bundled Java exists and the
 * wizard works WITHOUT requiring `java` on system PATH.
 *
 * Probe all known JRE components newest-first (see BUNDLED_JRE_COMPONENTS)
 * and return the first executable we find. A `gamma`-only probe was
 * empirically verified to MISS modern installs (which have `delta` +
 * `epsilon` but not `gamma`).
 *
 * Platform/arch mapping (verified against Mojang's launcher payloads):
 *   - darwin x64:   `<mcDir>/runtime/<component>/mac-os/<component>/jre.bundle/Contents/Home/bin/java`
 *   - darwin arm64: `<mcDir>/runtime/<component>/mac-os-arm64/<component>/jre.bundle/Contents/Home/bin/java`
 *   - win32 x64:    `<mcDir>\runtime\<component>\windows-x64\<component>\bin\javaw.exe` (fallback `java.exe`)
 *   - win32 arm64:  `<mcDir>\runtime\<component>\windows-arm64\<component>\bin\javaw.exe` (fallback `java.exe`)
 *   - linux:        `<mcDir>/runtime/<component>/linux/<component>/bin/java`
 *
 * Returns null on unsupported OS (e.g. freebsd) or when no bundled JRE
 * component is present (user has the launcher installed but never launched
 * a vanilla profile — common for CurseForge-only users).
 */
export async function findBundledJava(mcInstall: McInstall): Promise<string | null> {
  const arch = process.arch; // 'x64' | 'arm64' on mac/win; 'x64' on Linux
  const mcDir = mcInstall.path;

  // Candidate runtime ROOTS, most specific first. `<mcDir>/runtime` is the
  // documented layout, but on Windows two real launcher variants install the
  // JRE OUTSIDE the game dir (260709 report: "Minecraft clearly works" yet the
  // gameDir probe found nothing):
  //   - Microsoft Store / Xbox-app launcher →
  //     %LOCALAPPDATA%\Packages\Microsoft.4297127D64EC6_8wekyb3d8bbwe\LocalCache\Local\runtime
  //   - Legacy Win32 launcher → %ProgramFiles(x86)%\Minecraft Launcher\runtime
  const runtimeBases: string[] = [path.join(mcDir, 'runtime')];
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    runtimeBases.push(
      path.join(
        localAppData,
        'Packages',
        'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
        'LocalCache',
        'Local',
        'runtime',
      ),
      path.join(
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        'Minecraft Launcher',
        'runtime',
      ),
      // CurseForge app keeps a full Minecraft install (incl. runtime) under
      // its own dir — present even when the vanilla launcher was never run.
      path.join(os.homedir(), 'curseforge', 'minecraft', 'Install', 'runtime'),
    );
  } else if (process.platform === 'darwin') {
    runtimeBases.push(
      path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'curseforge',
        'minecraft',
        'Install',
        'runtime',
      ),
    );
  }

  for (const runtimeBase of runtimeBases) {
    const found = await findJavaUnderRuntimeBase(runtimeBase, arch);
    if (found) return found;
  }
  return null;
}

/** Probe one runtime root for any bundled JRE component (newest-first). */
async function findJavaUnderRuntimeBase(
  runtimeBase: string,
  arch: string,
): Promise<string | null> {
  // Walk components newest-first and return the first runnable exe found.
  for (const component of BUNDLED_JRE_COMPONENTS) {
    const componentRoot = path.join(runtimeBase, component);

    if (process.platform === 'darwin') {
      const archTag = arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
      // <runtime>/<component>/<archTag>/<component>/jre.bundle/Contents/Home/bin/java
      // java-runtime-gamma path layout still applies — only the component name varies.
      const abs = path.join(
        componentRoot,
        archTag,
        component,
        'jre.bundle',
        'Contents',
        'Home',
        'bin',
        'java',
      );
      try {
        await fs.access(abs, fsConstants.X_OK);
        return abs;
      } catch {
        continue;
      }
    } else if (process.platform === 'win32') {
      const archTag = arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
      // Prefer `javaw.exe` (no console window on Windows) over `java.exe`.
      // The Fabric installer is fully headless via -client mode args, so the
      // console window from java.exe is just noise.
      const javaw = path.join(componentRoot, archTag, component, 'bin', 'javaw.exe');
      try {
        await fs.access(javaw, fsConstants.X_OK);
        return javaw;
      } catch {
        // fall through to java.exe under this component
      }
      const javaExe = path.join(componentRoot, archTag, component, 'bin', 'java.exe');
      try {
        await fs.access(javaExe, fsConstants.X_OK);
        return javaExe;
      } catch {
        continue;
      }
    } else if (process.platform === 'linux') {
      const abs = path.join(componentRoot, 'linux', component, 'bin', 'java');
      try {
        await fs.access(abs, fsConstants.X_OK);
        return abs;
      } catch {
        continue;
      }
    } else {
      // Unsupported OS (e.g. freebsd) — bail immediately, don't loop further.
      return null;
    }
  }

  return null;
}
