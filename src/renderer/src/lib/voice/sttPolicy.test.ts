/**
 * sttPolicy (260725) — the call-time STT mode matrix.
 *
 * Pins: cloud-proxy defaults to 'none' (Scribe primary, no model download);
 * the stt_local_fallback opt-in restores the eager race; BYOK is always
 * eager, with cloud wired unless stt_engine is 'whisper'; absent config
 * fields resolve to the cloud-forward defaults.
 */
import { describe, it, expect } from 'vitest';
import { sttPolicy } from './sttPolicy';

describe('sttPolicy', () => {
  it("cloud-proxy without the fallback opt-in → 'none' + cloud (no model download)", () => {
    expect(sttPolicy({}, 'cloud-proxy')).toEqual({ localModel: 'none', useCloud: true });
    expect(sttPolicy(null, 'cloud-proxy')).toEqual({ localModel: 'none', useCloud: true });
    expect(sttPolicy({ stt_local_fallback: false }, 'cloud-proxy')).toEqual({
      localModel: 'none',
      useCloud: true,
    });
  });

  it("cloud-proxy with stt_local_fallback → 'eager' + cloud (today's race)", () => {
    expect(sttPolicy({ stt_local_fallback: true }, 'cloud-proxy')).toEqual({
      localModel: 'eager',
      useCloud: true,
    });
  });

  it("BYOK default (no stt_engine) → 'eager' + cloud (scribe is the default)", () => {
    expect(sttPolicy({}, 'local')).toEqual({ localModel: 'eager', useCloud: true });
    expect(sttPolicy(null, 'local')).toEqual({ localModel: 'eager', useCloud: true });
  });

  it("BYOK stt_engine 'scribe' → 'eager' + cloud", () => {
    expect(sttPolicy({ stt_engine: 'scribe' }, 'local')).toEqual({
      localModel: 'eager',
      useCloud: true,
    });
  });

  it("BYOK stt_engine 'whisper' → 'eager', cloud NOT wired", () => {
    expect(sttPolicy({ stt_engine: 'whisper' }, 'local')).toEqual({
      localModel: 'eager',
      useCloud: false,
    });
  });

  it('BYOK ignores stt_local_fallback (whisper is already the install path)', () => {
    expect(sttPolicy({ stt_local_fallback: true }, 'local')).toEqual({
      localModel: 'eager',
      useCloud: true,
    });
  });
});
