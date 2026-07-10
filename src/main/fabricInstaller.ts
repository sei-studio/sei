/**
 * Fabric Loader headless installer.
 *
 * Three-step flow:
 *   1. Locate a runnable Java executable. Probes Minecraft's bundled JRE
 *      FIRST (under `<mcDir>/runtime/java-runtime-gamma/...`)
 *      then falls back to system PATH. If neither exists, throws
 *      FABRIC_INSTALL_FAILED with a corrected error message pointing the
 *      user at the launcher's bundled-Java install path — NOT asking the
 *      user to install Java themselves.
 *   2. Resolve the latest stable installer + loader versions from
 *      meta.fabricmc.net (two 30s-timeout HTTPS calls). If
 *      `opts.loaderVersion` is supplied, the loader-list call is skipped.
 *   3. Download the installer JAR from maven.fabricmc.net (60s timeout,
 *      AbortSignal-propagated), validate the ZIP magic, then `execFile`
 *      java with the installer's `client` mode (90s timeout, AbortSignal
 *      propagated — SIGTERM on cancel). On non-zero exit, surface stderr
 *      tail in the thrown error so the wizard UI can show a useful trace.
 *
 * Cross-cutting:
 *   - Every external call has a wall-clock timeout per CLAUDE.md.
 *   - AbortSignal threads from opts.signal through every fetch + execFile
 *     so the IPC cancel aborts in-flight work.
 *   - `execFile` not `exec` — arguments are an array, no shell
 *     interpolation possible.
 *   - The installer writes the Fabric entry to `launcher_profiles.json`
 *     so the user can pick it from the Minecraft launcher's profile
 *     dropdown on next launch.
 *
 * Sources:
 *   - Fabric meta API: https://meta.fabricmc.net/v2/versions/installer
 *   - Fabric loader API: https://meta.fabricmc.net/v2/versions/loader/<mc-version>
 *   - Fabric installer Maven: https://maven.fabricmc.net/net/fabricmc/fabric-installer/<v>/fabric-installer-<v>.jar
 *   - src/main/mcInstallScan.ts (findBundledJava — bundled-JRE probe)
 *   - src/main/personaExpansion.ts (30s timeout pattern)
 *   - src/bot/brain/storage/atomicWrite.js (atomic launcher_profiles.json write)
 */
import { execFile as execFileCb } from 'node:child_process';
import { promises as fs, constants as fsConstants, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { findBundledJava } from './mcInstallScan';
import { paths } from './paths';
import type { McInstall } from '../shared/ipc';

const execFile = promisify(execFileCb);

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

const USER_AGENT = 'sei-electron/0.1.0';
/** 30s for small JSON metadata responses. */
const META_TIMEOUT_MS = 30_000;
/** 60s for binary JAR downloads (installer JAR is ~300KB but slow links matter). */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** 90s for the `java -jar fabric-installer ...` exec — Fabric writes versions/<id>/ + libraries/ */
const INSTALLER_EXEC_TIMEOUT_MS = 90_000;
/** ZIP magic — first 4 bytes of every JAR file. */
const ZIP_MAGIC = [0x50, 0x4B, 0x03, 0x04] as const;

/* -------------------------------------------------------------------------- */
/*  HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Compose two AbortSignals: the wall-clock timeout AND the user-supplied
 * signal (the wizard cancel). If either fires, the underlying fetch
 * is aborted. Returns the composed signal + a cleanup that clears the timer.
 */
function composedAbort(
  timeoutMs: number,
  userSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  // Forward user signal aborts.
  const onUserAbort = () => ac.abort(userSignal?.reason ?? new Error('cancelled'));
  if (userSignal) {
    if (userSignal.aborted) {
      ac.abort(userSignal.reason ?? new Error('cancelled'));
    } else {
      userSignal.addEventListener('abort', onUserAbort, { once: true });
    }
  }
  return {
    signal: ac.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
    },
  };
}

