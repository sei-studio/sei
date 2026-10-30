/**
 * Sei's voice pool ids, for every process (261024).
 *
 * The one place that answers "is this id one of Sei's voices?". Main
 * (voice/voiceAssign.ts: assignment, own-voice checks, the IPC preview
 * allowlist) and the renderer (shared/voiceIds.ts ownVoiceOf, the voice
 * picker's own-voice marker) both read it, so they can never disagree.
 *
 * Why the renderer needs it: Sei's company ElevenLabs library holds copies of
 * the pool voices ("Sei — Josh"), and a user's own library can too, so the
 * "Your ElevenLabs voices" list can contain a pool id. A pool id is never an
 * own voice: tagging it as one showed a "Voice for others" label and an extra
 * step when going public, for a voice everyone can already hear.
 *
 * The current pool comes straight from soulcaster's VOICES table. It is
 * imported by relative path from the vendored copy (voices.js is data only),
 * so the renderer bundle gets the table without the rest of soulcaster, and
 * no `soulcaster` package export is needed (worktrees that symlink another
 * checkout's node_modules resolve `soulcaster` to THAT checkout's vendor dir).
 */
import { VOICES } from '../../vendor/soulcaster/src/voices.js';

/** The current curated pool (what new assignments and the picker draw from). */
export const POOL_VOICE_IDS: ReadonlySet<string> = new Set(VOICES.map((v) => v.id));

/**
 * Voice ids removed from the assignment pool on 260707, when the soulcaster
 * table was curated down to use_case 'characters_animation' (64 → 25; the full
 * entries live in vendor/soulcaster/src/voices.js git history). They are still
 * valid on the ElevenLabs account — the cut was for NEW assignments only — so
 * existing characters keep them and their voice never silently changes:
 * without this set, assignedVoiceId would reject the persisted id and
 * resolveVoiceId would re-roll, persist, and cloud-sync a different voice.
 * New assignments never draw from here; rollVoice only sees VOICES.
 *
 * 260725: the five neutral voices cut in the 260707 curation (River, Sammy,
 * Riley, Ramona, Aaron) rejoined the pool as the neutral section of VOICES,
 * so they were removed from this set — membership in both would be
 * contradictory (this set is for voices REMOVED from the pool).
 */
export const LEGACY_VOICE_IDS: ReadonlySet<string> = new Set([
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
]);

/** True when `id` is a current-pool or legacy Sei voice. */
export function isPoolVoiceId(id: unknown): boolean {
  return typeof id === 'string' && (POOL_VOICE_IDS.has(id) || LEGACY_VOICE_IDS.has(id));
}
