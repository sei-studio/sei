/**
 * sttPolicy (260725; SenseVoice 260816) — pure call-time STT mode selection.
 *
 * Decides, from the persisted config + AI backend kind (+ the local speech
 * pack state), how a voice call transcribes speech:
 *
 *   - cloud-proxy, no local-fallback opt-in → localModel 'none': Scribe is
 *     primary, no local engine boots at all, so calls connect immediately.
 *   - cloud-proxy, stt_local_fallback === true → 'eager': the local engine
 *     races cloud Scribe per utterance. The engine is Whisper, EXCEPT the one
 *     sanctioned cloud-behavior change (260816): a zh-UI user whose SenseVoice
 *     pack is already downloaded gets SenseVoice as the fallback engine
 *     (dramatically better zh accuracy, no 40MB Whisper download). Not
 *     downloaded → Whisper, exactly as before.
 *   - local (BYOK) → always 'eager':
 *       stt_engine absent/'scribe' → Whisper local + cloud Scribe on top.
 *       'whisper'    → Whisper only.
 *       'sensevoice' → SenseVoice (main-side sherpa) only; pack not
 *                      downloaded → Whisper behavior (the model-missing rule).
 *
 * Structurally typed (not Pick<UserConfig>) so this module stands alone;
 * UserConfig's optional stt_* fields satisfy it.
 */

export type SttLocalModel = 'eager' | 'none';

/** Which engine serves the LOCAL leg of the race (meaningful when 'eager'). */
export type SttLocalEngine = 'whisper' | 'sensevoice';

export interface SttPolicyConfig {
  stt_engine?: 'scribe' | 'whisper' | 'sensevoice';
  stt_local_fallback?: boolean;
}

export interface SttPolicyOpts {
  /** APP UI language (UserConfig.ui_language); only 'zh' changes anything. */
  uiLanguage?: string;
  /** The SenseVoice pack is downloaded and usable (speech:pack-status). */
  sensevoiceReady?: boolean;
}

export interface SttPolicy {
  /** Whether dictation boots a local engine ('eager') or skips it. */
  localModel: SttLocalModel;
  /** Which local engine backs the 'eager' leg. */
  localEngine: SttLocalEngine;
  /** Whether cloud (Scribe) transcription is wired into the call at all. */
  useCloud: boolean;
}

export function sttPolicy(
  cfg: SttPolicyConfig | null | undefined,
  backendKind: 'local' | 'cloud-proxy',
  opts?: SttPolicyOpts,
): SttPolicy {
  const sensevoiceReady = opts?.sensevoiceReady === true;
  if (backendKind === 'cloud-proxy') {
    // The one sanctioned cloud change (260816): the local-fallback ENGINE
    // prefers SenseVoice for zh-UI users when the pack is already on disk.
    // Everything else about cloud behavior is byte-identical.
    const engine: SttLocalEngine =
      opts?.uiLanguage === 'zh' && sensevoiceReady ? 'sensevoice' : 'whisper';
    return cfg?.stt_local_fallback === true
      ? { localModel: 'eager', localEngine: engine, useCloud: true }
      : { localModel: 'none', localEngine: engine, useCloud: true };
  }
  // BYOK: absent stt_engine means 'scribe' (cloud on top of the local race).
  const engine = cfg?.stt_engine ?? 'scribe';
  if (engine === 'sensevoice') {
    // Model missing → keep Whisper behavior (local-only either way: picking
    // SenseVoice was a choice to keep speech off the cloud).
    return {
      localModel: 'eager',
      localEngine: sensevoiceReady ? 'sensevoice' : 'whisper',
      useCloud: false,
    };
  }
  return { localModel: 'eager', localEngine: 'whisper', useCloud: engine !== 'whisper' };
}
