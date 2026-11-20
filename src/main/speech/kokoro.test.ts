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
  it('requires an installed pack, keeps engines apart per language and rejects empty audio', async () => {
    const { synthesizeKokoro, releaseKokoroEngines } = await import('./engine');
    releaseKokoroEngines();
    mocks.create.mockReset(); mocks.generate.mockReset();
    mocks.ready.mockResolvedValue(false);
    await expect(synthesizeKokoro('Ciao', 'if_sara')).rejects.toThrow('VOICE_PACK_MISSING:tts-kokoro');
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.ready.mockResolvedValue(true);
    mocks.create.mockResolvedValue({ generateAsync: mocks.generate });
    mocks.generate.mockResolvedValue({ samples: new Float32Array([0.1, -0.1]), sampleRate: 24000 });
    await synthesizeKokoro('Ciao', 'if_sara');
    await synthesizeKokoro('Hello', 'af_heart');
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.generate).toHaveBeenLastCalledWith({ text: 'Hello', sid: 3, speed: KOKORO_VOICES.af_heart.rate, enableExternalBuffer: false });
    await synthesizeKokoro('Ancora', 'if_sara');
    await synthesizeKokoro('Hello again', 'am_michael');
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.generate).toHaveBeenLastCalledWith({ text: 'Hello again', sid: 16, speed: 1, enableExternalBuffer: false });
    mocks.generate.mockResolvedValue({ samples: new Float32Array(), sampleRate: 24000 });
    await expect(synthesizeKokoro('Ciao', 'if_sara')).rejects.toThrow('VOICE_TTS_FAILED');
    mocks.ready.mockResolvedValue(false);
    await expect(synthesizeKokoro('Removed', 'if_sara')).rejects.toThrow('VOICE_PACK_MISSING');
    releaseKokoroEngines();
  });

  it('frees engines on release and after the idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const engine = await import('./engine');
      engine.releaseKokoroEngines();
      mocks.create.mockReset().mockResolvedValue({ generateAsync: mocks.generate });
      mocks.generate.mockReset().mockResolvedValue({ samples: new Float32Array([0.1]), sampleRate: 24000 });
      mocks.ready.mockResolvedValue(true);
      await engine.synthesizeKokoro('Hello', 'af_heart');
      await engine.synthesizeKokoro('Hola', 'ef_dora');
      expect(engine._kokoroEngineCountForTests()).toBe(2);
      // Explicit release (switched away from Kokoro, pack removed).
      engine.releaseKokoroEngines('test');
      expect(engine._kokoroEngineCountForTests()).toBe(0);
      await engine.synthesizeKokoro('Hello', 'af_heart');
      expect(mocks.create).toHaveBeenCalledTimes(3);
      // Idle: each line re-arms the timer; nothing frees while in use.
      vi.advanceTimersByTime(engine.KOKORO_IDLE_RELEASE_MS - 1000);
      await engine.synthesizeKokoro('Still here', 'af_heart');
      vi.advanceTimersByTime(engine.KOKORO_IDLE_RELEASE_MS - 1000);
      expect(engine._kokoroEngineCountForTests()).toBe(1);
      vi.advanceTimersByTime(2000);
      expect(engine._kokoroEngineCountForTests()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not free an engine while a line is still synthesizing', async () => {
    vi.useFakeTimers();
    try {
      const engine = await import('./engine');
      engine.releaseKokoroEngines();
      let finish: (v: { samples: Float32Array; sampleRate: number }) => void = () => {};
      mocks.create.mockReset().mockResolvedValue({ generateAsync: mocks.generate });
      mocks.generate.mockReset().mockResolvedValueOnce({ samples: new Float32Array([0.1]), sampleRate: 24000 })
        .mockImplementationOnce(() => new Promise((r) => { finish = r; }));
      mocks.ready.mockResolvedValue(true);
      await engine.synthesizeKokoro('One', 'af_heart');
      const slow = engine.synthesizeKokoro('Two', 'af_heart');
      await vi.advanceTimersByTimeAsync(engine.KOKORO_IDLE_RELEASE_MS * 2);
      expect(engine._kokoroEngineCountForTests()).toBe(1);
      finish({ samples: new Float32Array([0.1]), sampleRate: 24000 });
      await slow;
      vi.advanceTimersByTime(engine.KOKORO_IDLE_RELEASE_MS + 1);
      expect(engine._kokoroEngineCountForTests()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remembers a failed load for a while instead of reloading on every line', async () => {
    vi.useFakeTimers();
    try {
      const engine = await import('./engine');
      engine.releaseKokoroEngines();
      mocks.ready.mockResolvedValue(true);
      mocks.create.mockReset().mockRejectedValue(new Error('load failed'));
      await expect(engine.synthesizeKokoro('Hello', 'af_heart')).rejects.toThrow('load failed');
      await expect(engine.synthesizeKokoro('Hello', 'af_heart')).rejects.toThrow('VOICE_TTS_FAILED: Kokoro could not load: load failed');
      expect(mocks.create).toHaveBeenCalledTimes(1);
      // After the backoff it tries again.
      vi.advanceTimersByTime(engine.KOKORO_RETRY_AFTER_FAIL_MS + 1);
      mocks.create.mockResolvedValue({ generateAsync: mocks.generate });
      mocks.generate.mockReset().mockResolvedValue({ samples: new Float32Array([0.1]), sampleRate: 24000 });
      await engine.synthesizeKokoro('Hello', 'af_heart');
      expect(mocks.create).toHaveBeenCalledTimes(2);
      // A release (e.g. the pack was re-downloaded) clears the memory at once.
      mocks.create.mockReset().mockRejectedValueOnce(new Error('again'));
      engine.releaseKokoroEngines();
      await expect(engine.synthesizeKokoro('Hello', 'af_heart')).rejects.toThrow('again');
      engine.releaseKokoroEngines();
      mocks.create.mockResolvedValue({ generateAsync: mocks.generate });
      await engine.synthesizeKokoro('Hello', 'af_heart');
      expect(mocks.create).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      (await import('./engine')).releaseKokoroEngines();
    }
  });
});
