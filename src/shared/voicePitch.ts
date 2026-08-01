/**
 * Companion voice pitch (260707; local shift since 260731).
 *
 * ElevenLabs has no pitch parameter, so a "high, clearly AI" voice is a shift
 * we apply ourselves. It is ONE thing now: the renderer plays the clip through
 * a duration-preserving pitch shifter at `rate`
 * (lib/voice/pitchBus.ts). Synthesis is asked for nothing.
 *
 * It used to be TWO halves that had to cancel — synthesis asked for
 * `voice_settings.speed ≈ 1/rate` so the clip came back slow, and playback ran
 * it at `playbackRate = rate` with preservesPitch OFF, which raised pitch and
 * pace together. The halves did not cancel reliably: the resample is exact
 * arithmetic, while `speed` is a model conditioning hint that a short utterance
 * gives the model almost no room to express. So "oh." and "yeah?" came back
 * barely slowed and played a full `rate` too fast. That was structural, and it
 * is why the compensation is gone rather than tuned.
 *
 * `rate` is unchanged in meaning and storage (a frequency multiplier; 1 = as
 * recorded), so no character metadata migrated.
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
 * The pitch range the voice playground offers (260725).
 *
 * These numbers were chosen for a constraint that no longer exists: the old
 * pace compensation had to stay inside ElevenLabs' accepted speed range
 * [0.7, 1.2], i.e. rate ∈ [1/1.2, 1/0.7] ≈ [0.834, 1.428], and past the band it
 * saturated and speech audibly ran fast. The local shifter has no such band, so
 * the range is now only a taste judgement: roughly -2.8 to +5.9 semitones,
 * which is as far as a voice moves before it stops sounding like a person.
 *
 * They are kept AS THEY WERE on purpose. Every stored voicePitch was picked by
 * ear against this scale, and widening the ends in the same change that
 * replaces the engine would mean two things moved at once.
 */
export const VOICE_PITCH_MIN = 0.85;
export const VOICE_PITCH_MAX = 1.4;

/**
 * Pitch shift for a character's TTS clips, as a frequency multiplier.
 * metadata.voicePitch when it's a sane number (clamped so bad synced metadata
 * can't garble a call; it round-trips through cloud sync verbatim, like
 * metadata.voiceId), else Sui's baked-in lift, else 1 (as recorded).
 */
export function voicePitchRate(character: Pick<Character, 'id' | 'metadata'>): number {
  const v = character.metadata?.voicePitch;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(2, Math.max(0.5, v));
  return character.id === SUI_CHARACTER_ID ? SUI_DEFAULT_PITCH_RATE : 1;
}

/**
 * Delivery calmness (260724; moved here from main tts.ts 260725 so the
 * renderer's voice sliders can compute a character's baked default).
 * ElevenLabs' `stability` is the strongest calm-vs-dramatic lever: at the
 * per-voice default (~0.5) the model swings intonation expressively; high
 * values flatten delivery into a steady, even cadence. Sui defaults high —
 * the Neuro-style calm affect layered on her pitch lift above.
 * `metadata.voiceStability` overrides per character (clamped; round-trips
 * verbatim through cloud sync). undefined → send nothing, so unconfigured
 * characters' TTS request bodies stay byte-identical to before.
 */
export const SUI_DEFAULT_STABILITY = 0.85;
export function voiceStabilityFor(character: Pick<Character, 'id' | 'metadata'>): number | undefined {
  const v = character.metadata?.voiceStability;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(1, Math.max(0, v));
  return character.id === SUI_CHARACTER_ID ? SUI_DEFAULT_STABILITY : undefined;
}
