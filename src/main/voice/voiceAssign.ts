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
import {
  NO_VOICE_ID,
  OWN_VOICE_KEY,
  SHARED_VOICE_KEY,
  ownVoiceOf,
  sharedVoiceIdOf,
  type OwnVoicePick,
} from '../../shared/voiceIds';
import { POOL_VOICE_IDS, isPoolVoiceId } from '../../shared/poolVoiceIds';
import { listCharacters, saveCharacter } from '../characterStore';
import { getCurrentAuthState } from '../auth/authState';

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

/**
 * metadata.voiceId when it points at a pool (or legacy) voice, or at a voice
 * the user picked from their OWN ElevenLabs account (261019, the
 * `metadata.voiceOwn` marker, see shared/voiceIds.ts), else null.
 *
 * The own-voice branch is what keeps an explicit pick from being "repaired":
 * a null here makes resolveVoiceId re-roll a pool voice and persist it over
 * the user's choice. Whether the voice can actually PLAY on the active route
 * is tts.ts's question (it fails with a clear sentinel), never a reason to
 * swap the voice.
 */
export function assignedVoiceId(character: Character): string | null {
  const v = character.metadata?.voiceId;
  if (typeof v !== 'string') return null;
  if (isPoolVoiceId(v)) return v;
  return ownVoiceOf(character.metadata) && ownVoiceHonored(character) ? v : null;
}

function currentUserId(): string | null {
  try {
    const auth = getCurrentAuthState();
    return auth.kind === 'signed_in' ? auth.user.id : null;
  } catch {
    return null;
  }
}

/**
 * Whether this character's own-voice marker belongs to the person using the
 * app. A voice from someone's own ElevenLabs account only exists for that
 * account, but character metadata travels: a shared (World) character is
 * cached with its author's metadata verbatim (cloud/cacheOnDemand.ts), so an
 * adopter would inherit a voiceId nobody else can speak and cannot change
 * (foreign characters are view-only). Same ownership rule as CharacterPage:
 * a legacy null-owner row or one owned by the signed-in user is theirs; a
 * bundled default or anyone else's row is not.
 */
export function ownVoiceHonored(character: Pick<Character, 'owner' | 'is_default'>): boolean {
  if (character.is_default) return false;
  const owner = character.owner;
  return owner == null || owner === currentUserId();
}

/**
 * True when the stored voice is an own-account pick that is NOT this user's
 * (see ownVoiceHonored): synthesis borrows a pool voice for it, and nothing
 * is written back, so the author's pick survives every cloud refresh.
 */
function isBorrowedOwnVoice(character: Character): boolean {
  const v = character.metadata?.voiceId;
  if (typeof v !== 'string' || isPoolVoiceId(v)) return false;
  return ownVoiceOf(character.metadata) !== null && !ownVoiceHonored(character);
}

/**
 * The own-account marker for the character's CURRENT voice, or null. A pool
 * (or legacy) id is never an own voice, even if a stale `voiceOwn` survived
 * beside it (a writer that set voiceId without applyVoicePick): treating it
 * as one would refuse a perfectly playable pool voice on the proxy route.
 */
export function ownVoicePickOf(character: Character): OwnVoicePick | null {
  const v = character.metadata?.voiceId;
  if (isPoolVoiceId(v)) return null;
  // Someone else's own voice is not an own voice HERE: it speaks through the
  // borrowed pool voice resolveVoiceId returns, like any pool voice.
  if (!ownVoiceHonored(character)) return null;
  return ownVoiceOf(character.metadata);
}

/**
 * True when `id` is a curated-pool or legacy voice (defense at the IPC
 * boundary — still a closed allowlist, never an arbitrary id). Legacy ids
 * must pass so previewing an existing companion's voice keeps working. The
 * set itself lives in shared/poolVoiceIds.ts so the renderer reads the same
 * one (261024).
 */
export { isPoolVoiceId };

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
 * The deterministic fallback roll (260705): soulcaster's rollVoice tables,
 * seeded from the character id, filtered by the character sheet and persona.
 * `ownGender` (261019) fills in the voice gender when the sheet says nothing,
 * so a stand-in for an own ElevenLabs voice keeps that voice's gender.
 */
