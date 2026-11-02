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
