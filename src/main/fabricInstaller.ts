/**
 * Fabric Loader setup for a vanilla `.minecraft`, without Java.
 *
 * Normal path (R6, 260929): no installer jar, no Java.
 *   1. Pick the newest stable loader for the Minecraft version from Fabric
 *      meta (`/v2/versions/loader/<mc>`).
 *   2. Fetch the launcher version JSON Fabric meta already builds for the
 *      official launcher (`/v2/versions/loader/<mc>/<loader>/profile/json`).
 *      It `inheritsFrom` the vanilla version, so the launcher downloads the
 *      vanilla game (if missing) and every library on the first Play.
 *   3. Write `versions/<id>/<id>.json` ourselves, prefetch the few Fabric
 *      libraries best-effort (same as the Fabric installer does "in case the
 *      launcher fails"), and write the Sei profile into the launcher profile
 *      files (launcherProfiles.ts), selected via lastUsed.
 *   This is byte-for-byte what fabric-installer's ClientInstaller does.
 *
 * Fallback, ONLY when every Fabric meta mirror is unreachable: download the
 * installer jar and run it with Java (`client -noprofile`), then write the
 * launcher profile the same way. That is the only path that needs Java, so
 * a player without Java only ever hits it on a network failure.
 *
 * Cross-cutting:
 *   - Every external call has a wall-clock timeout per CLAUDE.md.
 *   - AbortSignal threads from opts.signal through every fetch + execFile
 *     so the IPC cancel aborts in-flight work.
 *   - `execFile` not `exec`: arguments are an array, no shell interpolation.
 *
 * Sources:
 *   - Fabric meta API: https://meta.fabricmc.net/v2/versions/loader/<mc>[/<loader>/profile/json]
 *   - fabric-installer ClientInstaller / ProfileInstaller / Reference (mirrors)
 *   - src/main/launcherProfiles.ts (launcher_profiles*.json read/write)
 *   - src/main/mcInstallScan.ts (findBundledJava, bundled-JRE probe)
 */
