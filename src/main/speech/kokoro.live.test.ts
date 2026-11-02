/** Opt-in real runtime test. Point SEI_KOKORO_LIVE_DIR at staged userData.
 * Requires speech-models/tts-kokoro/pack.json and the extracted release tree.
 * Runs outside Electron; does not certify the packaged app. */
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => process.env.SEI_KOKORO_LIVE_DIR ?? '/nonexistent' } }));
describe.skipIf(!process.env.SEI_KOKORO_LIVE_DIR)('Kokoro real runtime', () => {
  it('synthesizes every mapped voice through the installed-pack path', async () => {
    const { _setUserDataOverride } = await import('../paths');
    _setUserDataOverride(process.env.SEI_KOKORO_LIVE_DIR!);
    const { synthesizeKokoro } = await import('./engine');
    for (const [voice, text] of [
      ['af_heart', 'Hello Marco, this is a local voice test.'],
      ['am_michael', 'Hello Marco, this is a local voice test.'],
      ['ef_dora', 'Hola Marco, esta es una prueba de voz local.'],
      ['em_alex', 'Hola Marco, esta es una prueba de voz local.'],
      ['ff_siwis', 'Bonjour Marco, ceci est un test de voix locale.'],
      ['if_sara', 'Ciao Marco, questa è una prova della voce italiana locale.'],
      ['im_nicola', 'Ciao Marco, questa è una prova della voce italiana locale.'],
    ] as const) {
      const start = performance.now();
      const audio = await synthesizeKokoro(text, voice);
      expect(audio.sampleRate).toBe(24000);
      expect(audio.samples.length).toBeGreaterThan(audio.sampleRate);
      expect(audio.samples.every(Number.isFinite)).toBe(true);
      expect(audio.samples.some((x) => Math.abs(x) > 0.01)).toBe(true);
      console.log(JSON.stringify({ voice, elapsedMs: performance.now() - start, duration: audio.samples.length / audio.sampleRate }));
    }
  }, 240000);
});
