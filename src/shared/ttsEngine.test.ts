import { describe, expect, it } from 'vitest';
import { SEI_VOICES_FOR_CHATGPT_ENABLED, localTtsModel, seiVoicesActive, voiceSourceOf } from './ttsEngine';
import { UserConfigSchema } from './characterSchema';

describe('local TTS model setting', () => {
  it('defaults to Fast when nothing is saved', () => {
    expect(localTtsModel({})).toBe('fast');
    expect(localTtsModel(null)).toBe('fast');
    expect(localTtsModel(UserConfigSchema.parse({ tts_engine: 'local' }))).toBe('fast');
  });

  it('reads an explicit choice', () => {
    expect(localTtsModel(UserConfigSchema.parse({ local_tts_model: 'kokoro' }))).toBe('kokoro');
    expect(localTtsModel(UserConfigSchema.parse({ local_tts_model: 'fast' }))).toBe('fast');
    expect(localTtsModel(UserConfigSchema.parse({ local_tts_model: 'fish' }))).toBe('fish');
  });

  it('parses Fish Audio voice overrides sparsely and strictly (261103)', () => {
    const id = '0123456789abcdef0123456789abcdef';
    expect(UserConfigSchema.parse({}).fish_voice_overrides).toBeUndefined();
    const ok = UserConfigSchema.parse({ fish_voice_overrides: { c1: { id, name: 'Calm' }, c2: { id, name: 'Fast', speed: 1.5 } } });
    expect(ok.fish_voice_overrides).toEqual({ c1: { id, name: 'Calm' }, c2: { id, name: 'Fast', speed: 1.5 } });
    for (const bad of [
      { c1: { id: 'not-an-id', name: 'x' } },
      { c1: { id, name: 'x'.repeat(121) } },
      { c1: { id, name: 'x', speed: 3 } },
      { c1: { name: 'x' } },
    ]) {
      expect(UserConfigSchema.safeParse({ fish_voice_overrides: bad }).success).toBe(false);
    }
  });

  it('never moves an unreleased-preview profile to Kokoro', () => {
    // PR #49's preview wrote local_tts_voice; it is an unknown key now.
    const parsed = UserConfigSchema.parse({ tts_engine: 'local', local_tts_voice: 'af_heart' });
    expect(parsed.tts_engine).toBe('local');
    expect('local_tts_voice' in parsed).toBe(false);
    expect(localTtsModel(parsed)).toBe('fast');
    expect(localTtsModel({ local_tts_model: 'af_heart' })).toBe('fast');
  });

  it('keeps tts_engine to the two engines', () => {
    expect(UserConfigSchema.safeParse({ tts_engine: 'kokoro' }).success).toBe(false);
    expect(UserConfigSchema.safeParse({ local_tts_model: 'piper' }).success).toBe(false);
  });
});

describe('Sei voices on the ChatGPT plan (261110)', () => {
  const cfg = { ai_backend_kind: 'local', provider: 'chatgpt', tts_engine: 'sei' };

  it('is off while the flag is off: a saved choice reads as not active', () => {
    expect(SEI_VOICES_FOR_CHATGPT_ENABLED).toBe(false);
    expect(seiVoicesActive(cfg)).toBe(false);
    expect(voiceSourceOf(cfg)).not.toBe('sei');
  });

  it('when enabled, only the ChatGPT plan setup reads it', () => {
    expect(seiVoicesActive(cfg, true)).toBe(true);
    expect(seiVoicesActive({ ...cfg, provider: 'openai' }, true)).toBe(false);
    expect(seiVoicesActive({ ...cfg, ai_backend_kind: 'cloud-proxy' }, true)).toBe(false);
  });
});