function rollFallbackVoice(character: Character, ownGender: string | undefined, taken: string[]): string {
  const sheet = (character.metadata?.soulcaster_sheet ?? {}) as SheetHints;
  const gender =
    sheet.gender === 'male' || sheet.gender === 'female' || sheet.gender === 'other'
      ? sheet.gender
      : ownGender === 'male' || ownGender === 'female'
        ? ownGender
        : 'other';
  const age = typeof sheet.age === 'number' && Number.isFinite(sheet.age) ? sheet.age : 30;

  // Personality inference from the persona prose (260705, the Marv fix) —
  // sheet-less characters still get a voice that fits who they are, and a
  // robot persona unlocks rollVoice's robot rule.
  const personaText = `${character.persona?.source ?? ''}\n${character.name ?? ''}`;
  const hints = personaVoiceHints(personaText);
  const background =
    typeof sheet.background === 'string' ? sheet.background : hints.robot ? 'robot' : 'human';

  const voice = rollVoice(
    { gender, age, background, personality_seeds: hints.seeds },
    { takenVoiceIds: taken, rng: mulberry32(seedFrom(character.id)) },
  ) as { id: string };
  return voice.id;
}

/**
 * The close Sei voice that stands in for an own ElevenLabs voice when someone
 * else plays the character (261019): the fallback roll with the own voice's
 * gender and NO roster exclusions, so it comes out the same on every device
 * from the character alone (the author's preview and every adopter agree).
 * `ownGender` overrides the stored marker's gender, for an own voice picked
 * in the editor but not saved yet.
 */
export function closeSharedVoiceId(character: Character, ownGender?: string | null): string {
  const gender = ownGender ?? ownVoiceOf(character.metadata)?.gender;
  return rollFallbackVoice(character, gender ?? undefined, []);
}

/**
 * The voice the author chose for others (metadata.voiceShared), only when it
 * is a current pool voice: anything else (legacy, own-account, junk) falls
 * back to the close match, so only pool ids ever reach the proxy. Current
 * pool only, not legacy, so it agrees with the renderer's chooser, which
 * lists listPoolVoices() and reads anything unlisted as the default.
 */
export function sharedVoiceIdFor(character: Pick<Character, 'metadata'>): string | null {
  const id = sharedVoiceIdOf(character.metadata);
  return id && POOL_VOICE_IDS.has(id) ? id : null;
}

/**
 * The Sei pool voice that stands in for this character's OWN ElevenLabs voice
 * on the author's machine when their key cannot speak it (261020, T158: a
 * cloud user with no key stored, or a key ElevenLabs refused). Same pick an
 * adopter hears (the author's voice for others, else the close match), so the
 * stand-in is a voice the author already approved. Never persisted.
 */
export function ownVoiceStandInId(character: Character): string {
  return sharedVoiceIdFor(character) ?? closeSharedVoiceId(character);
}

/**
 * Resolve (and persist, when newly assigned) the character's TTS voice id.
 * Never throws for assignment reasons — the fallback roll always lands on a
 * valid pool voice; only storage errors propagate from saveCharacter, and
 * those are swallowed too (an unsaved assignment just re-rolls to the same
 * deterministic pick next time).
 */
export async function resolveVoiceId(character: Character): Promise<string> {
  // Explicit "no voice" pick (260720): never roll a fallback over it — doing
  // so would persist a voice onto a companion the user made silent. Callers
  // gate on the sentinel before resolving; this throw is the backstop.
  if (character.metadata?.voiceId === NO_VOICE_ID) {
    throw new Error('VOICE_DISABLED: this companion has no voice');
  }
  const assigned = assignedVoiceId(character);
  if (assigned) return assigned;
  // Another user's own ElevenLabs voice (261019, shared character): speak
  // with the voice the author chose for others (metadata.voiceShared, pool
  // ids only), else a close match rolled from the character. Never persist
  // either: the author's metadata is the cloud copy's, and a cloud refresh
  // would only overwrite it again.
  if (isBorrowedOwnVoice(character)) return ownVoiceStandInId(character);

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

  const voice = { id: rollFallbackVoice(character, undefined, taken) };

  try {
    // The rolled id is a pool voice, so any own-voice marker left beside the
    // replaced id is stale by definition: drop it (and the voice for others
    // that stood in for it) with the id it described.
    const {
      [OWN_VOICE_KEY]: _staleOwn,
      [SHARED_VOICE_KEY]: _staleShared,
      ...rest
    } = character.metadata ?? {};
    await saveCharacter({
      ...character,
      metadata: { ...rest, voiceId: voice.id },
    });
  } catch (err) {
    console.warn(`[sei/voice] failed to persist voiceId for ${character.id}: ${(err as Error).message}`);
  }
  return voice.id;
}
