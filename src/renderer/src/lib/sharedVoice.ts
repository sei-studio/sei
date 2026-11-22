/**
 * Voice for others (261019) â€” pure logic, no React.
 *
 * A voice from the author's own ElevenLabs account only plays in that
 * account, so anyone else who invites a shared character hears a Sei pool
 * voice instead: the one stored as metadata.voiceShared, or (absent) the
 * close match main rolls from the character (voice:shared-default, the same
 * roll every adopter's app makes). The share step, the profile's Voice tab and
 * the character page all read the choice through these helpers, so a junk or
 * stale stored id reads as the default everywhere, exactly like main does.
 */
import type { VoiceInfo } from '@shared/ipc';
import { applySharedVoicePick, ownVoiceOf, sharedVoiceIdOf } from '@shared/voiceIds';
import { groupVoices, type VoiceGroup } from './voicePicker';

/** The stored choice when it names a listed pool voice, else null (= the
 * default close match). Validated against the pool the picker lists. */
export function validSharedVoice(stored: string | null | undefined, pool: VoiceInfo[]): string | null {
  if (!stored) return null;
  return pool.some((v) => v.id === stored) ? stored : null;
}

/** The pool voice others actually hear: the valid stored choice, else the
 * default (null while the default is still loading). */
export function effectiveSharedVoice(
  stored: string | null | undefined,
  defaultId: string | null,
  pool: VoiceInfo[],
): string | null {
  return validSharedVoice(stored, pool) ?? defaultId;
}

/** Display name for a pool voice id, or null when the pool does not list it. */
export function poolVoiceLabel(id: string | null, pool: VoiceInfo[]): string | null {
  if (!id) return null;
  return pool.find((v) => v.id === id)?.label ?? null;
}

/** Pool voices grouped for the chooser's option groups (same order and
 * buckets as the voice picker's tabs). */
export function sharedVoiceGroups(pool: VoiceInfo[]): VoiceGroup[] {
  return groupVoices(pool);
}

/**
 * What a chooser change stores: picking the default (empty value, or the
 * default voice itself) clears the key so the character keeps following the
 * close match; any other listed pool voice is stored; anything else clears.
 */
export function sharedVoiceForChange(
  picked: string,
  defaultId: string | null,
  pool: VoiceInfo[],
): string | null {
  if (!picked || picked === defaultId) return null;
  return validSharedVoice(picked, pool);
}

/**
 * The publish step's write: the metadata to save before going public so the
 * uploaded row carries the "Others will hear" choice, or null when there is
 * nothing to write (not an own voice, or the choice is already stored).
 */
export function sharedVoiceMetadataToSave(
  metadata: Record<string, unknown> | undefined | null,
  choice: string | null,
): Record<string, unknown> | null {
  if (!ownVoiceOf(metadata)) return null;
  if (sharedVoiceIdOf(metadata) === choice) return null;
  return applySharedVoicePick(metadata, choice);
}




