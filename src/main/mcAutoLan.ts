/**
 * Sei Auto LAN mod installer (260929).
 *
 * The one step a Minecraft player repeated every session was Esc > Open to
 * LAN > Start LAN World (LAN_NOT_OPEN, the outside-app-steps research R1a).
 * Sei ships a tiny Fabric mod of its own, `sei-autolan`
 * (native/minecraft-autolan-mod), that opens a singleplayer world to LAN once
 * it has loaded. It does nothing on multiplayer servers or Realms. This
 * module puts the right build of it into every "Sei <version>" launcher
 * profile's own mods folder, next to CustomSkinLoader.
 *
 * Jars. The mod is built once per range of Minecraft releases that link
 * against Minecraft identically (scripts/build-minecraft-autolan-mod.mjs), and
 * shipped with the app under `<resources>/minecraft-autolan/` (dev:
 * `<repo>/assets/minecraft-autolan/`) with a manifest.json listing each jar's
 * [minMc, maxMcExclusive) range. Each jar's fabric.mod.json declares the same
 * range, so a jar in the wrong profile would make Fabric refuse to launch;
 * that is why a profile whose version no jar covers gets its old copy
 * REMOVED rather than kept.
 *
 * When it runs:
 *   - wizard.ts, right after CustomSkinLoader lands in a vanilla Sei profile.
 *   - index.ts at startup (`syncAutoLanForSeiProfiles`), fire-and-forget, so
 *     players who set up a profile before this shipped get the mod on their
 *     next Sei launch without re-running setup, and an app update that ships
 *     a new jar replaces the old one. A profile whose jar is already current
 *     (same file name and bytes) is not touched.
 *
 * Only Sei's own profiles are touched: a launcher profile counts when its
 * gameDir is `<.minecraft>/sei` or inside it, which only Sei's installer
 * creates. CurseForge instances and the player's other profiles never get
 * the mod, so the LAN_NOT_OPEN guidance still applies there.
 *
 * `UserConfig.mc_auto_lan === false` turns the feature off: the sync then
 * removes the jar from every Sei profile. Absent means on. No UI yet.
 *
 * Everything here is best-effort and never throws to its caller: a missing
 * manifest, an unreadable launcher file or a locked jar (Windows, game
 * running) is logged and skipped. The player can still open to LAN by hand.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compareMcVersions } from '../shared/mcSetup';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/** Every sei-autolan jar Sei has ever placed, any version. */
export const AUTOLAN_JAR_RE = /^sei-autolan[-+_].*\.jar$/i;

export interface AutoLanJar {
  file: string;
  /** Inclusive. */
  minMc: string;
  /** Exclusive. */
  maxMcExclusive: string;
  /** Releases the build script compiled and checked this jar against. */
  verified?: string[];
  sha256: string;
}

export interface AutoLanManifest {
  modId: string;
  modVersion: string;
  jars: AutoLanJar[];
}

/** A release version string ("1.21.1", "26.3"). Snapshots never match a jar. */
const RELEASE_RE = /^\d+\.\d+(?:\.\d+)?$/;

/** The jar whose [minMc, maxMcExclusive) range holds `mcVersion`, if any. */
export function pickAutoLanJar(manifest: AutoLanManifest, mcVersion: string): AutoLanJar | null {
  if (!RELEASE_RE.test(mcVersion)) return null;
  for (const jar of manifest.jars) {
    if (
      compareMcVersions(mcVersion, jar.minMc) >= 0 &&
      compareMcVersions(mcVersion, jar.maxMcExclusive) < 0
    ) {
      return jar;
    }
  }
  return null;
}

/** Where the jars + manifest live: extraResources when packaged, the repo in dev. */
export async function defaultAutoLanAssetsDir(): Promise<string> {
  const { app } = await import('electron');
  return app.isPackaged
    ? path.join(process.resourcesPath, 'minecraft-autolan')
    : path.join(app.getAppPath(), 'assets', 'minecraft-autolan');
}

export async function readAutoLanManifest(assetsDir: string): Promise<AutoLanManifest | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(assetsDir, 'manifest.json'), 'utf8'),
    ) as AutoLanManifest;
    if (!parsed || !Array.isArray(parsed.jars)) return null;
    return parsed;
  } catch (err) {
    logger.warn(`autolan: no manifest in ${assetsDir}: ${(err as Error).message}`);
    return null;
  }
}

