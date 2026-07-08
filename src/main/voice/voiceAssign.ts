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

/**
 * Voice ids removed from the assignment pool on 260707, when the soulcaster
 * table was curated down to use_case 'characters_animation' (64 → 25; the full
 * entries live in vendor/soulcaster/src/voices.js git history). They are still
 * valid on the ElevenLabs account — the cut was for NEW assignments only — so
 * existing characters keep them and their voice never silently changes:
 * without this set, assignedVoiceId would reject the persisted id and
 * resolveVoiceId would re-roll, persist, and cloud-sync a different voice.
 * New assignments never draw from here; rollVoice only sees VOICES.
 */
const LEGACY_VOICE_IDS = new Set([
  // female / young
  'EXAVITQu4vr4xnSDxMaL', // Sarah
  'FGY2WhTYpPnrIDTdsKH5', // Laura
  'cgSgspJ2msm6clMCkdW9', // Jessica
  'tpS5zOAgWUiQMhzYbG2h', // Sapphire
  'm0MqfGOWTAfVVEaz4KxX', // Alexandra
  'MJqcNjMbvfGUxatGjPcI', // Daisy
  'Y0G5nEDw2qHnUHGmtoM9', // Boo
  // female / adult
  'Xb7hH8MSUJpSbSDYk0k2', // Alice
  'XrExE9yKIg1WjnnlVkGX', // Matilda
  'hpp4J3VqNfWAUOO0d1Us', // Bella
  'pFZP5JQG7iQjIQuC4Bku', // Lily
  'FF59babHL8N8gfTgtBMT', // Jodi
  'DIS307HFaAvJZzq496qM', // Cecilia
  'vHMylH8q68M5Wk9WkVr1', // Claudia
  'u6a6bRv82Zfi9NzoIqvt', // Lia
  // female / elder
  'xIzR6egd3S3LJZbVW0c1', // Margaret
  '2qQJWjw5XdG80GreshqG', // Eleanor
  'wGcFBfKz5yUQqhqr0mVy', // Maria
  // male / young
  'IKne3meq5aSn9XLyUdCD', // Charlie
  'TX3LPaxmHKxFdv7VOQHJ', // Liam
  'bIHbv24MWmeRgasZH58o', // Will
  // male / adult
  'CwhRBWXzGAHq8TQ4Fs17', // Roger
  'JBFqnCBsd6RMkjVDRZzb', // George
  'cjVigY5qzO86Huf0OWal', // Eric
  'iP95p4xoKVk53GoZ742B', // Chris
  'nPczCjzI2devNBz1zQrb', // Brian
  'onwK4e9ZLuTAKqWW03F9', // Daniel
  'pNInz6obpgDQGcFmaJgB', // Adam
  'enzbGixeo55iqn1QxbbC', // Jon
  'pCL8Ua4MoAGISUaDmw69', // Miller
  // male / elder
  'pqHfZKP75CvOlQylNhV4', // Bill
  'PerZoH0r6nxBZXCoIPpv', // Michael
  'UzI1NsMEV3ni5JRkRSls', // Alistair
  'RcEmXcISaHUgHOU4uNTz', // Hansi
  // neutral
  'SAz9YHcvj6GT2YYXdXww', // River
  'M563YhMmA0S8vEYwkgYa', // Sammy
  'JGzTGubAVbbgG0SsLIlg', // Riley
  'Z9VxF84ucVtzvKlmYFhh', // Ramona
  'YKlogvnVogI4aFHoGIEw', // Aaron
]);

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

/**
 * Persona prose → soulcaster personality seeds (260705). Custom / world
 * characters have no rolled `personality_seeds`, so before this the fallback
 * roll was personality-BLIND — a "clinically depressed monotone robot" was as
 * likely to land a chirpy girl-next-door as a deep flat voice (the Marv bug).
 * A cheap keyword scan over the persona maps the loudest personality signals
 * onto the same seed vocabulary rollVoice already weights by (SEED_VOICE_TAGS
 * in soulcaster), and a robot/android mention unlocks the robot voice rule.
 * First two distinct matches win, mirroring the two rolled seeds.
 */
const PERSONA_SEED_HINTS: Array<[RegExp, string]> = [
  [/monoton|deadpan|flat[- ]voice|emotionless|dead inside|lifeless/i, 'stoic'],
  [/depress|gloomy|melanchol|morose|mopey|nihilis|despair/i, 'melancholic'],
  [/brooding|grim|tormented|haunted/i, 'brooding'],
  [/sarcas|sardonic|cynic|snark/i, 'sardonic'],
  [/dry[- ](wit|humor)|wry/i, 'dry-witted'],
  [/cheer|bubbly|sunny|peppy|chipper/i, 'sunny'],
  [/energetic|hyper|excitable|bouncy/i, 'restless'],
  [/playful|mischie|prankster|teas/i, 'mischievous'],
  [/shy|timid|soft[- ]spoken|meek|bashful/i, 'timid'],
  [/gentle|kind[- ]hearted|nurturing|motherly|caring/i, 'gentle'],
  [/calm|serene|zen|tranquil|composed/i, 'serene'],
  [/stoic|unflappable|reserved|impassive/i, 'stoic'],
  [/blunt|gruff|grumpy|brusque|no[- ]nonsense/i, 'blunt'],
  [/fierce|aggressive|warrior|battle|hot[- ]headed/i, 'fierce'],
  [/scheming|cunning|villain|menac|sinister/i, 'scheming'],
  [/proud|regal|noble|aristocrat|haughty/i, 'proud'],
  [/meticulous|precise|methodical|perfection/i, 'meticulous'],
  [/wise|sage|scholar|professor|mentor/i, 'aloof'],
  [/earnest|sincere|wholesome|loyal|devoted/i, 'devoted'],
  [/curious|inquisitive|wonder/i, 'curious'],
];

const ROBOT_RE = /\brobot|android|automaton|machine|cyborg|synthetic|\bAI\b|artificial intelligence/i;

/** Derive (seeds, robot?) from persona prose. Exported for tests. */
export function personaVoiceHints(personaText: string): {
  seeds: string[];
  robot: boolean;
} {
  const seeds: string[] = [];
  for (const [re, seed] of PERSONA_SEED_HINTS) {
    if (seeds.length >= 2) break;
    if (re.test(personaText) && !seeds.includes(seed)) seeds.push(seed);
  }
  return { seeds, robot: ROBOT_RE.test(personaText) };
}

/** metadata.voiceId when it points at a pool (or legacy) voice, else null. */
export function assignedVoiceId(character: Character): string | null {
  const v = character.metadata?.voiceId;
  return typeof v === 'string' && (VOICE_IDS.has(v) || LEGACY_VOICE_IDS.has(v)) ? v : null;
}

/**
 * True when `id` is a curated-pool or legacy voice (defense at the IPC
 * boundary — still a closed allowlist, never an arbitrary id). Legacy ids
 * must pass so previewing an existing companion's voice keeps working.
 */
export function isPoolVoiceId(id: string): boolean {
  return VOICE_IDS.has(id) || LEGACY_VOICE_IDS.has(id);
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

  // Personality inference from the persona prose (260705, the Marv fix) —
  // sheet-less characters still get a voice that fits who they are, and a
  // robot persona unlocks rollVoice's robot rule.
  const personaText = `${character.persona?.source ?? ''}\n${character.name ?? ''}`;
  const hints = personaVoiceHints(personaText);
  const background =
    typeof sheet.background === 'string' ? sheet.background : hints.robot ? 'robot' : 'human';

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
    { gender, age, background, personality_seeds: hints.seeds },
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
