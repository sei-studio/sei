import { describe, it, expect, vi, beforeEach } from 'vitest';
const m = vi.hoisted(() => ({
  config: { tts_engine: 'local', local_tts_model: 'kokoro', chat_language: 'en' } as Record<string, unknown>,
  backend: 'local', gender: 'female', own: false,
  synthesize: vi.fn(), local: vi.fn(), ready: vi.fn(), route: vi.fn(), release: vi.fn(),
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
  releaseKokoroEngines: m.release,
  voiceGenderFor: (_id: string, hint?: string) => hint ?? m.gender,
}));
vi.mock('../auth/supabaseClient', () => ({ getClient: () => null }));
vi.mock('./elevenLabsKeyStore', () => ({ resolveElevenLabsRoute: m.route, resolveTtsRoute: m.route }));
vi.mock('./ownVoices', () => ({ isOwnVoiceId: () => false }));
vi.mock('../creditWall', () => ({ noteCreditWall: vi.fn() }));
vi.mock('./stt', () => ({ encodeWav: () => new TextEncoder().encode('RIFF').buffer }));
import { voiceTts, voicePreviewTts, voiceTtsStream, onTtsNotice, type TtsNotice } from './tts';

const notices: TtsNotice[] = [];
onTtsNotice((n) => notices.push(n));

