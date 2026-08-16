/**
 * sttPolicy (260725; SenseVoice 260816) — the call-time STT mode matrix.
 *
 * Pins: cloud-proxy defaults to 'none' (Scribe primary, no model download);
 * the stt_local_fallback opt-in restores the eager race; BYOK is always
 * eager, with cloud wired unless stt_engine is 'whisper' or 'sensevoice';
 * absent config fields resolve to the cloud-forward defaults. 260816: the
 * localEngine dimension — SenseVoice for BYOK by choice (pack-gated), and the
 * ONE sanctioned cloud change: zh-UI cloud users with the pack downloaded get
 * SenseVoice as the fallback engine instead of Whisper.
 */
import { describe, it, expect } from 'vitest';
import { sttPolicy } from './sttPolicy';

describe('sttPolicy', () => {
  it("cloud-proxy without the fallback opt-in → 'none' + cloud (no model download)", () => {
    expect(sttPolicy({}, 'cloud-proxy')).toEqual({
      localModel: 'none',
      localEngine: 'whisper',
      useCloud: true,
    });
    expect(sttPolicy(null, 'cloud-proxy')).toEqual({
      localModel: 'none',
      localEngine: 'whisper',
      useCloud: true,
    });
    expect(sttPolicy({ stt_local_fallback: false }, 'cloud-proxy')).toEqual({
      localModel: 'none',
      localEngine: 'whisper',
      useCloud: true,
    });
  });

  it("cloud-proxy with stt_local_fallback → 'eager' + cloud (today's race)", () => {
    expect(sttPolicy({ stt_local_fallback: true }, 'cloud-proxy')).toEqual({
      localModel: 'eager',
      localEngine: 'whisper',
      useCloud: true,
    });
  });

  it("BYOK default (no stt_engine) → 'eager' whisper + cloud (scribe is the default)", () => {
    expect(sttPolicy({}, 'local')).toEqual({
      localModel: 'eager',
      localEngine: 'whisper',
      useCloud: true,
    });
    expect(sttPolicy(null, 'local')).toEqual({
      localModel: 'eager',
      localEngine: 'whisper',
      useCloud: true,
    });
  });

  it("BYOK stt_engine 'scribe' → 'eager' whisper + cloud", () => {
    expect(sttPolicy({ stt_engine: 'scribe' }, 'local')).toEqual({
      localModel: 'eager',
      localEngine: 'whisper',
      useCloud: true,
    });
  });

  it("BYOK stt_engine 'whisper' → 'eager' whisper, cloud NOT wired", () => {
    expect(sttPolicy({ stt_engine: 'whisper' }, 'local')).toEqual({
      localModel: 'eager',
      localEngine: 'whisper',
      useCloud: false,
    });
  });

  it('BYOK ignores stt_local_fallback (whisper is already the install path)', () => {
    expect(sttPolicy({ stt_local_fallback: true }, 'local')).toEqual({
      localModel: 'eager',
      localEngine: 'whisper',
      useCloud: true,
    });
  });

  // ── SenseVoice (260816) ───────────────────────────────────────────────────

  it("BYOK stt_engine 'sensevoice' + pack ready → SenseVoice local, cloud OFF", () => {
    expect(sttPolicy({ stt_engine: 'sensevoice' }, 'local', { sensevoiceReady: true })).toEqual({
      localModel: 'eager',
      localEngine: 'sensevoice',
      useCloud: false,
    });
  });

  it("BYOK stt_engine 'sensevoice' with the pack MISSING keeps whisper behavior", () => {
    expect(sttPolicy({ stt_engine: 'sensevoice' }, 'local', { sensevoiceReady: false })).toEqual({
      localModel: 'eager',
      localEngine: 'whisper',
      useCloud: false,
    });
    expect(sttPolicy({ stt_engine: 'sensevoice' }, 'local')).toEqual({
      localModel: 'eager',
      localEngine: 'whisper',
      useCloud: false,
    });
  });

  it('cloud zh-UI + pack ready → SenseVoice as the local-fallback engine (the one sanctioned cloud change)', () => {
    expect(
      sttPolicy({ stt_local_fallback: true }, 'cloud-proxy', {
        uiLanguage: 'zh',
        sensevoiceReady: true,
      }),
    ).toEqual({ localModel: 'eager', localEngine: 'sensevoice', useCloud: true });
  });

  it('cloud zh-UI WITHOUT the pack → unchanged (whisper fallback)', () => {
    expect(
      sttPolicy({ stt_local_fallback: true }, 'cloud-proxy', {
        uiLanguage: 'zh',
        sensevoiceReady: false,
      }),
    ).toEqual({ localModel: 'eager', localEngine: 'whisper', useCloud: true });
  });

  it('cloud en-UI with the pack → unchanged (whisper fallback)', () => {
    expect(
      sttPolicy({ stt_local_fallback: true }, 'cloud-proxy', {
        uiLanguage: 'en',
        sensevoiceReady: true,
      }),
    ).toEqual({ localModel: 'eager', localEngine: 'whisper', useCloud: true });
  });

  it("cloud zh-UI + pack but NO fallback opt-in stays 'none' (engine choice is moot)", () => {
    expect(
      sttPolicy({}, 'cloud-proxy', { uiLanguage: 'zh', sensevoiceReady: true }),
    ).toMatchObject({ localModel: 'none', useCloud: true });
  });

  it('BYOK scribe/whisper users never get SenseVoice implicitly', () => {
    expect(
      sttPolicy({ stt_engine: 'scribe' }, 'local', { uiLanguage: 'zh', sensevoiceReady: true }),
    ).toMatchObject({ localEngine: 'whisper' });
    expect(
      sttPolicy({ stt_engine: 'whisper' }, 'local', { uiLanguage: 'zh', sensevoiceReady: true }),
    ).toMatchObject({ localEngine: 'whisper' });
  });
});
