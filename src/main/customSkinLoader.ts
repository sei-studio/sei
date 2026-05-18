/**
 * CustomSkinLoader mod downloader + config writer (Phase 9 Plan 04 Task 2C).
 *
 * Two responsibilities:
 *
 *   1. `downloadCustomSkinLoader(opts)` — fetch the latest CSL Fabric or Forge
 *      JAR from Modrinth, falling back to GitHub Releases if Modrinth has no
 *      compatible build. Validates the JAR via ZIP magic before placing it
 *      into the target install's `mods/` directory atomically (rename, with
 *      EXDEV → copy+unlink fallback).
 *
 *   2. `writeCustomSkinLoaderConfig(opts)` — write the JSON config that tells
 *      CSL to fetch skins from Sei's loopback HTTP server. The config is
 *      placed at `<install>/config/CustomSkinLoader/CustomSkinLoader.json`
 *      atomically via `atomicWrite`.
 *
 *      LOADER TYPE = `Legacy` (WARNING 6 — Rule 1 deviation from PLAN):
 *
 *      The plan pinned `CustomSkinAPI`. Verification against the upstream
 *      CSL Java source (15-develop branch) shows that prediction was wrong:
 *
 *        - `CustomSkinAPI` is a JsonAPILoader subtype. CSL's
 *          `CustomSkinAPI.toJsonUrl(root, username)` returns
 *          `{root}{username}.json` — CSL expects a JSON document containing
 *          texture hash IDs, then makes a SECOND `GET {root}/textures/<id>`
 *          for the actual PNG. Our skin server (Plan 03) serves direct PNG
 *          bytes at `/skins/<username>.png` — no JSON intermediate.
 *
 *        - `Legacy` (the `LegacyLoader` class) takes a `skin` URL template
 *          containing `{USERNAME}`, substitutes the in-game username via
 *          `expandURL`, GETs the resulting URL, and treats the response as
 *          raw PNG bytes. This matches our skin server's `/skins/{USERNAME}.png`
 *          contract EXACTLY.
 *
 *      Shipping `CustomSkinAPI` would make the entire phase non-functional
 *      (CSL would GET `/skins/Sui.json`, get 404, never render the skin).
 *      The plan's WARNING 6 research-step machinery (`verify-csl-config-schema.mjs`)
 *      caught this mismatch — that's exactly what the research step was
 *      designed to do. See 09-04-SUMMARY.md §"Deviations from Plan" for the
 *      full reasoning trail.
 *
 *      Verified against:
 *        - Common/src/main/java/customskinloader/loader/LegacyLoader.java
 *        - Common/src/main/java/customskinloader/loader/jsonapi/CustomSkinAPI.java
 *        - Common/src/main/java/customskinloader/config/SkinSiteProfile.java
 *        - Common/src/main/java/customskinloader/config/Config.java
 *
 * Sources:
 *   - 09-04-PLAN Task 2C
 *   - Modrinth API: https://api.modrinth.com/v2/project/customskinloader/version
 *   - GitHub Releases fallback: https://api.github.com/repos/xfl03/MCCustomSkinLoader/releases/latest
 *   - src/bot/brain/storage/atomicWrite.js (atomic config writes)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { paths } from './paths';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

const USER_AGENT = 'sei-electron/0.1.0';
const META_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** ZIP magic — first 4 bytes of every JAR file. */
const ZIP_MAGIC = [0x50, 0x4B, 0x03, 0x04] as const;

/* -------------------------------------------------------------------------- */
/*  HTTP helpers (same pattern as fabricInstaller.ts)                          */
/* -------------------------------------------------------------------------- */

function composedAbort(
  timeoutMs: number,
  userSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
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
      throw new Error(`MOD_DOWNLOAD_FAILED: ${url} responded ${r.status}`);
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
      throw new Error(`MOD_DOWNLOAD_FAILED: ${url} responded ${r.status}`);
    }
    return Buffer.from(new Uint8Array(await r.arrayBuffer()));
  } finally {
    cleanup();
  }
}

/* -------------------------------------------------------------------------- */
/*  Modrinth + GitHub release types                                            */
/* -------------------------------------------------------------------------- */

interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
}

interface ModrinthVersion {
  id: string;
  name: string;
  version_number: string;
  loaders: string[];
  game_versions: string[];
  date_published: string;
  files: ModrinthVersionFile[];
}

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  assets: GithubReleaseAsset[];
}

/* -------------------------------------------------------------------------- */
/*  Public: isCustomSkinLoaderInstalled                                        */
/* -------------------------------------------------------------------------- */

/**
 * Detect a CustomSkinLoader JAR inside an existing `mods/` directory. Returns
 * `installed: true` + parsed version when a matching JAR is present. ENOENT
 * on the mods dir → not installed. Used by the wizard UI's "already installed"
 * badge and by the orchestrator's skip-redundant-download fast path.
 */
export async function isCustomSkinLoaderInstalled(
  modsDir: string,
): Promise<{ installed: boolean; version: string | null; jarPath: string | null }> {
  let entries: string[];
  try {
    entries = await fs.readdir(modsDir);
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { installed: false, version: null, jarPath: null };
    }
    logger.warn(`customSkinLoader: readdir ${modsDir} failed: ${(err as Error).message}`);
    return { installed: false, version: null, jarPath: null };
  }
  const nameRe = /^CustomSkinLoader[_-].*\.jar$/i;
  const versionRe = /CustomSkinLoader(?:_Fabric|_Forge)?-(\d+\.\d+(?:\.\d+)?)\.jar/i;
  for (const name of entries) {
    if (nameRe.test(name)) {
      const vm = versionRe.exec(name);
      return {
        installed: true,
        version: vm ? vm[1] : null,
        jarPath: path.join(modsDir, name),
      };
    }
  }
  return { installed: false, version: null, jarPath: null };
}

/* -------------------------------------------------------------------------- */
/*  Public: downloadCustomSkinLoader                                           */
/* -------------------------------------------------------------------------- */

