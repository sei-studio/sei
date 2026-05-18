/**
 * Fabric Loader headless installer (Phase 9 Plan 04 Task 2B).
 *
 * Three-step flow:
 *   1. Locate a runnable Java executable. Probes Minecraft's bundled JRE
 *      FIRST (BLOCKER 3 — under `<mcDir>/runtime/java-runtime-gamma/...`)
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
 *     so Plan 05's IPC cancel (BLOCKER 2) aborts in-flight work.
 *   - `execFile` not `exec` — arguments are an array, no shell
 *     interpolation possible (T-09-E2 mitigation).
 *   - The `-noprofile` installer flag keeps `launcher_profiles.json`
 *     untouched; the user picks the Fabric profile manually on next
 *     launch (UI-SPEC §"4 — Done" copy).
 *
 * Sources:
 *   - 09-04-PLAN Task 2B
 *   - Fabric meta API: https://meta.fabricmc.net/v2/versions/installer
 *   - Fabric loader API: https://meta.fabricmc.net/v2/versions/loader/<mc-version>
 *   - Fabric installer Maven: https://maven.fabricmc.net/net/fabricmc/fabric-installer/<v>/fabric-installer-<v>.jar
 *   - src/main/mcInstallScan.ts (findBundledJava — BLOCKER 3 probe)
 *   - src/main/personaExpansion.ts (30s timeout pattern)
 */
import { execFile as execFileCb } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
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
 * signal (Plan 05's wizard cancel). If either fires, the underlying fetch
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
/*  Public: findJavaExecutable (BLOCKER 3 — bundled-first probe)               */
/* -------------------------------------------------------------------------- */

/**
 * Return an absolute path to a runnable Java executable. Probes the bundled
 * JRE inside the user's MC install FIRST (BLOCKER 3); falls back to system
 * PATH only if the bundle is absent. Returns null when neither is available.
 *
 * The bundled-first probe is what makes the wizard work without the user
 * installing or configuring Java themselves — Minecraft's launcher already
 * installed a JRE for them when they first ran the vanilla profile.
 */
export async function findJavaExecutable(mcInstall: McInstall): Promise<string | null> {
  // 1) Bundled JRE under <mcDir>/runtime/java-runtime-gamma/<platform-tag>/
  const bundled = await findBundledJava(mcInstall);
  if (bundled) {
    logger.info(`fabricInstaller: found bundled Java at ${bundled}`);
    return bundled;
  }
  // 2) System PATH fallback. `java -version` writes its banner to STDERR
  //    but exits 0 on success. Failing spawn (ENOENT) → catch → return null.
  try {
    await execFile('java', ['-version'], { timeout: 5_000 });
    logger.info('fabricInstaller: found `java` on system PATH');
    return 'java';
  } catch {
    return null;
  }
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
  /** Plan 05 threads this through from main's Map<sessionId, AbortController>. */
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
): Promise<{ loaderVersion: string }> {
  const { mcInstall, mcVersion, onProgress, signal } = opts;

  // Pre-flight: cancel check before any network IO.
  if (signal?.aborted) {
    throw new Error('FABRIC_INSTALL_FAILED: cancelled');
  }

  // ── Java probe (BLOCKER 3) ────────────────────────────────────────────
  const javaPath = await findJavaExecutable(mcInstall);
  if (!javaPath) {
    throw new Error(
      'FABRIC_INSTALL_FAILED: Java not found. Launch Minecraft once (vanilla profile) to install its bundled Java runtime, then re-run the wizard.',
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
  //   -noprofile skip writing launcher_profiles.json (user picks profile)
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
        '-noprofile',
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

  onProgress?.(100);
  return { loaderVersion };
}