async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const { signal: composed, cleanup } = composedAbort(timeoutMs, signal);
  try {
    const r = await fetch(url, {
      signal: composed,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    });
    if (!r.ok) {
      throw new Error(`FABRIC_INSTALL_FAILED: ${url} responded ${r.status}`);
    }
    return (await r.json()) as T;
  } finally {
    cleanup();
  }
}

async function fetchBytesWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const { signal: composed, cleanup } = composedAbort(timeoutMs, signal);
  try {
    const r = await fetch(url, {
      signal: composed,
      headers: { 'user-agent': USER_AGENT },
    });
    if (!r.ok) {
      throw new Error(`FABRIC_INSTALL_FAILED: ${url} responded ${r.status}`);
    }
    return Buffer.from(new Uint8Array(await r.arrayBuffer()));
  } finally {
    cleanup();
  }
}

/* -------------------------------------------------------------------------- */
/*  Public: findJavaExecutable (bundled-first probe)                            */
/* -------------------------------------------------------------------------- */

/**
 * Return an absolute path to a runnable Java executable. Probes the bundled
 * JRE inside the user's MC install FIRST; falls back to system
 * PATH only if the bundle is absent. Returns null when neither is available.
 *
 * The bundled-first probe is what makes the wizard work without the user
 * installing or configuring Java themselves — Minecraft's launcher already
 * installed a JRE for them when they first ran the vanilla profile.
 */
export async function findJavaExecutable(mcInstall: McInstall): Promise<string | null> {
  // 1) Bundled JRE under the known launcher runtime roots (gameDir, plus the
  //    Store-launcher and legacy-launcher locations on Windows).
  const bundled = await findBundledJava(mcInstall);
  if (bundled) {
    logger.info(`fabricInstaller: found bundled Java at ${bundled}`);
    return bundled;
  }
  // 2) System PATH fallback. `java -version` writes its banner to STDERR
  //    but exits 0 on success. Failing spawn (ENOENT) → catch → keep probing.
  try {
    await execFile('java', ['-version'], { timeout: 5_000 });
    logger.info('fabricInstaller: found `java` on system PATH');
    return 'java';
  } catch {
    /* fall through to the install-location probes */
  }
  // 3) JAVA_HOME. Set by most JDK installers; unlike PATH edits it is read
  //    fresh here, but note BOTH env probes share the Windows staleness
  //    caveat: a process's environment is frozen at launch, so a Java
  //    installed while Sei is running may still be invisible until restart.
  //    That's what probe 4 is for.
  const javaHome = process.env.JAVA_HOME;
  if (javaHome) {
    const exe = await firstRunnable(javaHomeBinCandidates(javaHome));
    if (exe) {
      logger.info(`fabricInstaller: found Java via JAVA_HOME at ${exe}`);
      return exe;
    }
  }
  // 4) Windows vendor install dirs (260709). A user who just installed Java
  //    has it on the on-disk standard paths even though this process's stale
  //    PATH can't see it ("installed Java, re-ran setup, still Java not
  //    found"). Scan the big vendor roots for jdk*/jre* subdirs, newest name
  //    first.
  if (process.platform === 'win32') {
    const exe = await findWindowsVendorJava();
    if (exe) {
      logger.info(`fabricInstaller: found installed Java at ${exe}`);
      return exe;
    }
  }
  // 5) Lunar Client's own bundled Zulu JREs (260709). A Lunar-only player has
  //    never run the vanilla launcher (no <mcDir>/runtime) and has no system
  //    Java, but Lunar always ships a JRE under ~/.lunarclient/jre. The Fabric
  //    installer is a plain Java 8+ jar, so any of Lunar's JREs can run it.
  const lunar = await findLunarJava();
  if (lunar) {
    logger.info(`fabricInstaller: found Lunar Client bundled Java at ${lunar}`);
    return lunar;
  }
  return null;
}

