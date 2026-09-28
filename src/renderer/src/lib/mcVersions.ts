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
  isMcVersionNewerThanSupported,
  joinableMcVersions,
  mcReleases,
  mcVersionSpans,
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

/** Oldest and newest release Sei can join (the ends of MC_JOINABLE). */
export const MC_OLDEST_JOINABLE: string = MC_JOINABLE[0] ?? MC_SUPPORTED_RANGE.oldest;
export const MC_NEWEST_JOINABLE: string = MC_JOINABLE[MC_JOINABLE.length - 1] ?? MC_SUPPORTED_RANGE.newest;

/**
 * Placeholders for t(): `{oldest}` / `{newest}` are the ends of the joinable
 * list (the short "from 1.8 to 26.3" line); `{recommended}` is the version the
 * launcher steps and the setup wizard install (MC_RECOMMENDED).
 *
 * 260929: the full list with its gaps is no longer a sentence placeholder.
 * Inline it read as a wall of numbers ("1.8 to 1.8.9, 1.9.3 to 1.10.2,
 * 1.11.1, ..."), so copy says "most versions from {oldest} to {newest}" and
 * a "Which versions?" control shows mcVersionSpanList() one span per row.
 * Copy that states the short range must offer that control: the range alone
 * would claim every version in between works.
 */
export const MC_RANGE_VARS: Record<string, string> = {
  oldest: MC_OLDEST_JOINABLE,
  newest: MC_NEWEST_JOINABLE,
  recommended: MC_RECOMMENDED,
};

/**
 * Every joinable span, oldest first, for the "Which versions?" list:
 * ["1.8 to 1.8.9", "1.9.3 to 1.10.2", "1.11.1, 1.11.2", ..., "1.18.2 to 26.3"].
 * The "a to b" joiner is translated when `tr` is given.
 */
export function mcVersionSpanList(
  tr?: (en: string, params?: Record<string, string | number>) => string,
): string[] {
  return mcVersionSpans(
    MC_JOINABLE,
    mcReleases(ROWS),
    tr ? (from, to) => tr('{from} to {to}', { from, to }) : undefined,
  );
}

/** The LAN world's reported version is newer than anything Sei can join. */
export function worldTooNewForSei(versionName: string | null | undefined): boolean {
  return isMcVersionNewerThanSupported(versionName, supportedVersions, ROWS);
}
