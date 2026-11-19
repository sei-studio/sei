import { isPoolVoiceId } from './poolVoiceIds';

/**
 * Shared voice-id sentinels (260720).
 *
 * `metadata.voiceId` is normally an ElevenLabs pool voice id (unique-cast
 * stamps one at generation time; the creation picker pins one; the runtime
 * auto-assigns one on first TTS use when unset). NO_VOICE_ID is the third
 * state: the user explicitly chose a silent companion. Main's TTS paths must
 * treat it as "never synthesize" and the auto-assigner must never overwrite it.
 */
export const NO_VOICE_ID = 'none';

/**
 * A voice from the user's OWN ElevenLabs account (261019): cloned, designed,
 * or saved from the Voice Library. Picked from the voice picker's "Your
 * ElevenLabs voices" tab, which main fills with the BYOK key.
 *
 * Persisted beside `metadata.voiceId` as `metadata.voiceOwn = {name, gender?}`.
 * The marker is what tells the runtime the id is a deliberate pick and not a
 * stale or unknown one: without it resolveVoiceId would treat the id as
 * unassigned and re-roll (and persist) a pool voice over the user's choice.
 * `name` lets the picker label the voice when the list cannot be read (key
 * removed, cloud backend); `gender` comes from the voice's ElevenLabs labels
 * and picks the local-pack voice when synthesis falls back to local speech.
 * Both ride cloud sync verbatim with the rest of metadata.
 */
export const OWN_VOICE_KEY = 'voiceOwn';

/**
 * The Sei pool voice OTHER people hear for a character whose voice is the
 * author's own ElevenLabs voice (261019). An own voice exists only in the
 * author's ElevenLabs account, so an adopter of a shared character can never
 * play it; main (voice/voiceAssign.ts resolveVoiceId) speaks for them with
 * `metadata.voiceShared` when it is a valid pool id, else with a deterministic
 * close match rolled from the character (the default, never persisted).
 * Absent = that default. Meaningless beside a non-own voice, so applyVoicePick
 * drops it with the own-voice marker. Every reader validates it against the
 * pool; the proxy only ever receives pool ids.
 */
export const SHARED_VOICE_KEY = 'voiceShared';

/**
 * A voice from the public ElevenLabs Voice Library that a Sei cloud user
 * pasted into the voice picker (261119). The proxy added it to Sei's
 * ElevenLabs account, so it plays through /tts/speech for EVERYONE (adopters
 * of a shared character too), metered like a pool voice. Persisted beside
 * `metadata.voiceId` as `metadata.voiceLibrary = {name, gender?}`; like the
 * own-voice marker it tells the runtime the id is a deliberate pick, not a
 * stale one to re-roll. `gender` picks the stand-in pool voice when the proxy
 * no longer has the voice (sei-proxy retires library voices unused for 30
 * days) and the local voice when synthesis runs on-device.
 */
export const LIBRARY_VOICE_KEY = 'voiceLibrary';

export interface OwnVoicePick {
  name: string;
  gender?: string;
  /** 'library' (261119): a Voice Library voice pasted on Sei cloud, stored
   * as metadata.voiceLibrary instead of the own-voice marker. */
  source?: 'library';
}

/** ElevenLabs voice ids are short alphanumeric tokens (20 chars today). The
 * bound is loose on purpose; it only rejects junk (paths, spaces, sentinels). */
const VOICE_ID_RE = /^[A-Za-z0-9]{8,64}$/;

export function isWellFormedVoiceId(id: unknown): id is string {
  return typeof id === 'string' && id !== NO_VOICE_ID && VOICE_ID_RE.test(id);
}

/** The own-voice marker on a character's metadata, or null when the stored
 * voice is not an own-account pick (pool voice, Auto, No voice, malformed).
 * A Sei pool (or legacy) id is never an own voice, even with a marker beside
 * it (261024): v0.6.9 stamped the marker on pool voices picked while the
 * user's ElevenLabs library held a copy of them ("Sei — Josh"), and those
 * stale markers must read as a plain pool voice everywhere. */
export function ownVoiceOf(metadata: Record<string, unknown> | undefined | null): OwnVoicePick | null {
  if (!metadata || !isWellFormedVoiceId(metadata.voiceId)) return null;
  if (isPoolVoiceId(metadata.voiceId)) return null;
  return readVoiceMarker(metadata[OWN_VOICE_KEY]);
}

