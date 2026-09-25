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
import { isMcVersionNewerThanSupported, supportedMcRange, type McSupportedRange } from '@shared/mcSetup';

export const MC_SUPPORTED_RANGE: McSupportedRange = supportedMcRange(supportedVersions) ?? {
  oldest: supportedVersions[0] ?? '',
  newest: supportedVersions[supportedVersions.length - 1] ?? '',
};

/** `{oldest}` / `{newest}` placeholders for t(). */
export const MC_RANGE_VARS: Record<string, string> = {
  oldest: MC_SUPPORTED_RANGE.oldest,
  newest: MC_SUPPORTED_RANGE.newest,
};

/** The LAN world's reported version is newer than anything Sei can join. */
export function worldTooNewForSei(versionName: string | null | undefined): boolean {
  return isMcVersionNewerThanSupported(versionName, supportedVersions);
}
