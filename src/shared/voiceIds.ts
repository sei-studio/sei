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