function readVoiceMarker(raw: unknown): { name: string; gender?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, gender } = raw as { name?: unknown; gender?: unknown };
  if (typeof name !== 'string' || !name.trim()) return null;
  return {
    name: name.slice(0, 100),
    ...(typeof gender === 'string' && gender ? { gender: gender.slice(0, 20) } : {}),
  };
}

/** The Voice Library marker on a character's metadata (261119), or null when
 * the stored voice is not a library pick. A pool id never is one. */
export function libraryVoiceOf(
  metadata: Record<string, unknown> | undefined | null,
): { name: string; gender?: string } | null {
  if (!metadata || !isWellFormedVoiceId(metadata.voiceId)) return null;
  if (isPoolVoiceId(metadata.voiceId)) return null;
  return readVoiceMarker(metadata[LIBRARY_VOICE_KEY]);
}

/** The picker-side pick for the stored voice: the own-voice marker, else the
 * library marker tagged `source: 'library'`, else null (261119). */
export function storedVoicePickOf(metadata: Record<string, unknown> | undefined | null): OwnVoicePick | null {
  const own = ownVoiceOf(metadata);
  if (own) return own;
  const library = libraryVoiceOf(metadata);
  return library ? { ...library, source: 'library' } : null;
}

/**
 * Apply a voice-picker selection to character metadata (returns a copy).
 * `voiceId` null = Auto (key removed), NO_VOICE_ID = silent, else a pinned
 * voice. `own` is set only for an own-account pick (or, with source
 * 'library', a Voice Library pick, stored as voiceLibrary); any other selection
 * clears the marker, so switching back to a Sei voice can never leave a stale
 * own-voice flag that would shield a pool id from the normal rules. A pool
 * id never takes the marker, even when a caller passes one (261024).
 */
export function applyVoicePick(
  metadata: Record<string, unknown> | undefined | null,
  voiceId: string | null,
  own?: OwnVoicePick | null,
): Record<string, unknown> {
  // A save that leaves the voice unchanged keeps its Voice Library marker even
  // when the caller passes no pick (261119): only a different voice, or an
  // own-voice pick, replaces it.
  const keptLibrary =
    voiceId !== null && metadata?.voiceId === voiceId && !own ? libraryVoiceOf(metadata) : null;
  const next: Record<string, unknown> = { ...(metadata ?? {}) };
  if (voiceId === null) delete next.voiceId;
  else next.voiceId = voiceId;
  const pickable = own && voiceId !== null && isWellFormedVoiceId(voiceId) && !isPoolVoiceId(voiceId) && own.name.trim();
  const marker = pickable
    ? { name: own.name.slice(0, 100), ...(own.gender ? { gender: own.gender.slice(0, 20) } : {}) }
    : null;
  if (marker && own?.source !== 'library') {
    next[OWN_VOICE_KEY] = marker;
    delete next[LIBRARY_VOICE_KEY];
  } else {
    delete next[OWN_VOICE_KEY];
    // The voice for others only stands in for an own voice; a library voice
    // plays for everyone, so it needs none.
    delete next[SHARED_VOICE_KEY];
    const library = marker ?? keptLibrary;
    if (library) next[LIBRARY_VOICE_KEY] = library;
    else delete next[LIBRARY_VOICE_KEY];
  }
  return next;
}

/** The stored voice-for-others id when it is well formed, else null. This is
 * only a shape check: callers still validate it against the pool (main with
 * isPoolVoiceId, the renderer against the listed pool). */
export function sharedVoiceIdOf(metadata: Record<string, unknown> | undefined | null): string | null {
  const v = metadata?.[SHARED_VOICE_KEY];
  return isWellFormedVoiceId(v) ? v : null;
}

/**
 * Set (pool id) or clear (null = the default close match) the voice others
 * hear (returns a copy). Ignored unless the stored voice is an own-account
 * pick: beside a pool voice the key would mean nothing.
 */
export function applySharedVoicePick(
  metadata: Record<string, unknown> | undefined | null,
  voiceId: string | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(metadata ?? {}) };
  if (voiceId !== null && isWellFormedVoiceId(voiceId) && ownVoiceOf(next)) next[SHARED_VOICE_KEY] = voiceId;
  else delete next[SHARED_VOICE_KEY];
  return next;
}