export type AutoLanInstallStatus =
  /** The matching jar was copied in (and any older copy removed). */
  | 'installed'
  /** The matching jar was already there, byte for byte. */
  | 'current'
  /** No jar covers this version, or the feature is off: any copy was removed. */
  | 'removed'
  /** Nothing to do and nothing there (off / unsupported, no old copy). */
  | 'absent'
  /** The shipped assets are missing or a file operation failed. */
  | 'failed';

export interface InstallAutoLanOpts {
  modsDir: string;
  mcVersion: string;
  assetsDir: string;
  /** Default true. False removes the mod. */
  enabled?: boolean;
  /** Pre-read manifest (the startup sync reads it once for every profile). */
  manifest?: AutoLanManifest | null;
}

async function sha256Of(file: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex');
  } catch {
    return null;
  }
}

async function listAutoLanJars(modsDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(modsDir)).filter((n) => AUTOLAN_JAR_RE.test(n));
  } catch {
    return [];
  }
}

async function removeJars(modsDir: string, names: string[]): Promise<number> {
  return (await removeJarsDetailed(modsDir, names)).removed;
}

/** `failed` counts copies still on disk (e.g. locked by a running game on Windows). */
async function removeJarsDetailed(
  modsDir: string,
  names: string[],
): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    try {
      await fs.unlink(path.join(modsDir, name));
      removed += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed += 1;
        logger.warn(`autolan: could not remove ${name}: ${(err as Error).message}`);
      }
    }
  }
  return { removed, failed };
}

/**
 * Make `modsDir` hold exactly the sei-autolan jar for `mcVersion` (or none).
 * Never throws.
 */
export async function installAutoLanMod(opts: InstallAutoLanOpts): Promise<{
  status: AutoLanInstallStatus;
  file?: string;
}> {
  const { modsDir, mcVersion, assetsDir } = opts;
  try {
    const existing = await listAutoLanJars(modsDir);

    if (opts.enabled === false) {
      const n = await removeJars(modsDir, existing);
      return { status: n > 0 ? 'removed' : 'absent' };
    }

    const manifest =
      opts.manifest !== undefined ? opts.manifest : await readAutoLanManifest(assetsDir);
    if (!manifest) return { status: 'failed' };

    const jar = pickAutoLanJar(manifest, mcVersion);
    if (!jar) {
      // A jar for another version would stop Fabric from launching at all.
      const n = await removeJars(modsDir, existing);
      if (n > 0) logger.info(`autolan: no build for Minecraft ${mcVersion}; removed ${n} old jar(s) from ${modsDir}`);
      return { status: n > 0 ? 'removed' : 'absent' };
    }

    const finalPath = path.join(modsDir, jar.file);
    const others = existing.filter((n) => n !== jar.file);
    if (existing.includes(jar.file) && (await sha256Of(finalPath)) === jar.sha256) {
      await removeJars(modsDir, others);
      return { status: 'current', file: jar.file };
    }

    const bytes = await fs.readFile(path.join(assetsDir, jar.file));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== jar.sha256) {
      logger.warn(`autolan: shipped ${jar.file} does not match its manifest hash; not installing`);
      return { status: 'failed' };
    }

    // Stage under a name Fabric ignores (not .jar), then rename into place, so
    // a crash mid-write never leaves a truncated jar that breaks the launch.
    // Old copies go only after the new one is in place.
    await fs.mkdir(modsDir, { recursive: true });
    const staged = path.join(modsDir, `.${jar.file}.${process.pid}.tmp`);
    await fs.writeFile(staged, bytes);
    try {
      await fs.rename(staged, finalPath);
    } catch (err) {
      await fs.unlink(staged).catch(() => {});
      throw err;
    }
    const { failed } = await removeJarsDetailed(modsDir, others);
    if (failed > 0) {
      // An old copy is still there (Windows keeps a running game's jars
      // locked). Two jars with the same mod id stop Fabric from launching, so
      // take the new one back out and leave the old one, which still matches
      // this profile's version. The next sync (game closed) replaces it.
      await fs.unlink(finalPath).catch(() => {});
      logger.warn(`autolan: old copy in ${modsDir} is locked; kept it and did not place ${jar.file}`);
      return { status: 'failed' };
    }
    logger.info(`autolan: placed ${jar.file} for Minecraft ${mcVersion} in ${modsDir}`);
    return { status: 'installed', file: jar.file };
  } catch (err) {
    logger.warn(`autolan: install into ${modsDir} failed: ${(err as Error).message}`);
    return { status: 'failed' };
  }
}

