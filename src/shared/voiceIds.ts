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

export interface OwnVoicePick {
  name: string;
  gender?: string;
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
  const raw = metadata[OWN_VOICE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const { name, gender } = raw as { name?: unknown; gender?: unknown };
  if (typeof name !== 'string' || !name.trim()) return null;
  return {
    name: name.slice(0, 100),
    ...(typeof gender === 'string' && gender ? { gender: gender.slice(0, 20) } : {}),
  };
}

/**
 * Apply a voice-picker selection to character metadata (returns a copy).
 * `voiceId` null = Auto (key removed), NO_VOICE_ID = silent, else a pinned
 * voice. `own` is set only for an own-account pick; any other selection
 * clears the marker, so switching back to a Sei voice can never leave a stale
 * own-voice flag that would shield a pool id from the normal rules. A pool
 * id never takes the marker, even when a caller passes one (261024).
 */
export function applyVoicePick(
  metadata: Record<string, unknown> | undefined | null,
  voiceId: string | null,
  own?: OwnVoicePick | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(metadata ?? {}) };
  if (voiceId === null) delete next.voiceId;
  else next.voiceId = voiceId;
  if (own && voiceId !== null && isWellFormedVoiceId(voiceId) && !isPoolVoiceId(voiceId) && own.name.trim()) {
    next[OWN_VOICE_KEY] = {
      name: own.name.slice(0, 100),
      ...(own.gender ? { gender: own.gender.slice(0, 20) } : {}),
    };
  } else {
    delete next[OWN_VOICE_KEY];
    // The voice for others only stands in for an own voice.
    delete next[SHARED_VOICE_KEY];
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
