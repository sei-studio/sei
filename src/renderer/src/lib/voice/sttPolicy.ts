/**
 * sttPolicy (260725) — pure call-time STT mode selection.
 *
 * Decides, from the persisted config + AI backend kind, how a voice call
 * transcribes speech:
 *
 *   - cloud-proxy, no local-fallback opt-in → localModel 'none': Scribe is
 *     primary, the Whisper worker (and its ~40MB model download) is skipped
 *     entirely, so calls connect immediately.
 *   - cloud-proxy, stt_local_fallback === true → 'eager': today's race
 *     (local Whisper boots up front, cloud Scribe races it per utterance).
 *   - local (BYOK) → always 'eager' (Whisper stays the install path);
 *     cloud Scribe rides on top only when stt_engine is not 'whisper'.
 *     Key presence is NOT gated here: main answers voiceStt with
 *     unavailable/'no-credentials' when no key (user or dev env) exists,
 *     which silently disables cloud for the call — so dev-key setups keep
 *     working without the renderer knowing about them.
 *
 * Structurally typed (not Pick<UserConfig>) so this module stands alone;
 * UserConfig's optional stt_* fields satisfy it.
 */

export type SttLocalModel = 'eager' | 'none';

export interface SttPolicyConfig {
  stt_engine?: 'scribe' | 'whisper';
  stt_local_fallback?: boolean;
}

export interface SttPolicy {
  /** Whether dictation boots the local Whisper worker ('eager') or skips it. */
  localModel: SttLocalModel;
  /** Whether cloud (Scribe) transcription is wired into the call at all. */
  useCloud: boolean;
}

export function sttPolicy(
  cfg: SttPolicyConfig | null | undefined,
  backendKind: 'local' | 'cloud-proxy',
): SttPolicy {
  if (backendKind === 'cloud-proxy') {
    return cfg?.stt_local_fallback === true
      ? { localModel: 'eager', useCloud: true }
      : { localModel: 'none', useCloud: true };
  }
  // BYOK: absent stt_engine means 'scribe' (cloud on top of the local race).
  return { localModel: 'eager', useCloud: (cfg?.stt_engine ?? 'scribe') !== 'whisper' };
}
