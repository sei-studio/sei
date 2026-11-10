/**
 * Local TTS model choice (261102). `tts_engine` says WHO speaks in local
 * (BYOK) mode: ElevenLabs or a "local voice". `local_tts_model` says WHICH
 * local voice: 'fast' (the original sherpa-onnx voice packs, the default),
 * 'kokoro', or (261103) 'fish': Fish Audio's free online model with the
 * user's own Fish API key (main/voice/fishTts.ts). Absent or unknown means
 * 'fast', so nobody is moved off the Fast voices without choosing it.
 */
export type LocalTtsModel = 'fast' | 'kokoro' | 'fish';

export function localTtsModel(config: { local_tts_model?: unknown } | null | undefined): LocalTtsModel {
  const v = config?.local_tts_model;
  return v === 'kokoro' || v === 'fish' ? v : 'fast';
}

/**
 * "Sei voices" with the ChatGPT brain (261110, product call 261110): a
 * ChatGPT-plan user (ai_backend_kind 'local' + provider 'chatgpt') can keep
 * Sei's cloud voices, billed to the account's existing weekly allowance like
 * a cloud call, instead of on-device or own-key voices. Chosen on Playtime >
 * ChatGPT > Voice, stored as tts_engine 'sei'. Any other setup ignores the
 * value (an own-key setup reads 'sei' as "not local", the ElevenLabs engine).
 */
export function seiVoicesActive(
  config: { ai_backend_kind?: unknown; provider?: unknown; tts_engine?: unknown } | null | undefined,
): boolean {
  return (
    config?.ai_backend_kind === 'local' && config?.provider === 'chatgpt' && config?.tts_engine === 'sei'
  );
}

/** Where a companion's voice comes from, as the Playtime Voice picker shows it. */
export type VoiceSource = 'sei' | 'device' | 'elevenlabs' | 'fish';

/**
 * The Voice picker's current choice for an off-cloud setup. 'device' covers
 * the Fast and Kokoro packs; 'fish' is Fish Audio with the user's key.
 */
export function voiceSourceOf(
  config: {
    ai_backend_kind?: unknown;
    provider?: unknown;
    tts_engine?: unknown;
    local_tts_model?: unknown;
  } | null | undefined,
): VoiceSource {
  if (seiVoicesActive(config)) return 'sei';
  if (config?.tts_engine === 'local') return localTtsModel(config) === 'fish' ? 'fish' : 'device';
  return 'elevenlabs';
}
