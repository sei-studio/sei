/**
 * Companion voice pitch (260707).
 *
 * ElevenLabs has no pitch parameter, so a "high, clearly AI" voice is built
 * from two halves that must stay in ratio:
 *   - synthesis asks ElevenLabs for voice_settings.speed ≈ 1/rate, so the
 *     clip comes back slower-paced (main: src/main/voice/tts.ts), and
 *   - playback runs the clip at `rate` with preservesPitch OFF, which raises
 *     pitch and pace together (renderer: lib/voice/audioQueue.ts) — the two
 *     cancel on pace and only the pitch lift remains.
 * Both halves derive from voicePitchRate() here (shared/ is importable from
 * main AND renderer) so they cannot drift.
 */
import type { Character } from './characterSchema';

/**
 * Sui's frozen UUID — mirrors DEFAULT_CHARACTER_UUIDS.sui in
 * src/main/defaultCharacters.ts, which the renderer must not import from.
 * Both are FROZEN, so the duplication cannot drift.
 */
export const SUI_CHARACTER_ID = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';

/** Sui speaks pitched up by default: high, clearly an AI. +3.5 semitones
 * (rate = 2^(3.5/12)). 260707 tuning: 1.25 → 1.15 → 1.224. */
export const SUI_DEFAULT_PITCH_RATE = 1.224;

/**
 * Playback rate for a character's TTS clips. metadata.voicePitch when it's a
 * sane number (clamped so bad synced metadata can't garble a call; it
 * round-trips through cloud sync verbatim, like metadata.voiceId), else Sui's
 * baked-in lift, else 1 (as recorded).
 */
export function voicePitchRate(character: Pick<Character, 'id' | 'metadata'>): number {
  const v = character.metadata?.voicePitch;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(2, Math.max(0.5, v));
  return character.id === SUI_CHARACTER_ID ? SUI_DEFAULT_PITCH_RATE : 1;
}

/**
 * The ElevenLabs voice_settings.speed that cancels `rate`'s pace change.
 * undefined at rate 1 (send no voice_settings — keeps the request byte-stable
 * for unpitched characters). ElevenLabs accepts 0.7..1.2 only, so past rate
 * ~1.43 the pace compensation saturates and speech drifts faster again.
 */
export function ttsSpeedFor(rate: number): number | undefined {
  if (rate === 1) return undefined;
  return Math.min(1.2, Math.max(0.7, 1 / rate));
}