/**
 * Bounded search for a java executable under Lunar Client's JRE directory.
 * Layout varies by platform and Lunar version (e.g.
 * `<hash>/zulu17...win_x64/bin/javaw.exe` on Windows,
 * `<hash>/zulu17.../zulu-17.jre/Contents/Home/bin/java` on macOS), so walk
 * a few levels looking for a `bin/java(w)` rather than hardcoding one shape.
 */
async function findLunarJava(): Promise<string | null> {
  const root = path.join(os.homedir(), '.lunarclient', 'jre');
  const budget = { dirsLeft: 200 };
  return searchForJavaBin(root, 6, budget);
}

async function searchForJavaBin(
  dir: string,
  depth: number,
  budget: { dirsLeft: number },
): Promise<string | null> {
  if (depth < 0 || budget.dirsLeft <= 0) return null;
  budget.dirsLeft -= 1;
  const direct = await firstRunnable(javaHomeBinCandidates(dir));
  if (direct) return direct;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null; // dir absent/unreadable — normal for non-Lunar machines
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'bin' || entry.name.startsWith('.')) continue;
    const found = await searchForJavaBin(path.join(dir, entry.name), depth - 1, budget);
    if (found) return found;
  }
  return null;
}

/** Candidate java executables under a JDK/JRE home dir, preferred first. */
function javaHomeBinCandidates(home: string): string[] {
  if (process.platform === 'win32') {
    // javaw.exe preferred: no console window flash (see findBundledJava).
    return [path.join(home, 'bin', 'javaw.exe'), path.join(home, 'bin', 'java.exe')];
  }
  return [path.join(home, 'bin', 'java')];
}