/* -------------------------------------------------------------------------- */
/*  Sei profiles in launcher_profiles.json                                    */
/* -------------------------------------------------------------------------- */

export interface SeiProfile {
  gameDir: string;
  mcVersion: string;
}

/**
 * The Fabric launcher profiles Sei built in this `.minecraft`: gameDir at or
 * under `<mcDir>/sei` (the 260916 per-version dirs and the older single
 * `<mcDir>/sei`), lastVersionId `fabric-loader-<loader>-<mc>`. Empty when the
 * launcher file is missing or unreadable.
 */
export async function findSeiProfiles(mcDir: string): Promise<SeiProfile[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(mcDir, 'launcher_profiles.json'), 'utf8'));
  } catch {
    return [];
  }
  const profiles = (parsed as { profiles?: unknown })?.profiles;
  if (!profiles || typeof profiles !== 'object') return [];
  const seiRoot = path.resolve(mcDir, 'sei');
  const re = /^fabric-loader-[^-]+-(.+)$/;
  const out: SeiProfile[] = [];
  for (const entry of Object.values(profiles as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { lastVersionId?: unknown; gameDir?: unknown };
    if (typeof e.gameDir !== 'string' || !e.gameDir.trim()) continue;
    const m = typeof e.lastVersionId === 'string' ? re.exec(e.lastVersionId) : null;
    if (!m) continue;
    const gameDir = path.resolve(mcDir, e.gameDir);
    const rel = path.relative(seiRoot, gameDir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    // Distinct (gameDir, version) pairs: two profiles may share one dir (the
    // pre-260916 single `<mcDir>/sei`), and the sync must see both versions.
    if (!out.some((p) => p.gameDir === gameDir && p.mcVersion === m[1])) {
      out.push({ gameDir, mcVersion: m[1] });
    }
  }
  return out;
}

export interface SyncAutoLanOpts {
  /** Vanilla `.minecraft` directories to look in. */
  mcDirs: string[];
  assetsDir: string;
  enabled?: boolean;
}

/**
 * Bring every Sei profile's mods folder in line with the shipped jars.
 * Returns one result per profile touched. Never throws.
 */
export async function syncAutoLanForSeiProfiles(opts: SyncAutoLanOpts): Promise<
  Array<SeiProfile & { status: AutoLanInstallStatus; file?: string }>
> {
  const enabled = opts.enabled !== false;
  const manifest = enabled ? await readAutoLanManifest(opts.assetsDir) : null;
  if (enabled && !manifest) return [];
  const results: Array<SeiProfile & { status: AutoLanInstallStatus; file?: string }> = [];
  for (const mcDir of opts.mcDirs) {
    const byDir = new Map<string, string[]>();
    for (const p of await findSeiProfiles(mcDir)) {
      byDir.set(p.gameDir, [...(byDir.get(p.gameDir) ?? []), p.mcVersion]);
    }
    for (const [gameDir, versions] of byDir) {
      // Several profiles on one game dir (the pre-260916 shared `<mcDir>/sei`)
      // with versions that need different builds (or none): any one jar would
      // stop Fabric from launching the other profile, so none goes in.
      const conflict =
        manifest !== null &&
        versions.length > 1 &&
        new Set(versions.map((v) => pickAutoLanJar(manifest, v)?.file ?? null)).size > 1;
      if (conflict) {
        logger.info(`autolan: ${gameDir} is shared by Minecraft ${versions.join(', ')}; not installing there`);
      }
      const r = await installAutoLanMod({
        modsDir: path.join(gameDir, 'mods'),
        mcVersion: versions[0],
        assetsDir: opts.assetsDir,
        enabled: enabled && !conflict,
        manifest,
      });
      results.push({ gameDir, mcVersion: versions[0], ...r });
    }
  }
  return results;
}