import { execFile as execFileCb } from 'node:child_process';
import { promises as fs, constants as fsConstants, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import {
  existingProfileFiles,
  LAUNCHER_PROFILE_FILES,
  readProfilesFile,
  seiGameDirFor,
  upsertSeiProfile,
  writeProfilesFile,
} from './launcherProfiles';
import { findBundledJava } from './mcInstallScan';
import { paths } from './paths';
import type { McInstall } from '../shared/ipc';

const execFile = promisify(execFileCb);

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

const USER_AGENT = 'sei-electron/0.1.0';
/** 60s for binary JAR downloads (installer JAR is ~300KB but slow links matter). */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** 90s for the fallback `java -jar fabric-installer ...` exec. */
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

async function fetchBytesWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const { signal: composed, cleanup } = composedAbort(timeoutMs, signal);
  try {
    const r = await fetchImpl(url, {
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
/*  Fabric meta (mirrored)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fabric's own mirror list (fabric-installer Reference.java). Each meta host
 * pairs with the maven host of the same number.
 */
export const FABRIC_MIRRORS: ReadonlyArray<{ meta: string; maven: string }> = [
  { meta: 'https://meta.fabricmc.net/', maven: 'https://maven.fabricmc.net/' },
  { meta: 'https://meta2.fabricmc.net/', maven: 'https://maven2.fabricmc.net/' },
  { meta: 'https://meta3.fabricmc.net/', maven: 'https://maven3.fabricmc.net/' },
];

/** Per-mirror timeout for the small meta JSON calls. */
const META_MIRROR_TIMEOUT_MS = 15_000;
/** Wall clock for the whole best-effort library prefetch. */
const LIBRARY_PREFETCH_BUDGET_MS = 60_000;

/**
 * Every Fabric meta mirror failed at the network level (DNS, TLS, timeout,
 * 5xx). This is the one condition that sends setup to the Java fallback.
 */
export class FabricMetaUnreachableError extends Error {
  constructor(detail: string) {
    super(`FABRIC_INSTALL_FAILED: could not reach Fabric servers (${detail})`);
    this.name = 'FabricMetaUnreachableError';
  }
}

function cancelled(): Error {
  return new Error('FABRIC_INSTALL_FAILED: cancelled');
}

/**
 * GET `<mirror.meta><pathAndQuery>` from each mirror in turn. A 4xx answer is
 * definitive (the version does not exist) and is thrown as-is; network
 * failures and 5xx move to the next mirror; when all mirrors fail this way,
 * throws FabricMetaUnreachableError.
 */
export async function fetchFabricMeta<T>(
  pathAndQuery: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: T; mirror: { meta: string; maven: string } }> {
  const failures: string[] = [];
  for (const mirror of FABRIC_MIRRORS) {
    if (signal?.aborted) throw cancelled();
    const url = mirror.meta + pathAndQuery;
    const { signal: composed, cleanup } = composedAbort(META_MIRROR_TIMEOUT_MS, signal);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        signal: composed,
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      });
    } catch (err) {
      cleanup();
      if (signal?.aborted) throw cancelled();
      failures.push(`${new URL(url).host}: ${(err as Error).message}`);
      continue;
    }
    try {
      if (res.status >= 500 || res.status === 429) {
        failures.push(`${new URL(url).host}: HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200).trim();
        throw new Error(
          `FABRIC_INSTALL_FAILED: Fabric meta ${pathAndQuery} responded ${res.status}${body ? `: ${body}` : ''}`,
        );
      }
      let data: T;
      try {
        data = (await res.json()) as T;
      } catch (err) {
        if (signal?.aborted) throw cancelled();
        // A captive portal or proxy page, not Fabric: try the next mirror.
        failures.push(`${new URL(url).host}: bad JSON (${(err as Error).message})`);
        continue;
      }
      return { data, mirror };
    } finally {
      cleanup();
    }
  }
  throw new FabricMetaUnreachableError(failures.join('; '));
}

interface FabricLoaderMeta {
  loader: { version: string; stable: boolean };
}

/**
 * Newest stable Fabric Loader for a Minecraft version (meta lists newest
 * first; falls back to the first entry when none is marked stable).
 */
export async function selectFabricLoaderVersion(
  mcVersion: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let data: FabricLoaderMeta[];
  try {
    ({ data } = await fetchFabricMeta<FabricLoaderMeta[]>(
      `v2/versions/loader/${encodeURIComponent(mcVersion)}`,
      signal,
      fetchImpl,
    ));
  } catch (err) {
    // Meta answers 400 [] for a Minecraft version it does not know.
    if (/ responded 4\d\d/.test((err as Error).message)) {
      throw new Error(`FABRIC_INSTALL_FAILED: no Fabric Loader available for Minecraft ${mcVersion}`);
    }
    throw err;
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`FABRIC_INSTALL_FAILED: no Fabric Loader available for Minecraft ${mcVersion}`);
  }
  const pick = data.find((l) => l?.loader?.stable === true) ?? data[0];
  if (!pick?.loader?.version || typeof pick.loader.version !== 'string') {
    throw new Error('FABRIC_INSTALL_FAILED: loader-list entry missing version');
  }
  return pick.loader.version;
}

/* -------------------------------------------------------------------------- */
/*  Launcher version JSON                                                      */
/* -------------------------------------------------------------------------- */

export interface FabricLibrary {
  name: string;
  url?: string;
  sha1?: string;
  size?: number;
  [key: string]: unknown;
}

export interface FabricLauncherProfileJson {
  id: string;
  inheritsFrom: string;
  mainClass: string;
  libraries: FabricLibrary[];
  [key: string]: unknown;
}

/** The version id Fabric uses (and meta returns) for a loader + MC pair. */
export function fabricVersionId(loaderVersion: string, mcVersion: string): string {
  return `fabric-loader-${loaderVersion}-${mcVersion}`;
}

/**
 * Check a meta profile JSON is the one we asked for before writing it into
 * the player's versions/ dir. Throws FABRIC_INSTALL_FAILED on mismatch.
 */
export function validateFabricProfileJson(
  json: unknown,
  mcVersion: string,
  loaderVersion: string,
): FabricLauncherProfileJson {
  const j = json as Partial<FabricLauncherProfileJson> | null;
  const expectedId = fabricVersionId(loaderVersion, mcVersion);
  const bad = (why: string) =>
    new Error(`FABRIC_INSTALL_FAILED: Fabric meta returned an unexpected profile (${why})`);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw bad('not an object');
  if (j.id !== expectedId) throw bad(`id ${String(j.id)}, expected ${expectedId}`);
  if (j.inheritsFrom !== mcVersion) throw bad(`inheritsFrom ${String(j.inheritsFrom)}`);
  if (typeof j.mainClass !== 'string' || !j.mainClass) throw bad('no mainClass');
  if (!Array.isArray(j.libraries) || j.libraries.length === 0) throw bad('no libraries');
  for (const lib of j.libraries) {
    if (!lib || typeof lib.name !== 'string' || lib.name.split(':').length < 3) {
      throw bad('library without a maven name');
    }
  }
  return j as FabricLauncherProfileJson;
}

/**
 * Write `versions/<id>/<id>.json` atomically. Removes a stale `<id>.jar`
 * like fabric-installer does (a zero-byte jar left by old installers makes
 * the launcher skip the inherited vanilla jar).
 */
export async function writeFabricVersionJson(
  mcDir: string,
  profile: FabricLauncherProfileJson,
): Promise<string> {
  const dir = path.join(mcDir, 'versions', profile.id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${profile.id}.json`);
  await atomicWriteText(file, JSON.stringify(profile, null, 2));
  await fs.unlink(path.join(dir, `${profile.id}.jar`)).catch(() => {});
  return file;
}

/** Relative maven path for `group:artifact:version`, as the launcher lays it out. */
export function libraryRelativePath(name: string): string | null {
  const parts = name.split(':');
  if (parts.length < 3) return null;
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) return null;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return [...group.split('.'), artifact, version, file].join('/');
}

/**
 * Best-effort download of the profile's libraries into `<mcDir>/libraries`.
 * The launcher fetches them on first Play anyway; this mirrors the Fabric
 * installer so a flaky launcher download does not break the first launch.
 * Never throws (except on cancel); returns how many files are in place.
 */
export async function prefetchFabricLibraries(
  mcDir: string,
  libraries: FabricLibrary[],
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; budgetMs?: number } = {},
): Promise<{ ok: number; failed: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.budgetMs ?? LIBRARY_PREFETCH_BUDGET_MS);
  let ok = 0;
  let failed = 0;
  for (const lib of libraries) {
    if (opts.signal?.aborted) throw cancelled();
    const rel = libraryRelativePath(lib.name);
    if (!rel) {
      failed++;
      continue;
    }
    const target = path.join(mcDir, 'libraries', ...rel.split('/'));
    if (await libraryPresent(target, lib)) {
      ok++;
      continue;
    }
    const bases = uniq([
      typeof lib.url === 'string' && lib.url ? withSlash(lib.url) : FABRIC_MIRRORS[0].maven,
      ...FABRIC_MIRRORS.map((m) => m.maven),
    ]);
    let done = false;
    for (const base of bases) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      try {
        const bytes = await fetchBytesWithTimeout(
          base + rel,
          Math.min(DOWNLOAD_TIMEOUT_MS, left),
          opts.signal,
          fetchImpl,
        );
        if (!isZip(bytes)) throw new Error('not a jar');
        if (typeof lib.sha1 === 'string' && sha1(bytes) !== lib.sha1.toLowerCase()) {
          throw new Error('sha1 mismatch');
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await atomicWriteBytes(target, bytes);
        done = true;
        break;
      } catch (err) {
        if (opts.signal?.aborted) throw cancelled();
        logger.warn(`fabricInstaller: prefetch ${lib.name} from ${base} failed: ${(err as Error).message}`);
      }
    }
    if (done) ok++;
    else failed++;
  }
  return { ok, failed };
}

async function libraryPresent(file: string, lib: FabricLibrary): Promise<boolean> {
  try {
    const bytes = await fs.readFile(file);
    if (typeof lib.sha1 === 'string') return sha1(bytes) === lib.sha1.toLowerCase();
    return isZip(bytes);
  } catch {
    return false;
  }
}

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

function isZip(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === ZIP_MAGIC[0] &&
    bytes[1] === ZIP_MAGIC[1] &&
    bytes[2] === ZIP_MAGIC[2] &&
    bytes[3] === ZIP_MAGIC[3]
  );
}

