/**
 * OPT-IN live engine check (260816) — exercises the REAL sherpa runtime path
 * (packReady → config build → synthesis → SenseVoice transcription) against a
 * staged `<userData>/speech-models` tree, outside Electron.
 *
 * Skipped unless SEI_SPEECH_LIVE_DIR points at a staged userData dir:
 *
 *   SEI_SPEECH_LIVE_DIR=/tmp/fake-userdata npx vitest run src/main/speech/engine.live.test.ts
 *
 * where the dir contains speech-models/<packId>/<archive dirName>/ (symlinks
 * fine) + a pack.json marker per pack. Requires the sherpa-onnx platform
 * package for this machine. Deliberately NOT part of the normal suite — it
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

    const zh = await synthesizeLocal('你好，这就是我的本地声音。今天想一起玩点什么吗？', 'zh-f');
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
    await expect(synthesizeLocal('测试', 'zh-m')).rejects.toThrow('VOICE_PACK_MISSING:tts-zh');
  }, 30_000);
});
