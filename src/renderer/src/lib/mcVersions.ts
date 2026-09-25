/**
 * The Minecraft Java range Sei can join, for renderer copy (260926).
 *
 * Derived from minecraft-protocol's `supportedVersions`, the same table the
 * bot enforces at connect (deep import of the dependency-free CJS data
 * module; the package root pulls the protocol stack, which must never enter
 * the renderer). Never hardcode a version in copy: the range moves with the
 * protocol bump and a stale number lies to players. 19 people in 30 days hit
 * UNSUPPORTED_MC_VERSION on Minecraft 26.2 / 26.3 while the copy named no
 * version at all (analytics review 260926).
 */
import { supportedVersions } from 'minecraft-protocol/src/version.js';
// 260926: the protocol table (a plain JSON data file, ~120KB) says which
// releases share a supported protocol, so the copy can list the real set with
// its gaps instead of a range that hides them.
import protocolRows from 'minecraft-data/minecraft-data/data/pc/common/protocolVersions.json';
import {
  formatMcVersionList,
  isMcVersionNewerThanSupported,
  joinableMcVersions,
  mcReleases,
  selectTargetMcVersion,
  supportedMcRange,
  type McProtocolRow,
  type McSupportedRange,
} from '@shared/mcSetup';

const ROWS: readonly McProtocolRow[] = protocolRows as readonly McProtocolRow[];

export const MC_SUPPORTED_RANGE: McSupportedRange = supportedMcRange(supportedVersions) ?? {
  oldest: supportedVersions[0] ?? '',
  newest: supportedVersions[supportedVersions.length - 1] ?? '',
};

/**
 * The version to TELL players to install: the one the setup wizard builds its
 * Fabric + CustomSkinLoader profile for (selectTargetMcVersion, capped by
 * WIZARD_MAX_MC). Not MC_SUPPORTED_RANGE.newest: the bot joins newer worlds
 * (26.2 / 26.3) where the skin mod has no verified build, so steering players
 * there would cost them companion skins.
 */
export const MC_RECOMMENDED: string = selectTargetMcVersion({ supported: supportedVersions }) ?? MC_SUPPORTED_RANGE.newest;

/** Every release Sei can join, oldest first (see joinableMcVersions). */
export const MC_JOINABLE: readonly string[] = joinableMcVersions(supportedVersions, ROWS);

/**
 * Placeholders for t(): `{versions}` is the compact joinable list with its
 * gaps ("1.8 to 1.8.9, 1.9.3, 1.9.4, ..."); `{recommended}` is the version the
 * launcher steps and the setup wizard install (MC_RECOMMENDED); `{newest}` is
 * the newest version Sei can join; `{oldest}` is kept for callers that still
 * name the floor.
 */
export const MC_RANGE_VARS: Record<string, string> = {
  oldest: MC_SUPPORTED_RANGE.oldest,
  newest: MC_SUPPORTED_RANGE.newest,
  recommended: MC_RECOMMENDED,
  versions: formatMcVersionList(MC_JOINABLE, mcReleases(ROWS)),
};

/** MC_RANGE_VARS with the list's "a to b" spans translated. */
export function mcRangeVars(
  tr?: (en: string, params?: Record<string, string | number>) => string,
): Record<string, string> {
  if (!tr) return MC_RANGE_VARS;
  return {
    ...MC_RANGE_VARS,
    versions: formatMcVersionList(MC_JOINABLE, mcReleases(ROWS), (from, to) => tr('{from} to {to}', { from, to })),
  };
}

/** The LAN world's reported version is newer than anything Sei can join. */
export function worldTooNewForSei(versionName: string | null | undefined): boolean {
  return isMcVersionNewerThanSupported(versionName, supportedVersions, ROWS);
}