export interface DownloadCustomSkinLoaderOpts {
  loaderKind: 'fabric' | 'forge';
  mcVersion: string;
  modsDir: string;
  /** Plan 05 threads abort signal here from main's Map<sessionId, AbortController>. */
  signal?: AbortSignal;
  /** Progress callback — currently called at 0/30/70/100 milestones. */
  onProgress?: (pct: number) => void;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve the freshest compatible CSL JAR for the given loader kind +
 * MC version. Tries Modrinth first (sorted newest-first by API); falls back
 * to xfl03/MCCustomSkinLoader's latest GitHub release if no Modrinth version
 * lists the requested loader/game_version combo.
 *
 * Throws `MOD_DOWNLOAD_FAILED: <reason>` on no-match / fetch failure.
 */
async function selectCslDownloadUrl(
  opts: DownloadCustomSkinLoaderOpts,
): Promise<{ url: string; filename: string; version: string }> {
  const { loaderKind, mcVersion, signal } = opts;

  // ── Modrinth (preferred) ──────────────────────────────────────────────
  try {
    const versions = await fetchJsonWithTimeout<ModrinthVersion[]>(
      'https://api.modrinth.com/v2/project/customskinloader/version',
      META_TIMEOUT_MS,
      signal,
    );
    if (Array.isArray(versions)) {
      const pick = versions.find(
        (v) =>
          Array.isArray(v.loaders) &&
          v.loaders.includes(loaderKind) &&
          Array.isArray(v.game_versions) &&
          v.game_versions.includes(mcVersion),
      );
      if (pick && Array.isArray(pick.files) && pick.files.length > 0) {
        const file = pick.files.find((f) => f.primary) ?? pick.files[0];
        if (typeof file.url === 'string' && typeof file.filename === 'string') {
          return {
            url: file.url,
            filename: file.filename,
            version: pick.version_number,
          };
        }
      }
    }
  } catch (err) {
    // Soft-fail Modrinth — try GitHub fallback.
    logger.warn(`customSkinLoader: Modrinth lookup failed: ${(err as Error).message}`);
  }

  // ── GitHub Releases (fallback) ────────────────────────────────────────
  try {
    const release = await fetchJsonWithTimeout<GithubRelease>(
      'https://api.github.com/repos/xfl03/MCCustomSkinLoader/releases/latest',
      META_TIMEOUT_MS,
      signal,
    );
    if (release && Array.isArray(release.assets)) {
      const wantPrefix = `CustomSkinLoader_${capitalize(loaderKind)}-`;
      const asset = release.assets.find(
        (a) => typeof a.name === 'string' && a.name.startsWith(wantPrefix) && a.name.endsWith('.jar'),
      );
      if (asset) {
        // Parse the version off the asset name (CustomSkinLoader_Fabric-14.20.jar).
        const m = /-([\d.]+)\.jar$/i.exec(asset.name);
        return {
          url: asset.browser_download_url,
          filename: asset.name,
          version: m ? m[1] : release.tag_name,
        };
      }
    }
  } catch (err) {
    throw new Error(`MOD_DOWNLOAD_FAILED: GitHub fallback failed: ${(err as Error).message}`);
  }

  throw new Error(
    `MOD_DOWNLOAD_FAILED: no compatible CustomSkinLoader release found for ${opts.mcVersion} ${opts.loaderKind}`,
  );
}

export async function downloadCustomSkinLoader(
  opts: DownloadCustomSkinLoaderOpts,
): Promise<{ jarPath: string; version: string }> {
  const { loaderKind, modsDir, signal, onProgress } = opts;

  if (signal?.aborted) {
    throw new Error('MOD_DOWNLOAD_FAILED: cancelled');
  }

  // ── Pick a URL ────────────────────────────────────────────────────────
  const pick = await selectCslDownloadUrl(opts);
  onProgress?.(30);

  // ── Download ──────────────────────────────────────────────────────────
  if (signal?.aborted) throw new Error('MOD_DOWNLOAD_FAILED: cancelled');
  const bytes = await fetchBytesWithTimeout(pick.url, DOWNLOAD_TIMEOUT_MS, signal);
  // ZIP magic check — JARs are ZIP archives.
  if (
    bytes.length < 4 ||
    bytes[0] !== ZIP_MAGIC[0] ||
    bytes[1] !== ZIP_MAGIC[1] ||
    bytes[2] !== ZIP_MAGIC[2] ||
    bytes[3] !== ZIP_MAGIC[3]
  ) {
    // PK ZIP magic 0x50, 0x4B, 0x03, 0x04 — JAR download corrupt.
    throw new Error('MOD_DOWNLOAD_FAILED: downloaded JAR is corrupt');
  }
  onProgress?.(70);

  // ── Write to tmp, then atomic rename into modsDir ─────────────────────
  await fs.mkdir(modsDir, { recursive: true });
  const tmpDir = path.join(paths.userData(), 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  // Canonical filename: `CustomSkinLoader_<Kind>-<version>.jar` (Fabric/Forge),
  // matching what xfl03 ships. We prefer the Modrinth/GitHub-provided filename
  // if it already matches that shape.
  const wantNameRe = /^CustomSkinLoader_(?:Fabric|Forge)-[\d.]+\.jar$/i;
  const finalName = wantNameRe.test(pick.filename)
    ? pick.filename
    : `CustomSkinLoader_${capitalize(loaderKind)}-${pick.version}.jar`;

  const tmpJarPath = path.join(tmpDir, `csl-pending-${Date.now()}.jar`);
  await fs.writeFile(tmpJarPath, bytes);

  const finalPath = path.join(modsDir, finalName);
  try {
    await fs.rename(tmpJarPath, finalPath);
  } catch (err) {
    // EXDEV: tmp lives on a different filesystem than the target mods/ dir
    // (common when <userData> and the MC install are on different drives on
    // Windows). Fall back to copy + unlink.
    if (err && (err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.copyFile(tmpJarPath, finalPath);
      await fs.unlink(tmpJarPath).catch(() => {});
    } else {
      // Cleanup tmp before rethrowing.
      await fs.unlink(tmpJarPath).catch(() => {});
      throw err;
    }
  }
  onProgress?.(100);
  logger.info(`customSkinLoader: placed ${finalPath} (version ${pick.version})`);
  return { jarPath: finalPath, version: pick.version };
}

/* -------------------------------------------------------------------------- */
/*  Public: writeCustomSkinLoaderConfig                                        */
/* -------------------------------------------------------------------------- */

export interface WriteCustomSkinLoaderConfigOpts {
  mcInstallDir: string;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  loaderKind: 'fabric' | 'forge';
  /** e.g. 'http://127.0.0.1:54321' — no trailing slash. */
  skinServerBaseUrl: string;
}

/**
 * Build + atomic-write the CSL config JSON at
 * `<install>/config/CustomSkinLoader/CustomSkinLoader.json`. The path is the
 * canonical location for modern Fabric AND Forge CSL builds (CSL writes its
 * own config there on first launch; pre-seeding it here means our entry
 * lands in the loadlist with priority 0 — the user doesn't have to touch it).
 *
 * Loader-type rationale: see file header. Short version: `Legacy` is the
 * verified-correct loader for a literal-URL backend serving PNG bytes.
 * `CustomSkinAPI` would require us to also serve JSON metadata at
 * `/<username>.json` and a separate texture endpoint — neither of which our
 * skin server does.
 *
 * Returns the absolute config path so callers can log it for debugging.
 */
export async function writeCustomSkinLoaderConfig(
  opts: WriteCustomSkinLoaderConfigOpts,
): Promise<{ configPath: string }> {
  const { mcInstallDir, skinServerBaseUrl } = opts;

  // Trim a trailing slash off the base URL so we don't end up with double
  // slashes in the substituted URL. Skin server returns the URL with no slash
  // already, but defensive trim costs nothing.
  const base = skinServerBaseUrl.replace(/\/+$/, '');

  // ── Schema (per upstream config classes — see file header) ────────────
  //
  //  Loadlist entry fields used:
  //    - name          arbitrary identifier (CSL identifies entries by name)
  //    - type          loader type — must be the canonical CSL identifier
  //                    `Legacy` (NOT `CustomSkinAPI` — see file header note)
  //    - skin          URL template; CSL substitutes `{USERNAME}` at fetch
  //                    time and expects raw PNG bytes back
  //    - checkPNG      true → CSL validates the response is PNG-magic-prefixed
  //                    (defense-in-depth; aligns with skinServer's response)
  //    - model         "auto" → let CSL detect classic vs slim from the PNG
  //                    metadata; vanilla 64×64 skins are classic-shaped
  //
  //  Top-level config fields:
  //    - loadlist                — array of entries; ours is sole entry
  //    - enableTransparentSkin   — render translucent pixels correctly
  //    - enableUpdateSkull       — refresh head models when skin changes
  //    - enableLocalProfileCache — false: user expects fresh skin after editor
  //                                changes; caching would show a stale skin
  //                                between sessions
  //    - enableCacheAutoClean    — true: clean cache directory on startup
  //                                (paired with localProfileCache=false)
  //
  //  We intentionally omit `version` and `buildNumber`. CSL's Config.loadConfig0
  //  rewrites them to the current installed version on first launch — no
  //  benefit to hardcoding a stale value here, and a stale value triggers
  //  CSL's "config out of date" log spam.
  const cfg = {
    loadlist: [
      {
        // Schema verified via Task 2A research step.
        // Loader type is `Legacy` per upstream LegacyLoader.java (literal
        // `{USERNAME}` substitution → PNG bytes). The Task 2A script
        // verifies this against the upstream Java source on every run.
        name: 'SeiLocal',
        type: 'Legacy',
        skin: `${base}/skins/{USERNAME}.png`,
        checkPNG: true,
        model: 'auto',
      },
    ],
    enableTransparentSkin: true,
    enableUpdateSkull: true,
    enableLocalProfileCache: false,
    enableCacheAutoClean: true,
  };

  const configDir = path.join(mcInstallDir, 'config', 'CustomSkinLoader');
  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, 'CustomSkinLoader.json');
  await atomicWrite(configPath, JSON.stringify(cfg, null, 2) + '\n');
  logger.info(`customSkinLoader: wrote ${configPath}`);
  return { configPath };
}