describe('Kokoro TTS routing', () => {
  beforeEach(() => {
    for (const k of Object.keys(m.config)) delete m.config[k];
    Object.assign(m.config, { tts_engine: 'local', local_tts_model: 'kokoro', chat_language: 'en' });
    m.backend = 'local'; m.gender = 'female'; m.own = false;
    m.character.metadata.voiceId = 'voice123456789';
    m.character.metadata.language = undefined;
    const audio = { samples: new Float32Array([0.1]), sampleRate: 24000 };
    m.synthesize.mockReset().mockResolvedValue(audio);
    m.local.mockReset().mockResolvedValue(audio);
    m.release.mockReset();
    m.ready.mockReset().mockImplementation(async (id) => id === 'tts-en' || id === 'tts-zh');
    m.route.mockReset().mockResolvedValue({ kind: 'unconfigured' });
    notices.length = 0;
  });

  it('selects each call line by language/gender, preserving character identity', async () => {
    await voiceTts({ characterId: 'c1', text: 'Hello Marco.' });
    expect(m.synthesize).toHaveBeenLastCalledWith(expect.any(String), 'af_heart');
    m.gender = 'male'; m.own = true;
    await voiceTts({ characterId: 'c1', text: 'Hello again.' });
    expect(m.synthesize).toHaveBeenLastCalledWith(expect.any(String), 'am_michael');
    m.config.chat_language = 'es';
    await voiceTts({ characterId: 'c1', text: 'Hola Marco.' });
    expect(m.synthesize).toHaveBeenLastCalledWith(expect.any(String), 'em_alex');
    expect(m.character.metadata.voiceId).toBe('voice123456789');
    expect(m.route).not.toHaveBeenCalled();
    expect(m.local).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('uses the Fast voices for unmatched language/gender, and when Fast is the choice', async () => {
    m.config.chat_language = 'fr'; m.gender = 'male';
    await voiceTts({ characterId: 'c1', text: 'Bonjour Marco.' });
    expect(m.local).toHaveBeenLastCalledWith(expect.any(String), 'en-m');
    m.config.chat_language = 'zh';
    await voiceTts({ characterId: 'c1', text: '你好，朋友。' });
    expect(m.local).toHaveBeenLastCalledWith(expect.any(String), 'zh-m');
    expect(m.synthesize).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
    // Fast chosen explicitly, or nothing saved (the default): never Kokoro,
    // and any loaded Kokoro engine is freed.
    m.config.local_tts_model = 'fast'; m.config.chat_language = 'en';
    await voiceTts({ characterId: 'c1', text: 'Hello.' });
    delete m.config.local_tts_model;
    await voiceTts({ characterId: 'c1', text: 'Hello.' });
    expect(m.local).toHaveBeenLastCalledWith(expect.any(String), 'en-m');
    expect(m.synthesize).not.toHaveBeenCalled();
    expect(m.release).toHaveBeenCalledTimes(2);
  });

  it('falls back to Fast with a notice when the Kokoro pack is missing', async () => {
    m.synthesize.mockRejectedValue(new Error('VOICE_PACK_MISSING:tts-kokoro'));
    const buf = await voiceTts({ characterId: 'c1', text: 'Hello.' });
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(m.local).toHaveBeenLastCalledWith(expect.any(String), 'en-f');
    expect(notices).toEqual([{ kind: 'kokoro-fallback', characterId: 'c1', reason: 'pack-missing' }]);
  });

  it('falls back to Fast with a notice when Kokoro fails to load or speak', async () => {
    m.synthesize.mockRejectedValue(new Error('VOICE_TTS_FAILED: Kokoro could not load: bad model'));
    await voiceTts({ characterId: 'c1', text: 'Hello.' });
    expect(m.local).toHaveBeenLastCalledWith(expect.any(String), 'en-f');
    expect(notices).toEqual([{ kind: 'kokoro-fallback', characterId: 'c1', reason: 'failed' }]);
  });

  it('names the Kokoro pack when neither Kokoro nor any Fast pack is installed', async () => {
    m.ready.mockResolvedValue(false);
    m.synthesize.mockRejectedValue(new Error('VOICE_PACK_MISSING:tts-kokoro'));
    await expect(voiceTts({ characterId: 'c1', text: 'Hello.' })).rejects.toThrow('VOICE_PACK_MISSING:tts-kokoro');
    // Fast chosen and nothing installed: the Fast pack is named, as before.
    m.config.local_tts_model = 'fast';
    await expect(voiceTts({ characterId: 'c1', text: 'Hello.' })).rejects.toThrow('VOICE_PACK_MISSING:tts-en');
  });

  it('keeps silent companions silent and cloud accounts on the cloud route', async () => {
    m.character.metadata.voiceId = 'none';
    await expect(voiceTts({ characterId: 'c1', text: 'Hello.' })).rejects.toThrow('VOICE_DISABLED');
    await expect(voiceTtsStream({ characterId: 'c1', text: 'Hello.' }, () => {})).rejects.toThrow('VOICE_DISABLED');
    expect(m.synthesize).not.toHaveBeenCalled();
    m.character.metadata.voiceId = 'voice123456789'; m.backend = 'cloud-proxy';
    m.route.mockRejectedValue(new Error('cloud route reached'));
    await expect(voiceTts({ characterId: 'c1', text: 'Hello.' })).rejects.toThrow('cloud route reached');
    expect(m.synthesize).not.toHaveBeenCalled();
    expect(m.route).toHaveBeenCalled();
  });
});

describe('local voice preview (Fast and Kokoro)', () => {
  beforeEach(() => {
    for (const k of Object.keys(m.config)) delete m.config[k];
    Object.assign(m.config, { tts_engine: 'local', chat_language: 'en' });
    m.backend = 'local'; m.gender = 'female'; m.own = false;
    m.character.metadata.voiceId = 'voice123456789';
    m.character.metadata.language = undefined;
    const audio = { samples: new Float32Array([0.1]), sampleRate: 24000 };
    m.synthesize.mockReset().mockResolvedValue(audio);
    m.local.mockReset().mockResolvedValue(audio);
    m.ready.mockReset().mockImplementation(async (id) => id === 'tts-en' || id === 'tts-zh');
    m.route.mockReset().mockResolvedValue({ kind: 'unconfigured' });
  });

  it('Fast: speaks the chat-language sample line with the Fast voice', async () => {
    await voicePreviewTts({ characterId: 'c1' });
    expect(m.local).toHaveBeenLastCalledWith('Hi, this is what I sound like.', 'en-f');
    m.config.chat_language = 'zh';
    await voicePreviewTts({ characterId: 'c1' });
    expect(m.local).toHaveBeenLastCalledWith(expect.stringContaining('这就是我的声音'), 'zh-f');
    expect(m.synthesize).not.toHaveBeenCalled();
  });

  it('Fast: a companion with no voice yet still previews the picked voice (pre-Kokoro behavior)', async () => {
    m.character.metadata.voiceId = 'none';
    const buf = await voicePreviewTts({ characterId: 'c1', voiceId: 'voice123456789' });
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(m.local).toHaveBeenLastCalledWith('Hi, this is what I sound like.', 'en-f');
  });

  it('Fast: the sample follows the chat language, not a character pin (pre-Kokoro behavior)', async () => {
    m.character.metadata.language = 'zh';
    await voicePreviewTts({ characterId: 'c1' });
    expect(m.local).toHaveBeenLastCalledWith('Hi, this is what I sound like.', 'en-f');
  });

  it('Kokoro: previews with the Kokoro voice the call would use', async () => {
    m.config.local_tts_model = 'kokoro';
    await voicePreviewTts({ characterId: 'c1' });
    expect(m.synthesize).toHaveBeenLastCalledWith('Hi, this is what I sound like.', 'af_heart');
    m.gender = 'male'; m.config.chat_language = 'es';
    await voicePreviewTts({ characterId: 'c1' });
    expect(m.synthesize).toHaveBeenLastCalledWith(expect.stringContaining('sueno'), 'em_alex');
    m.character.metadata.voiceId = 'none';
    await voicePreviewTts({ characterId: 'c1', voiceId: 'voice123456789' });
    expect(m.local).not.toHaveBeenCalled();
  });

  it('Kokoro: a missing pack previews with the Fast voice instead of failing', async () => {
    m.config.local_tts_model = 'kokoro';
    m.synthesize.mockRejectedValue(new Error('VOICE_PACK_MISSING:tts-kokoro'));
    const buf = await voicePreviewTts({ characterId: 'c1' });
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(m.local).toHaveBeenLastCalledWith('Hi, this is what I sound like.', 'en-f');
  });
});