/** First candidate that exists and is executable, or null. */
async function firstRunnable(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    try {
      await fs.access(c, fsConstants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Probe the standard Windows JDK vendor roots for an installed Java:
 * Oracle (`Program Files\Java`), Eclipse Adoptium/Temurin, and Microsoft
 * OpenJDK. Within each root, subdirs named jdk... or jre... are tried
 * newest-name-first (version-prefixed names sort correctly enough for
 * "pick the newest").
 */
async function findWindowsVendorJava(): Promise<string | null> {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const roots = [
    path.join(programFiles, 'Java'),
    path.join(programFiles, 'Eclipse Adoptium'),
    path.join(programFiles, 'Microsoft'),
  ];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue; // vendor root absent — normal
    }
    const jdks = entries
      .filter((e) => /^(jdk|jre)/i.test(e))
      .sort()
      .reverse();
    for (const dir of jdks) {
      const exe = await firstRunnable(javaHomeBinCandidates(path.join(root, dir)));
      if (exe) return exe;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Public: selectLatestFabricLoader                                           */
/* -------------------------------------------------------------------------- */

interface FabricInstallerMeta {
  /** Installer build version, e.g. "1.0.1". */
  version: string;
  /** True if this is the recommended stable build. */
  stable: boolean;
  /** Download URL — present on modern API responses. */
  url?: string;
  maven?: string;
}

interface FabricLoaderMeta {
  loader: {
    version: string;
    stable: boolean;
  };
  intermediary: { version: string; stable: boolean };
  launcherMeta: unknown;
}

/**
 * Resolve the recommended installer + loader versions from meta.fabricmc.net.
 * Picks the first `stable === true` entry (Fabric's meta API ships them
 * newest-first). Falls back to the first entry if none are marked stable
 * (transient state during release windows).
 */
export async function selectLatestFabricLoader(
  mcVersion: string,
  signal?: AbortSignal,
): Promise<{ installerVersion: string; loaderVersion: string }> {
  // 1) Installer version
  const installers = await fetchJsonWithTimeout<FabricInstallerMeta[]>(
    'https://meta.fabricmc.net/v2/versions/installer',
    META_TIMEOUT_MS,
    signal,
  );
  if (!Array.isArray(installers) || installers.length === 0) {
    throw new Error('FABRIC_INSTALL_FAILED: installer-list endpoint returned no versions');
  }
  const installerPick = installers.find((i) => i?.stable === true) ?? installers[0];
  if (!installerPick || typeof installerPick.version !== 'string') {
    throw new Error('FABRIC_INSTALL_FAILED: installer-list entry missing version');
  }

  // 2) Loader version, scoped to the requested MC version
  const loaders = await fetchJsonWithTimeout<FabricLoaderMeta[]>(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`,
    META_TIMEOUT_MS,
    signal,
  );
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error(`FABRIC_INSTALL_FAILED: no Fabric Loader available for MC ${mcVersion}`);
  }
  const loaderPick = loaders.find((l) => l?.loader?.stable === true) ?? loaders[0];
  if (!loaderPick?.loader?.version) {
    throw new Error('FABRIC_INSTALL_FAILED: loader-list entry missing version');
  }

  return {
    installerVersion: installerPick.version,
    loaderVersion: loaderPick.loader.version,
  };
}

/* -------------------------------------------------------------------------- */
/*  Public: installFabricLoader                                                */
/* -------------------------------------------------------------------------- */

export interface InstallFabricLoaderOpts {
  mcInstall: McInstall;
  mcVersion: string;
  /** Override loader pick (skips the meta-API loader-list call). */
  loaderVersion?: string;
  /** Progress callback — currently called at three milestones (0/30/90). */
  onProgress?: (pct: number) => void;
  /** Threaded through from main's Map<sessionId, AbortController>. */
  signal?: AbortSignal;
}

/**
 * Download + headlessly run the Fabric installer against the given vanilla
 * `.minecraft` directory. The installer creates
 * `<mcDir>/versions/fabric-loader-<loaderVer>-<mcVer>/` and the
 * corresponding library JARs under `<mcDir>/libraries/`.
 *
 * Throws `FABRIC_INSTALL_FAILED: <reason>` on any failure — the message is
 * routed to ERROR_COPY[FABRIC_INSTALL_FAILED] by classifyRendererError.
 */
export async function installFabricLoader(
  opts: InstallFabricLoaderOpts,
): Promise<{ loaderVersion: string; seiGameDir: string }> {
  const { mcInstall, mcVersion, onProgress, signal } = opts;

  // Pre-flight: cancel check before any network IO.
  if (signal?.aborted) {
    throw new Error('FABRIC_INSTALL_FAILED: cancelled');
  }

  // ── Java probe ────────────────────────────────────────────────────────
  const javaPath = await findJavaExecutable(mcInstall);
  if (!javaPath) {
    throw new Error(
      'FABRIC_INSTALL_FAILED: Java not found. Launch Minecraft once (vanilla profile) so it installs its bundled Java runtime, then re-run setup. If you installed Java yourself, restart Sei first so it can see the new install',
    );
  }

  // ── Resolve versions ──────────────────────────────────────────────────
  let loaderVersion = opts.loaderVersion;
  let installerVersion: string;
  if (loaderVersion) {
    // Still need the installer build; the user pinned the loader only.
    const meta = await selectLatestFabricLoader(mcVersion, signal);
    installerVersion = meta.installerVersion;
  } else {
    const meta = await selectLatestFabricLoader(mcVersion, signal);
    installerVersion = meta.installerVersion;
    loaderVersion = meta.loaderVersion;
  }
  onProgress?.(0);

  // ── Download installer JAR ────────────────────────────────────────────
  if (signal?.aborted) throw new Error('FABRIC_INSTALL_FAILED: cancelled');
  const installerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVersion}/fabric-installer-${installerVersion}.jar`;
  const installerBytes = await fetchBytesWithTimeout(installerUrl, DOWNLOAD_TIMEOUT_MS, signal);
  // ZIP magic check — JARs are ZIP archives.
  if (
    installerBytes.length < 4 ||
    installerBytes[0] !== ZIP_MAGIC[0] ||
    installerBytes[1] !== ZIP_MAGIC[1] ||
    installerBytes[2] !== ZIP_MAGIC[2] ||
    installerBytes[3] !== ZIP_MAGIC[3]
  ) {
    // PK ZIP magic 0x50, 0x4B, 0x03, 0x04 — installer download corrupt.
    throw new Error('FABRIC_INSTALL_FAILED: downloaded installer is not a valid JAR');
  }
  onProgress?.(30);

  // Write to <userData>/tmp/fabric-installer-<v>.jar
  const tmpDir = path.join(paths.userData(), 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const installerJarPath = path.join(tmpDir, `fabric-installer-${installerVersion}.jar`);
  await fs.writeFile(installerJarPath, installerBytes);

  // ── Run installer ─────────────────────────────────────────────────────
  if (signal?.aborted) {
    // Cleanup tmp before throwing.
    await fs.unlink(installerJarPath).catch(() => {});
    throw new Error('FABRIC_INSTALL_FAILED: cancelled');
  }

  // execFile (NOT exec) — arguments are an array, no shell interpolation.
  // The Fabric installer's `client` mode is fully headless:
  //   -dir       game directory (vanilla .minecraft) to install into
  //   -mcversion target MC version
  //   -loader    pinned loader build
  // The installer writes a profile entry into launcher_profiles.json so
  // the Fabric build shows up in the Minecraft launcher's dropdown.
  try {
    const { stdout, stderr } = await execFile(
      javaPath,
      [
        '-jar',
        installerJarPath,
        'client',
        '-dir',
        mcInstall.path,
        '-mcversion',
        mcVersion,
        '-loader',
        loaderVersion,
      ],
      {
        timeout: INSTALLER_EXEC_TIMEOUT_MS,
        signal,
        // Limit output buffer — installer prints ~50 lines.
        maxBuffer: 1024 * 1024,
      },
    );
    if (stdout) logger.info(`fabricInstaller: stdout: ${stdout.trim().slice(0, 500)}`);
    if (stderr) logger.warn(`fabricInstaller: stderr: ${stderr.trim().slice(0, 500)}`);
  } catch (err) {
    // Cleanup best-effort.
    await fs.unlink(installerJarPath).catch(() => {});
    const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string; killed?: boolean };
    const stderrTail = typeof e.stderr === 'string' ? e.stderr.slice(-512).trim() : '';
    if (e.killed && signal?.aborted) {
      throw new Error('FABRIC_INSTALL_FAILED: cancelled');
    }
    if (e.killed) {
      throw new Error(`FABRIC_INSTALL_FAILED: fabric installer exceeded ${INSTALLER_EXEC_TIMEOUT_MS}ms timeout`);
    }
    throw new Error(
      `FABRIC_INSTALL_FAILED: fabric installer exited ${e.code ?? 'unknown'}${stderrTail ? `: ${stderrTail}` : ''}`,
    );
  }
  onProgress?.(90);

  // ── Post-install confirmation ─────────────────────────────────────────
  const versionsDir = path.join(
    mcInstall.path,
    'versions',
    `fabric-loader-${loaderVersion}-${mcVersion}`,
  );
  try {
    const st = await fs.stat(versionsDir);
    if (!st.isDirectory()) {
      throw new Error('not a directory');
    }
  } catch (err) {
    await fs.unlink(installerJarPath).catch(() => {});
    throw new Error(
      `FABRIC_INSTALL_FAILED: post-install version directory missing at ${versionsDir} (${(err as Error).message})`,
    );
  }

  // Cleanup installer JAR (best-effort — leaving it is harmless but noisy).
  await fs.unlink(installerJarPath).catch(() => {});

  // ── Set up the Sei gameDir (260518-o1k T4) ────────────────────────────
  //
  // Vanilla launcher profiles by default have NO `gameDir`, which means
  // Fabric Loader loads every JAR in <.minecraft>/mods/ against the
  // profile's MC version. If the user has mismatched-version mods sitting
  // in that shared mods/ dir (the SkyHanni-1.8.9-with-Sei-1.21.4 repro
  // case), the launch crashes. We give the Sei profile its own isolated
  // gameDir at <.minecraft>/sei/ so it loads from there instead.
  //
  // Pre-create both the gameDir and its mods/ subdir before touching
  // launcher_profiles.json. The Mojang launcher tolerates a missing
  // gameDir (auto-creates) but explicit creation here is clearer + lets
  // T5 drop the CSL JAR into a pre-existing path without race.
  const seiGameDir = path.join(mcInstall.path, 'sei');
  await fs.mkdir(seiGameDir, { recursive: true });
  await fs.mkdir(path.join(seiGameDir, 'mods'), { recursive: true });

  // Rename the profile entry the Fabric installer added to launcher_profiles.json
  // ("fabric-loader-1.21.1" → "Sei") so it's obvious in the launcher dropdown
  // which profile is the Sei one. ALSO set gameDir to the isolated sei dir
  // so Fabric Loader doesn't load the shared mods/ folder.
  //
  // Best-effort: any failure here doesn't fail the install (the user can
  // rename/set-gameDir themselves from the launcher).
  //
  // Profile-key tightening (T4): we now look for an EXACT match on
  //   fabric-loader-<loaderVersion>-<mcVersion>
  // which is the key the Fabric installer just wrote. Falls back to the
  // previous prefix-match heuristic only if no exact match found, and
  // logs a warn in that case so we can diagnose Fabric installer version
  // drift.
  try {
    const profilesPath = path.join(mcInstall.path, 'launcher_profiles.json');
    const raw = await fs.readFile(profilesPath, 'utf-8');
    const parsed = JSON.parse(raw) as { profiles?: Record<string, { name?: string; gameDir?: string }> };
    if (parsed.profiles) {
      const expectedKey = `fabric-loader-${loaderVersion}-${mcVersion}`;
      const exactProf = parsed.profiles[expectedKey];
      if (exactProf) {
        exactProf.name = 'Sei';
        // Mojang launcher accepts both relative and absolute gameDir
        // strings. We write the absolute path because it's unambiguous
        // across launcher working-dir quirks (the launcher resolves
        // relative paths against its own CWD which varies per OS).
        exactProf.gameDir = seiGameDir;
      } else {
        // Fall back to the prefix-match heuristic and log so a future
        // installer-version bump that changes the key shape is visible.
        const presentKeys = Object.keys(parsed.profiles).slice(0, 6);
        logger.warn(
          `fabricInstaller: expected profile key '${expectedKey}' not found; ` +
          `falling back to prefix match. Present keys (first 6): ${JSON.stringify(presentKeys)}`,
        );
        for (const [key, prof] of Object.entries(parsed.profiles)) {
          if (
            (key.startsWith('fabric-loader-') ||
              (typeof prof.name === 'string' && prof.name.startsWith('fabric-loader-')))
          ) {
            prof.name = 'Sei';
            prof.gameDir = seiGameDir;
          }
        }
      }
      // 260705: launcher_profiles.json is the ONE file Sei writes that Sei
      // does NOT own — a torn write here destroys every launcher profile the
      // user has, not just Sei's, so it must go through tmp+rename like every
      // other config write in the codebase. Output stays byte-identical to
      // the old writeFile (no house trailing newline — Mojang's file, Sei
      // changes atomicity only).
      await atomicWrite(profilesPath, JSON.stringify(parsed, null, 2));
    }
  } catch (err) {
    logger.warn(`fabricInstaller: rename profile failed: ${(err as Error).message}`);
  }

  onProgress?.(100);
  return { loaderVersion, seiGameDir };
}
