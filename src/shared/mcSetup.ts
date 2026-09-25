/**
 * Minecraft "Sei-ready" readiness + the wizard's target version (260916).
 * Pure, shared by main (the skin wizard) and the renderer (setup UI), so
 * the two can never disagree about what "set up" means.
 *
 * A Minecraft install is Sei-ready when the skin-setup wizard has put a
 * Fabric profile there for a Minecraft version Sei's networking stack can
 * join AND the companion-skin mod is in place. The Fabric profile is what
 * makes the version part real: the launcher downloads that Minecraft
 * version the first time the profile is played, so installing Fabric for a
 * supported version IS installing a compatible Minecraft, from the
 * player's point of view.
 *
 * The scanner reports every `versions/fabric-loader-<loader>-<mc>` folder
 * it finds (`fabric_mc_versions`), so an install that carries Fabric for a
 * version Sei cannot join (a snapshot, a future release) is not ready even
 * though `loader === 'fabric'`.
 */

export interface McSetupInstallLike {
  loader: 'fabric' | 'forge' | null;
  csl_installed: boolean;
  /** Absent on records from a main older than this field: fall back to `loader`. */
  fabric_mc_versions?: string[];
  /**
   * Versions with a launcher profile whose OWN mods folder carries the skin
   * mod (260916, one "Sei <version>" profile per version, each with its own
   * game dir). When present this is the readiness truth; absent (older
   * main, or launcher_profiles.json unreadable) falls back to "Fabric for a
   * supported version exists somewhere + the mod exists somewhere".
   */
  sei_ready_versions?: string[];
  compatibility: 'full' | 'limited';
}

/** Numeric compare of "1.21.4" / "26.1" style versions, newest last. */
export function compareMcVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The supported Minecraft version this install is ready for (newest when
 * several), or null when it is not ready. Records without the versions
 * list (older main) count Fabric + the skin mod as ready, which is what
 * the Settings row has always shown them as.
 */
export function mcInstallReadyVersion(install: McSetupInstallLike, supported: readonly string[]): string | null {
  if (install.compatibility !== 'full') return null;
  if (Array.isArray(install.sei_ready_versions)) {
    const ok = install.sei_ready_versions.filter((v) => supported.includes(v)).sort(compareMcVersions);
    return ok.length ? ok[ok.length - 1] : null;
  }
  if (install.loader !== 'fabric' || !install.csl_installed) return null;
  if (!Array.isArray(install.fabric_mc_versions)) return supported[supported.length - 1] ?? null;
  const ok = install.fabric_mc_versions.filter((v) => supported.includes(v)).sort(compareMcVersions);
  return ok.length ? ok[ok.length - 1] : null;
}

/** Any install on the machine is Sei-ready. */
export function anyMcInstallReady(installs: readonly McSetupInstallLike[], supported: readonly string[]): string | null {
  for (const i of installs) {
    const v = mcInstallReadyVersion(i, supported);
    if (v) return v;
  }
  return null;
}

/** Fabric Loader's current builds need Minecraft 1.14 or newer. */
export const FABRIC_MIN_MC = '1.14';

/** A release version string ("1.21.4", "26.1"): no snapshot / pre-release suffix. */
const RELEASE_RE = /^\d+\.\d+(?:\.\d+)?$/;

/**
 * Newest version the wizard installs its Fabric + CustomSkinLoader profile for.
 * The bot can JOIN newer worlds (minecraft-protocol's supportedVersions goes to
 * 26.3), but the skin mod lags: as of 260926 no CustomSkinLoader build on
 * Modrinth lists 26.3, and 26.2 only has the 15.x "Universal" rework that crashed
 * 1.21.x at launch. A 26.3 target would fail setup with MOD_DOWNLOAD_FAILED.
 * Raise this once a CSL build for the newer version is verified in game.
 */
export const WIZARD_MAX_MC = '26.1';

/** Supported versions the wizard can install Fabric for, newest first. */
export function installableMcVersions(supported: readonly string[]): string[] {
  return supported
    .filter((v) => RELEASE_RE.test(v)
      && compareMcVersions(v, FABRIC_MIN_MC) >= 0
      && compareMcVersions(v, WIZARD_MAX_MC) <= 0)
    .sort(compareMcVersions)
    .reverse();
}

/**
 * Which Minecraft version the wizard should install Fabric for.
 *
 * The NEWEST version Sei's networking stack can join, full stop. The
 * launcher's last-played version is deliberately not an input (260916): the
 * wizard used to install Fabric for whatever the launcher last ran, which
 * on any machine that had played 26.2 or 26.3 produced a "Sei" profile the
 * bot itself could not join, and the version-not-supported popup pointed
 * the player at the profile that had just been built for them. A version
 * the player explicitly asked for (`requested`, the setup picker) wins
 * when Sei can join it; anything else falls to the newest supported one.
 * Null only when nothing supported is new enough for Fabric.
 */
export function selectTargetMcVersion(args: {
  supported: readonly string[];
  requested?: string | null;
}): string | null {
  const { supported, requested } = args;
  const installable = installableMcVersions(supported);
  if (requested && installable.includes(requested)) return requested;
  return installable[0] ?? null;
}

