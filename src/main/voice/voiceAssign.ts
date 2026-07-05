/**
 * Character → ElevenLabs voice resolution (260705).
 *
 * Procgen ('unique') characters get metadata.voiceId stamped at generation
 * time (uniqueGeneration → soulcaster castSoul → sheet.voice_id). Everything
 * else — custom characters, and uniques generated before voices existed —
 * gets a deterministic fallback here on first use: the same soulcaster
 * rollVoice tables, seeded from the character id, filtered by whatever the
 * character sheet knows (gender/age/background when a soulcaster sheet is in
 * metadata, the whole pool otherwise) and excluding voices other characters in
 * the library already use. The pick is persisted to metadata.voiceId so it
 * never drifts and cloud-syncs with the character (metadata round-trips
 * verbatim).
 */
import { rollVoice, mulberry32, VOICES } from 'soulcaster';
import type { Character } from '../../shared/characterSchema';
import { listCharacters, saveCharacter } from '../characterStore';

const VOICE_IDS = new Set((VOICES as Array<{ id: string }>).map((v) => v.id));

/** FNV-1a over the character id — a stable 32-bit seed for the fallback roll. */
function seedFrom(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

type SheetHints = {
  gender?: unknown;
  age?: unknown;
  background?: unknown;
  personality?: { values?: unknown };
};

/** metadata.voiceId when it points at a real pool voice, else null. */
export function assignedVoiceId(character: Character): string | null {
  const v = character.metadata?.voiceId;
  return typeof v === 'string' && VOICE_IDS.has(v) ? v : null;
}

/** True when `id` is a curated-pool voice (defense at the IPC boundary). */
export function isPoolVoiceId(id: string): boolean {
  return VOICE_IDS.has(id);
}

/**
 * The curated voice pool, renderer-safe (voice-picker UI, 260705). Strips the
 * internal `owner` hash; the rest is what a picker needs to label + filter.
 */
export function listPoolVoices(): Array<{
  id: string;
  label: string;
  gender: string;
  age: string;
  tags: string[];
  vibe: string;
}> {
  return (VOICES as Array<{ id: string; label: string; gender: string; age: string; tags: string[]; vibe: string }>).map(
    (v) => ({ id: v.id, label: v.label, gender: v.gender, age: v.age, tags: [...v.tags], vibe: v.vibe }),
  );
}

/**
 * Resolve (and persist, when newly assigned) the character's TTS voice id.
 * Never throws for assignment reasons — the fallback roll always lands on a
 * valid pool voice; only storage errors propagate from saveCharacter, and
 * those are swallowed too (an unsaved assignment just re-rolls to the same
 * deterministic pick next time).
 */
export async function resolveVoiceId(character: Character): Promise<string> {
  const assigned = assignedVoiceId(character);
  if (assigned) return assigned;

  const sheet = (character.metadata?.soulcaster_sheet ?? {}) as SheetHints;
  const gender =
    sheet.gender === 'male' || sheet.gender === 'female' || sheet.gender === 'other'
      ? sheet.gender
      : 'other';
  const age = typeof sheet.age === 'number' && Number.isFinite(sheet.age) ? sheet.age : 30;
  const background = typeof sheet.background === 'string' ? sheet.background : 'human';

  // Exclude voices the rest of the library already uses (assigned ones only —
  // resolving them recursively would just be this same roll).
  let taken: string[] = [];
  try {
    taken = (await listCharacters())
      .filter((c) => c.id !== character.id)
      .map((c) => assignedVoiceId(c))
      .filter((v): v is string => v !== null);
  } catch {
    // Library unreadable → roll without exclusions; still deterministic.
  }

  const voice = rollVoice(
    { gender, age, background, personality_seeds: [] },
    { takenVoiceIds: taken, rng: mulberry32(seedFrom(character.id)) },
  ) as { id: string };

  try {
    await saveCharacter({
      ...character,
      metadata: { ...character.metadata, voiceId: voice.id },
    });
  } catch (err) {
    console.warn(`[sei/voice] failed to persist voiceId for ${character.id}: ${(err as Error).message}`);
  }
  return voice.id;
}
