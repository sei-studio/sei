import { describe, it, expect, vi } from 'vitest';
import { kokoroConfig, KOKORO_VOICES, pickKokoroVoice } from './kokoro';
import { SPEECH_PACKS, isSpeechPackId } from './packs';

const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  generate: vi.fn(),
  create: vi.fn(),
}));
vi.mock('./packStore', () => ({ packReady: mocks.ready, packModelDir: () => '/models/kokoro' }));
vi.mock('../bundleRequire', () => ({ bundleRequire: () => () => ({ OfflineTts: { createAsync: mocks.create } }) }));

describe('Kokoro local synthesis', () => {
  it('selects by language and gender without guessing an unavailable match', () => {
    expect(pickKokoroVoice('female', 'en')).toBe('af_heart');
    expect(pickKokoroVoice('male', 'en-US')).toBe('am_michael');
    expect(pickKokoroVoice('female', 'es')).toBe('ef_dora');
    expect(pickKokoroVoice('male', 'es')).toBe('em_alex');
    expect(pickKokoroVoice('female', 'fr')).toBe('ff_siwis');
    expect(pickKokoroVoice('male', 'fr')).toBeNull();
    expect(pickKokoroVoice('female', 'it')).toBe('if_sara');
    expect(pickKokoroVoice('male', 'it')).toBe('im_nicola');
    for (const language of ['ja', 'zh', 'ko', 'constructor', '__proto__']) {
      expect(pickKokoroVoice('female', language)).toBeNull();
    }
  });
  it('registers an optional pack with its actual release size', () => {
    expect(isSpeechPackId('tts-kokoro')).toBe(true);
    expect(SPEECH_PACKS['tts-kokoro'].archiveBytes).toBe(132353410);
    expect(SPEECH_PACKS['tts-kokoro'].requiredFiles).toContain('LICENSE');
  });
  it('uses the v1.0 speaker order and language-specific phonemizers', () => {
    expect(KOKORO_VOICES.af_heart).toEqual({ sid: 3, lang: 'en-us', rate: 0.8 });
    expect(KOKORO_VOICES.if_sara).toEqual({ sid: 35, lang: 'it', rate: 1 });
    expect(kokoroConfig('/models', 'if_sara').model.kokoro.lang).toBe('it');
  });
  it('requires an installed pack, retries failed loads, keeps engines apart and rejects empty audio', async () => {
    const { synthesizeKokoro } = await import('./engine');
    mocks.ready.mockResolvedValue(false);
    await expect(synthesizeKokoro('Ciao', 'if_sara')).rejects.toThrow('VOICE_PACK_MISSING:tts-kokoro');
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.ready.mockResolvedValue(true);
    mocks.create.mockRejectedValueOnce(new Error('load failed'));
    await expect(synthesizeKokoro('Ciao', 'if_sara')).rejects.toThrow('load failed');
    mocks.create.mockResolvedValue({ generateAsync: mocks.generate });
    mocks.generate.mockResolvedValue({ samples: new Float32Array([0.1, -0.1]), sampleRate: 24000 });
    await synthesizeKokoro('Ciao', 'if_sara');
    await synthesizeKokoro('Hello', 'af_heart');
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.generate).toHaveBeenLastCalledWith({ text: 'Hello', sid: 3, speed: 0.8, enableExternalBuffer: false });
    await synthesizeKokoro('Ancora', 'if_sara');
    await synthesizeKokoro('Hello again', 'am_michael');
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.generate).toHaveBeenLastCalledWith({ text: 'Hello again', sid: 16, speed: 1, enableExternalBuffer: false });
    mocks.generate.mockResolvedValue({ samples: new Float32Array(), sampleRate: 24000 });
    await expect(synthesizeKokoro('Ciao', 'if_sara')).rejects.toThrow('VOICE_TTS_FAILED');
    mocks.ready.mockResolvedValue(false);
    await expect(synthesizeKokoro('Removed', 'if_sara')).rejects.toThrow('VOICE_PACK_MISSING');
  });
});