/**
 * mineflayer's floor (its README: "Supports Minecraft 1.8 to <newest>").
 * minecraft-protocol's table also lists 1.7, which the protocol layer can
 * speak but the bot cannot play, so the range we TELL players starts here.
 * The ceiling is never hardcoded: it is always the newest entry in the table.
 */
export const BOT_MIN_MC = '1.8';

export interface McSupportedRange {
  /** Oldest release Sei can join, e.g. "1.8.8". */
  oldest: string;
  /** Newest release Sei can join, e.g. "26.1". */
  newest: string;
}

/**
 * The Minecraft Java range Sei can join, derived from minecraft-protocol's
 * `supportedVersions` (the table the bot enforces at connect). Release
 * versions only, sorted (the table's order is not a contract). Null only
 * for an empty/unusable table.
 */
export function supportedMcRange(supported: readonly string[]): McSupportedRange | null {
  const releases = supported
    .filter((v) => RELEASE_RE.test(v) && compareMcVersions(v, BOT_MIN_MC) >= 0)
    .sort(compareMcVersions);
  if (releases.length === 0) return null;
  return { oldest: releases[0], newest: releases[releases.length - 1] };
}

/** One row of minecraft-data's pc/common/protocolVersions.json. */
export interface McProtocolRow {
  minecraftVersion: string;
  /** The wire protocol number. */
  version: number;
  usesNetty?: boolean;
}

/** Release versions (1.8 and newer) in the protocol table, oldest first. */
export function mcReleases(rows: readonly McProtocolRow[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.usesNetty === false) continue;
    if (RELEASE_RE.test(r.minecraftVersion) && compareMcVersions(r.minecraftVersion, BOT_MIN_MC) >= 0) {
      out.add(r.minecraftVersion);
    }
  }
  return [...out].sort(compareMcVersions);
}

/**
 * 260926: every release a world can run that Sei can actually join, oldest
 * first. Mirrors the bot's check at connect (connect.js
 * resolveSupportedVersion): the world's version is joinable when it is in
 * minecraft-protocol's `supportedVersions` by name, or when it speaks the same
 * protocol as a supported entry (1.20.3 speaks 1.20.4's). The table is not a
 * contiguous range: 1.9 to 1.9.2, 1.11, 1.12.1 and more have protocols of
 * their own that the stack does not implement.
 */
export function joinableMcVersions(supported: readonly string[], rows: readonly McProtocolRow[]): string[] {
  const protocolOf = new Map<string, number>();
  for (const r of rows) {
    if (r.usesNetty === false) continue;
    if (!protocolOf.has(r.minecraftVersion)) protocolOf.set(r.minecraftVersion, r.version);
  }
  const supportedProtocols = new Set<number>();
  for (const v of supported) {
    const p = protocolOf.get(v);
    if (p !== undefined) supportedProtocols.add(p);
  }
  const out = new Set<string>();
  for (const v of mcReleases(rows)) {
    const p = protocolOf.get(v);
    if (supported.includes(v) || (p !== undefined && supportedProtocols.has(p))) out.add(v);
  }
  // A supported entry the data table does not list yet still counts.
  for (const v of supported) {
    if (RELEASE_RE.test(v) && compareMcVersions(v, BOT_MIN_MC) >= 0) out.add(v);
  }
  return [...out].sort(compareMcVersions);
}

/**
 * The joinable versions as players should read them: consecutive releases
 * (with no unsupported release between them) collapse to "a to b", so every
 * gap stays visible. "1.8 to 1.8.9, 1.9.3, 1.9.4, ..., 1.19 to 1.21.11, 26.1
 * to 26.1.2".
 */
export function formatMcVersionList(
  joinable: readonly string[],
  releases: readonly string[],
  span: (from: string, to: string) => string = (from, to) => `${from} to ${to}`,
): string {
  const ok = new Set(joinable);
  const order = [...new Set([...releases, ...joinable])].sort(compareMcVersions);
  const runs: string[][] = [];
  let run: string[] = [];
  for (const v of order) {
    if (ok.has(v)) {
      run.push(v);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs
    .map((r) => (r.length >= 3 ? span(r[0], r[r.length - 1]) : r.join(', ')))
    .join(', ');
}

/**
 * Is the world's reported version name clearly NEWER than anything Sei can
 * join? Reads the first "1.21.4" / "26.2" shaped number out of the ping's
 * version name (servers may decorate it, e.g. "Paper 1.21.4"). Only the
 * newer-than-newest case answers true: that is the real-world failure
 * (Minecraft 26.2 / 26.3 shipped before our protocol stack), and an older or
 * unparseable name is left for the bot's exact protocol check to judge.
 */
export function isMcVersionNewerThanSupported(
  versionName: string | null | undefined,
  supported: readonly string[],
  rows?: readonly McProtocolRow[],
): boolean {
  const m = versionName?.match(/\d{1,2}\.\d{1,3}(?:\.\d{1,3})?/);
  if (!m) return false;
  // 260926: with the protocol table, the newest JOINABLE release (26.1.2
  // speaks 26.1's protocol), not the table's newest entry.
  const joinable = rows ? joinableMcVersions(supported, rows) : null;
  const newest = joinable?.length ? joinable[joinable.length - 1] : supportedMcRange(supported)?.newest;
  if (!newest) return false;
  return compareMcVersions(m[0], newest) > 0;
}