function withSlash(u: string): string {
  return u.endsWith('/') ? u : `${u}/`;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

async function atomicWriteText(file: string, text: string): Promise<void> {
  await atomicWrite(file, text);
}

async function atomicWriteBytes(file: string, bytes: Buffer): Promise<void> {
  await atomicWrite(file, bytes);
}

/* -------------------------------------------------------------------------- */
/*  Launcher profile entry                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Write the Sei profile into every launcher profile file in `mcDir`
 * (creating launcher_profiles.json when there is none). Throws only when no
 * file could be written; a single unreadable file is skipped with a warn.
 */
export async function writeSeiLauncherProfile(opts: {
  mcDir: string;
  mcVersion: string;
  versionId: string;
  profileName: string;
  gameDir: string;
  now?: Date;
}): Promise<{ files: string[]; key: string }> {
  const now = opts.now ?? new Date();
  let files = await existingProfileFiles(opts.mcDir);
  if (files.length === 0) files = [path.join(opts.mcDir, LAUNCHER_PROFILE_FILES[0])];
  const written: string[] = [];
  let key = '';
  const errors: string[] = [];
  for (const file of files) {
    try {
      const doc = (await readProfilesFile(file)) ?? { profiles: {}, settings: {}, version: 3 };
      const res = upsertSeiProfile(doc, {
        mcDir: opts.mcDir,
        mcVersion: opts.mcVersion,
        versionId: opts.versionId,
        profileName: opts.profileName,
        gameDir: opts.gameDir,
        now,
      });
      await writeProfilesFile(file, res.doc);
      written.push(file);
      key ||= res.key;
    } catch (err) {
      errors.push(`${path.basename(file)}: ${(err as Error).message}`);
      logger.warn(`fabricInstaller: could not write ${file}: ${(err as Error).message}`);
    }
  }
  if (written.length === 0) {
    throw new Error(`FABRIC_INSTALL_FAILED: could not write the launcher profile (${errors.join('; ')})`);
  }
  return { files: written, key };
}

/* -------------------------------------------------------------------------- */
/*  Public: installFabricLoader                                                */
/* -------------------------------------------------------------------------- */

export interface InstallFabricLoaderOpts {
  mcInstall: McInstall;
  mcVersion: string;
  /** Override loader pick (skips the meta loader-list call). */
  loaderVersion?: string;
  /**
   * 260916: one profile per Minecraft version. The launcher profile is
   * named `profileName` (default "Sei") and pointed at
   * `<.minecraft>/sei/<gameDirName>/` (default `<.minecraft>/sei/`, the
   * pre-260916 single dir). Each version needs its own dir because Fabric
   * loads every jar in mods/, and the skin mod is built per version.
   */
  profileName?: string;
  gameDirName?: string;
  /** Progress callback, 0..100. */
  onProgress?: (pct: number) => void;
  /** Threaded through from main's Map<sessionId, AbortController>. */
  signal?: AbortSignal;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Test seam: the Java fallback (defaults to runJavaInstallerFallback). */
  javaFallback?: typeof runJavaInstallerFallback;
}

/**
 * Install Fabric Loader into a vanilla `.minecraft` and create the Sei
 * launcher profile, selected so the launcher opens on it.
 *
 * Throws `FABRIC_INSTALL_FAILED: <reason>`; the message is routed to
 * ERROR_COPY[FABRIC_INSTALL_FAILED] by classifyRendererError.
 */
export async function installFabricLoader(
  opts: InstallFabricLoaderOpts,
): Promise<{ loaderVersion: string; seiGameDir: string; via: 'meta' | 'java' }> {
  const { mcInstall, mcVersion, onProgress, signal } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const profileName = opts.profileName ?? 'Sei';
  const mcDir = mcInstall.path;
  if (signal?.aborted) throw cancelled();

  const seiGameDir = opts.gameDirName ? seiGameDirFor(mcDir, opts.gameDirName) : path.join(mcDir, 'sei');

  let loaderVersion = opts.loaderVersion;
  let via: 'meta' | 'java' = 'meta';
  try {
    loaderVersion ??= await selectFabricLoaderVersion(mcVersion, signal, fetchImpl);
    onProgress?.(10);
    const { data } = await fetchFabricMeta<unknown>(
      `v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`,
      signal,
      fetchImpl,
    );
    const profile = validateFabricProfileJson(data, mcVersion, loaderVersion);
    onProgress?.(30);
    await writeFabricVersionJson(mcDir, profile);
    onProgress?.(40);
    const pre = await prefetchFabricLibraries(mcDir, profile.libraries, { signal, fetchImpl });
    logger.info(
      `fabricInstaller: wrote ${profile.id} from meta; prefetched ${pre.ok}/${profile.libraries.length} libraries` +
        (pre.failed ? ` (${pre.failed} left for the launcher)` : ''),
    );
  } catch (err) {
    if (!(err instanceof FabricMetaUnreachableError)) throw err;
    logger.warn(`fabricInstaller: ${err.message}; trying the Java installer fallback`);
    via = 'java';
    const fallback = opts.javaFallback ?? runJavaInstallerFallback;
    loaderVersion = await fallback({ mcInstall, mcVersion, loaderVersion, signal, cause: err });
  }
  onProgress?.(90);

  // Isolated game dir (260518-o1k T4): Fabric loads every jar in mods/, so a
  // shared <.minecraft>/mods with other-version mods would crash the launch.
  await fs.mkdir(path.join(seiGameDir, 'mods'), { recursive: true });

  const { files, key } = await writeSeiLauncherProfile({
    mcDir,
    mcVersion,
    versionId: fabricVersionId(loaderVersion, mcVersion),
    profileName,
    gameDir: seiGameDir,
  });
  logger.info(`fabricInstaller: profile '${key}' written to ${files.map((f) => path.basename(f)).join(', ')}`);

  onProgress?.(100);
  return { loaderVersion, seiGameDir, via };
}

/* -------------------------------------------------------------------------- */
/*  Java installer fallback (meta unreachable only)                            */
/* -------------------------------------------------------------------------- */

/**
 * Run fabric-installer with Java in `client -noprofile` mode (the profile is
 * written by writeSeiLauncherProfile afterwards). Only reached when every
 * Fabric meta mirror failed, so the installer (which also talks to Fabric
 * meta, through its own network stack) is a second opinion, not the plan.
 * Returns the loader version installed.
 */
export async function runJavaInstallerFallback(args: {
  mcInstall: McInstall;
  mcVersion: string;
  loaderVersion?: string;
  signal?: AbortSignal;
  cause: FabricMetaUnreachableError;
}): Promise<string> {
  const { mcInstall, mcVersion, signal, cause } = args;
  const javaPath = await findJavaExecutable(mcInstall);
  if (!javaPath) {
    // No Java and no Fabric servers: the fix is the network, not Java.
    throw new Error(
      `FABRIC_INSTALL_FAILED: could not reach the Fabric servers. Check your internet connection and try again. (${cause.message})`,
    );
  }

  // The installer jar is on the same maven hosts; any that answers will do.
  const installerVersion = await resolveInstallerVersion(signal);
  let bytes: Buffer | null = null;
  const failures: string[] = [];
  for (const m of FABRIC_MIRRORS) {
    if (signal?.aborted) throw cancelled();
    const url = `${m.maven}net/fabricmc/fabric-installer/${installerVersion}/fabric-installer-${installerVersion}.jar`;
    try {
      const b = await fetchBytesWithTimeout(url, DOWNLOAD_TIMEOUT_MS, signal);
      if (!isZip(b)) throw new Error('not a jar');
      bytes = b;
      break;
    } catch (err) {
      if (signal?.aborted) throw cancelled();
      failures.push(`${new URL(url).host}: ${(err as Error).message}`);
    }
  }
  if (!bytes) {
    throw new Error(
      `FABRIC_INSTALL_FAILED: could not reach the Fabric servers. Check your internet connection and try again. (${failures.join('; ')})`,
    );
  }

  const tmpDir = path.join(paths.userData(), 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const jar = path.join(tmpDir, `fabric-installer-${installerVersion}.jar`);
  await fs.writeFile(jar, bytes);
  const before = await fabricVersionDirs(mcInstall.path, mcVersion);
  try {
    const cli = ['-jar', jar, 'client', '-dir', mcInstall.path, '-mcversion', mcVersion, '-noprofile'];
    if (args.loaderVersion) cli.push('-loader', args.loaderVersion);
    const { stdout, stderr } = await execFile(javaPath, cli, {
      timeout: INSTALLER_EXEC_TIMEOUT_MS,
      signal,
      maxBuffer: 1024 * 1024,
    });
    if (stdout) logger.info(`fabricInstaller: stdout: ${stdout.trim().slice(0, 500)}`);
    if (stderr) logger.warn(`fabricInstaller: stderr: ${stderr.trim().slice(0, 500)}`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string; killed?: boolean };
    const tail = typeof e.stderr === 'string' ? e.stderr.slice(-512).trim() : '';
    if (signal?.aborted) throw cancelled();
    if (e.killed) {
      throw new Error(`FABRIC_INSTALL_FAILED: fabric installer exceeded ${INSTALLER_EXEC_TIMEOUT_MS}ms timeout`);
    }
    throw new Error(`FABRIC_INSTALL_FAILED: fabric installer exited ${e.code ?? 'unknown'}${tail ? `: ${tail}` : ''}`);
  } finally {
    await fs.unlink(jar).catch(() => {});
  }

  if (args.loaderVersion) {
    const dir = path.join(mcInstall.path, 'versions', fabricVersionId(args.loaderVersion, mcVersion));
    if (!(await isDir(dir))) {
      throw new Error(`FABRIC_INSTALL_FAILED: post-install version directory missing at ${dir}`);
    }
    return args.loaderVersion;
  }
  // No pinned loader: take the one the installer just created (or, when it
  // was already there, the newest present for this MC version).
  const after = await fabricVersionDirs(mcInstall.path, mcVersion);
  const created = after.filter((d) => !before.includes(d));
  const pick = (created.length ? created : after).sort(compareLoaderDirs).at(-1);
  if (!pick) {
    throw new Error(`FABRIC_INSTALL_FAILED: fabric installer did not create a version for ${mcVersion}`);
  }
  return pick.slice('fabric-loader-'.length, -(mcVersion.length + 1));
}

/** Installer build from meta if reachable, else a known-good pin. */
async function resolveInstallerVersion(signal?: AbortSignal): Promise<string> {
  try {
    const { data } = await fetchFabricMeta<Array<{ version: string; stable: boolean }>>(
      'v2/versions/installer',
      signal,
    );
    const pick = Array.isArray(data) ? (data.find((i) => i?.stable) ?? data[0]) : undefined;
    if (pick && typeof pick.version === 'string') return pick.version;
  } catch (err) {
    if (signal?.aborted) throw cancelled();
  }
  return FALLBACK_INSTALLER_VERSION;
}

/** Stable fabric-installer build as of 260929, used when meta is down. */
const FALLBACK_INSTALLER_VERSION = '1.1.2';

async function fabricVersionDirs(mcDir: string, mcVersion: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(mcDir, 'versions'));
    return entries.filter((e) => e.startsWith('fabric-loader-') && e.endsWith(`-${mcVersion}`));
  } catch {
    return [];
  }
}

function compareLoaderDirs(a: string, b: string): number {
  const na = a.split(/[.-]/).map((x) => Number(x) || 0);
  const nb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
