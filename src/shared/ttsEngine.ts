/**
 * Local TTS model choice (261102). `tts_engine` says WHO speaks in local
 * (BYOK) mode: ElevenLabs or an on-device voice. `local_tts_model` says WHICH
 * on-device model: 'fast' (the original sherpa-onnx voice packs, the default)
 * or 'kokoro'. Absent or unknown means 'fast', so nobody is moved to Kokoro
 * without choosing it.
 */
export type LocalTtsModel = 'fast' | 'kokoro';

export function localTtsModel(config: { local_tts_model?: unknown } | null | undefined): LocalTtsModel {
  return config?.local_tts_model === 'kokoro' ? 'kokoro' : 'fast';
}
