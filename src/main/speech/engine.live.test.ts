/**
 * OPT-IN live engine check (260816) â€” exercises the REAL sherpa runtime path
 * (packReady â†’ config build â†’ synthesis â†’ SenseVoice transcription) against a
 * staged `<userData>/speech-models` tree, outside Electron.
 *
 * Skipped unless SEI_SPEECH_LIVE_DIR points at a staged userData dir:
 *
 *   SEI_SPEECH_LIVE_DIR=/tmp/fake-userdata npx vitest run src/main/speech/engine.live.test.ts
 *
 * where the dir contains speech-models/<packId>/<archive dirName>/ (symlinks
 * fine) + a pack.json marker per pack. Requires the sherpa-onnx platform
 * package for this machine. Deliberately NOT part of the normal suite â€” it
 * needs ~300MB of downloaded models.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.SEI_SPEECH_LIVE_DIR ?? '/nonexistent' },
}));

const liveDir = process.env.SEI_SPEECH_LIVE_DIR;

describe.skipIf(!liveDir)('local speech engine (live)', () => {
  it('synthesizes en + zh through the shipping voice specs and transcribes', async () => {
    const { _setUserDataOverride } = await import('../paths');
    _setUserDataOverride(liveDir as string);
    const { synthesizeLocal, transcribeLocal, packStatus } = await import('./index');

    const status = await packStatus();
    expect(status['tts-zh'].state).toBe('ready');

    const zh = await synthesizeLocal('ä½ å¥½ï¼Œè¿™å°±æ˜¯æˆ‘çš„æœ¬åœ°å£°éŸ³ã€‚ä»Šå¤©æƒ³ä¸€èµ·çŽ©ç‚¹ä»€ä¹ˆå—ï¼Ÿ', 'zh-f');
    expect(zh.samples.length).toBeGreaterThan(zh.sampleRate); // > 1s of audio
    const en = await synthesizeLocal(
      'Hey, this is what my local voice sounds like. Want to play something?',
      'en-m',
    );
    expect(en.samples.length).toBeGreaterThan(en.sampleRate);

    const round = await transcribeLocal(zh.samples, zh.sampleRate);
    // eslint-disable-next-line no-console
    console.log('[live] sensevoice on the zh clip:', JSON.stringify(round));
    expect(round.text.length).toBeGreaterThan(3);
  }, 120_000);

  it('a missing pack throws the typed VOICE_PACK_MISSING error', async () => {
    const { _setUserDataOverride } = await import('../paths');
    _setUserDataOverride(liveDir as string);
    const { rm } = await import('node:fs/promises');
    await rm(`${liveDir}/speech-models/tts-zh/pack.json`, { force: true });
    const { synthesizeLocal } = await import('./index');
    await expect(synthesizeLocal('æµ‹è¯•', 'zh-m')).rejects.toThrow('VOICE_PACK_MISSING:tts-zh');
  }, 30_000);
});




