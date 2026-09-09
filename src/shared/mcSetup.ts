/**
 * Minecraft "Sei-ready" readiness (260909). Pure, shared by main (the
 * wizard's target-version pick) and the renderer (the launch panel's setup
 * list), so the two can never disagree about what "set up" means.
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

/**
 * Which Minecraft version the wizard should install Fabric for.
 *
 * A player already on a version Sei can join keeps it (their worlds are on
 * it, and this is what the wizard always did). Anyone else, a version Sei
 * cannot join (a snapshot, a release newer than the networking stack) or no
 * readable version at all, gets the newest VERIFIED version: one where
 * Fabric plus the companion-skin mod have actually been launched together.
 * A Modrinth listing is not proof (the CustomSkinLoader 15.x builds listed
 * 1.21.x and crashed it), which is why `verified` is a hand-maintained list
 * and not a lookup. If the verified list has nothing Sei can join, the
 * newest supported version is the last resort.
 */
export function selectTargetMcVersion(args: {
  installVersion: string | null | undefined;
  supported: readonly string[];
  verified: readonly string[];
}): string | null {
  const { installVersion, supported, verified } = args;
  const joinable = (v: string): boolean => supported.includes(v) && compareMcVersions(v, FABRIC_MIN_MC) >= 0;
  if (installVersion && joinable(installVersion)) return installVersion;
  const newestFirst = (list: readonly string[]): string[] => [...list].sort(compareMcVersions).reverse();
  for (const v of newestFirst(verified)) if (joinable(v)) return v;
  for (const v of newestFirst(supported)) if (joinable(v)) return v;
  return null;
}
