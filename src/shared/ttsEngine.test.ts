import { describe, expect, it } from 'vitest';
import { selectedTtsEngine } from './ttsEngine';
import { UserConfigSchema } from './characterSchema';

describe('TTS engine compatibility', () => {
  it('accepts Kokoro and preserves defaults and old preview profiles', () => {
    expect(UserConfigSchema.parse({ tts_engine: 'kokoro' }).tts_engine).toBe('kokoro');
    expect(selectedTtsEngine({})).toBe('elevenlabs');
    expect(selectedTtsEngine({ tts_engine: 'local' })).toBe('local');
    expect(selectedTtsEngine({ tts_engine: 'local', local_tts_voice: 'if_sara' })).toBe('kokoro');
    expect(selectedTtsEngine({ tts_engine: 'local', local_tts_voice: 'af_heart' })).toBe('kokoro');
    expect(selectedTtsEngine({ tts_engine: 'elevenlabs', local_tts_voice: 'if_sara' })).toBe('elevenlabs');
    expect(selectedTtsEngine({ tts_engine: 'local', local_tts_voice: 'auto' })).toBe('local');
  });
});
