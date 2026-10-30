/** Read the engine, including profiles written by the first Kokoro preview. */
export function selectedTtsEngine(config: {
  tts_engine?: 'elevenlabs' | 'local' | 'kokoro';
  local_tts_voice?: 'auto' | 'af_heart' | 'if_sara';
}): 'elevenlabs' | 'local' | 'kokoro' {
  if (config.tts_engine === 'local' &&
      (config.local_tts_voice === 'af_heart' || config.local_tts_voice === 'if_sara')) {
    return 'kokoro';
  }
  return config.tts_engine ?? 'elevenlabs';
}
