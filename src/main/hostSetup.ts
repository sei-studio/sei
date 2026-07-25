/**
 * Sei skin-setup detector for a Fabric LAN host (260721).
 *
 * Sei's skin-setup wizard installs Fabric Loader itself (fabricInstaller.ts)
 * with an isolated gameDir at `<.minecraft>/sei/` and drops exactly one mod
 * into `<gameDir>/mods/`: the CustomSkinLoader jar (customSkinLoader.ts).
 * The wizard may additionally hardlink the user's own version-compatible
 * mods into that dir (wizardStateStore LinkManifest), so "other jars in the
 * managed mods dir" is real evidence of mods beyond ours even on our own
 * profile.
 *
 * So when the LAN host classifies as 'fabric' we must NOT blanket-warn
 * "Modded Minecraft detected" (the pre-260721 bug: users who followed our own
 * skin setup were warned about our own mod). Instead we resolve WHICH mods
 * the host actually loaded and let the shared lanHostWarning() decide.
 *
 * Chosen heuristic, strongest signals implementable from existing code:
 *
 *   1. The host java process command line carries `--gameDir <path>` — a
 *      standard vanilla-launcher game argument present on every Mojang
 *      launcher launch (and on third-party launchers that follow the version
 *      JSON contract). Fabric Loader loads every jar in `<gameDir>/mods/`,
 *      so that directory IS the authoritative list of loaded mods. We
 *      already read the command line once per world session for the client
 *      classifier (hostClient.ts); this reuses the same string.
 *   2. `<gameDir>/mods/` contents: a jar matching CustomSkinLoader's
 *      canonical filename (same regex customSkinLoader.ts installs/detects
 *      by) = our skin mod; any other `.jar` = a foreign mod.
 *
 * Reliability notes:
 *   - The ping version string was rejected as a signal: Fabric reports the
 *     plain vanilla version name, so it cannot distinguish our setup.
 *   - A skin-server hit would be definitive but only proves the mod ran at
 *     some point this session, needs new stateful plumbing, and is absent on
 *     the first summon after launch; the mods-dir scan is deterministic at
 *     click time.
 *   - `ps` output does not quote arguments, so a gameDir containing a
 *     literal ` --` cannot be parsed exactly; we then return "no evidence"
 *     (otherModCount null) and the shared decision stays silent for Fabric,
 *     which is the intended benefit-of-the-doubt default.
 *
 * Failure mode is always "no evidence" (seiSkinMod false, otherModCount
 * null), never a thrown error: LAN detection must not break on an unreadable
 * process or directory.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Result of inspecting the host's loaded-mods directory. */
export interface HostModsInfo {
  /** True when a CustomSkinLoader jar (the one mod Sei installs) is present. */
  seiSkinMod: boolean;
  /** Count of mod jars OTHER than Sei's skin mod. null = the mods dir could
   *  not be resolved or read (no evidence either way). */
  otherModCount: number | null;
}

/** Same canonical filename shape customSkinLoader.ts installs and detects by
 *  (`CustomSkinLoader_Fabric-14.28.jar`, `CustomSkinLoader-...` variants). */
const CSL_JAR_RE = /^CustomSkinLoader[_-].*\.jar$/i;

/**
 * Extract the `--gameDir <path>` argument from a java command line. Pure —
 * exported for tests.
 *
 * `ps -o command=` joins arguments with spaces and strips quoting, so a path
 * containing spaces spans several tokens. Minecraft's game arguments are all
 * `--flag value` pairs, so the value runs until the next ` --` (or end of
 * line). Windows PowerShell preserves the original quoting, so a quoted form
 * is handled first.
 */
export function extractGameDir(cmdline: string): string | null {
  // Quoted (Windows CommandLine): --gameDir "C:\Users\Some Name\.minecraft\sei"
  const quoted = /--gameDir\s+"([^"]+)"/.exec(cmdline);
  if (quoted) return quoted[1].trim() || null;
  // Unquoted (ps output): capture until the next ` --flag` or end of string.
  const bare = /--gameDir\s+(.+?)(?=\s+--|$)/.exec(cmdline);
  if (bare) {
    const dir = bare[1].trim();
    return dir.length > 0 ? dir : null;
  }
  return null;
}

/**
 * Classify a mods directory listing. Pure — exported for tests.
 * Non-jar entries (configs, subdirs, .DS_Store) are ignored: Fabric Loader
 * only loads `.jar` files.
 */
export function classifyModJars(entries: string[]): { seiSkinMod: boolean; otherModCount: number } {
  let seiSkinMod = false;
  let otherModCount = 0;
  for (const name of entries) {
    if (!/\.jar$/i.test(name)) continue;
    if (CSL_JAR_RE.test(name)) seiSkinMod = true;
    else otherModCount += 1;
  }
  return { seiSkinMod, otherModCount };
}

/**
 * Resolve the host's `<gameDir>/mods/` from its command line and scan it.
 * Never throws. A resolvable gameDir with a MISSING mods dir is positive
 * "zero mods" evidence (Fabric without any mods), not null.
 */
export async function inspectHostMods(cmdline: string): Promise<HostModsInfo> {
  const gameDir = extractGameDir(cmdline);
  if (!gameDir) return { seiSkinMod: false, otherModCount: null };
  try {
    const entries = await fs.readdir(path.join(gameDir, 'mods'));
    return classifyModJars(entries);
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // gameDir resolved but has no mods/ at all — a modless Fabric profile.
      return { seiSkinMod: false, otherModCount: 0 };
    }
    return { seiSkinMod: false, otherModCount: null };
  }
}
