import { describe, it, expect, vi, beforeEach } from 'vitest';
const m = vi.hoisted(() => ({
  config: { tts_engine: 'kokoro', chat_language: 'en', local_tts_voice: 'auto' },
  backend: 'local', gender: 'female', own: false,
  synthesize: vi.fn(), local: vi.fn(), ready: vi.fn(), route: vi.fn(),
  character: { id: 'c1', name: 'Test', metadata: { voiceId: 'voice123456789', language: undefined as string | undefined } },
}));
vi.mock('../configStore', () => ({ loadConfig: async () => m.config }));
vi.mock('../apiKeyStore', () => ({ getAiBackendKind: async () => m.backend }));
vi.mock('../characterStore', () => ({ getCharacter: async () => m.character }));
vi.mock('./voiceAssign', () => ({
  resolveVoiceId: async () => 'voice123456789',
  ownVoicePickOf: () => m.own ? { gender: m.gender } : null,
  isPoolVoiceId: () => true, ownVoiceStandInId: () => 'voice123456789',
}));
vi.mock('../speech', async () => ({
  ...await import('../speech/localVoice'),
  ...await import('../speech/packs'),
  ...await import('../speech/kokoro'),
  ...await import('../speech/spokenLanguage'),
  packMissingError: (id: string) => new Error(`VOICE_PACK_MISSING:${id}`),
  synthesizeKokoro: m.synthesize, synthesizeLocal: m.local, packReady: m.ready,
  voiceGenderFor: (_id: string, hint?: string) => hint ?? m.gender,
}));
vi.mock('../auth/supabaseClient', () => ({ getClient: () => null }));
vi.mock('./elevenLabsKeyStore', () => ({ resolveElevenLabsRoute: m.route, resolveTtsRoute: m.route }));
vi.mock('./ownVoices', () => ({ isOwnVoiceId: () => false }));
vi.mock('../creditWall', () => ({ noteCreditWall: vi.fn() }));
vi.mock('./stt', () => ({ encodeWav: () => new TextEncoder().encode('RIFF').buffer }));
import { voiceTts, voicePreviewTts, voiceTtsStream } from './tts';

describe('Kokoro TTS routing', () => {
  beforeEach(() => {
    Object.assign(m.config, { tts_engine: 'kokoro', chat_language: 'en', local_tts_voice: 'auto' });
    m.backend = 'local'; m.gender = 'female'; m.own = false;
    m.character.metadata.voiceId = 'voice123456789';
    m.character.metadata.language = undefined;
    const audio = { samples: new Float32Array([0.1]), sampleRate: 24000 };
    m.synthesize.mockReset().mockResolvedValue(audio);
    m.local.mockReset().mockResolvedValue(audio);
    m.ready.mockReset().mockImplementation(async (id) => id === 'tts-en' || id === 'tts-zh');
    m.route.mockReset().mockResolvedValue({ kind: 'unconfigured' });
  });
  it('selects each call and preview by language/gender, preserving character identity', async () => {
    await voiceTts({ characterId: 'c1', text: 'Hello Marco.' });
    expect(m.synthesize).toHaveBeenLastCalledWith(expect.any(String), 'af_heart');
    m.gender = 'male'; m.own = true;
    await voiceTts({ characterId: 'c1', text: 'Hello again.' });
    expect(m.synthesize).toHaveBeenLastCalledWith(expect.any(String), 'am_michael');
    m.config.chat_language = 'es';
    await voiceTts({ characterId: 'c1', text: 'Hola Marco.' });
    expect(m.synthesize).toHaveBeenLastCalledWith(expect.any(String), 'em_alex');
    m.character.metadata.language = 'en';
    await voicePreviewTts({ characterId: 'c1' });
    expect(m.synthesize).toHaveBeenLastCalledWith(expect.any(String), 'am_michael');
    expect(m.character.metadata.voiceId).toBe('voice123456789');
    expect(m.route).not.toHaveBeenCalled();
  });
  it('uses standard local voices for unmatched language/gender and standard Local mode', async () => {
    m.config.chat_language = 'fr'; m.gender = 'male';
    await voiceTts({ characterId: 'c1', text: 'Bonjour Marco.' });
    expect(m.local).toHaveBeenLastCalledWith(expect.any(String), 'en-m');
    m.config.chat_language = 'zh';
    await voiceTts({ characterId: 'c1', text: '你好，朋友。' });
    expect(m.local).toHaveBeenLastCalledWith(expect.any(String), 'zh-m');
    m.config.tts_engine = 'local'; m.config.chat_language = 'en';
    await voiceTts({ characterId: 'c1', text: 'Hello.' });
    expect(m.local).toHaveBeenLastCalledWith(expect.any(String), 'en-m');
    expect(m.synthesize).not.toHaveBeenCalled();
  });
  it('keeps missing-pack errors, silent companions, and cloud routing', async () => {
    m.synthesize.mockRejectedValue(new Error('VOICE_PACK_MISSING:tts-kokoro'));
    await expect(voiceTts({ characterId: 'c1', text: 'Hello.' })).rejects.toThrow('VOICE_PACK_MISSING:tts-kokoro');
    m.synthesize.mockClear(); m.character.metadata.voiceId = 'none';
    await expect(voiceTts({ characterId: 'c1', text: 'Hello.' })).rejects.toThrow('VOICE_DISABLED');
    await expect(voicePreviewTts({ characterId: 'c1' })).rejects.toThrow('VOICE_DISABLED');
    await expect(voiceTtsStream({ characterId: 'c1', text: 'Hello.' }, () => {})).rejects.toThrow('VOICE_DISABLED');
    expect(m.synthesize).not.toHaveBeenCalled();
    m.character.metadata.voiceId = 'voice123456789'; m.backend = 'cloud-proxy';
    m.route.mockRejectedValue(new Error('cloud route reached'));
    await expect(voiceTts({ characterId: 'c1', text: 'Hello.' })).rejects.toThrow('cloud route reached');
    expect(m.synthesize).not.toHaveBeenCalled();
    expect(m.route).toHaveBeenCalled();
  });
});
