import { describe, expect, it } from 'vitest';
import { KOKORO_PACK_ID, localModelPickAction, showTtsPackRow } from './localVoiceChoice';

describe('local voice choice (Fast / Kokoro)', () => {
  it('Fast always saves at once', () => {
    expect(localModelPickAction('fast', undefined)).toBe('save');
    expect(localModelPickAction('fast', 'absent')).toBe('save');
    expect(localModelPickAction('fast', 'ready')).toBe('save');
  });

  it('Kokoro offers its download until the pack is ready', () => {
    expect(localModelPickAction('kokoro', 'absent')).toBe('offer-download');
    expect(localModelPickAction('kokoro', undefined)).toBe('offer-download');
    expect(localModelPickAction('kokoro', 'downloading')).toBe('offer-download');
    expect(localModelPickAction('kokoro', 'ready')).toBe('save');
  });

  it('shows the Kokoro row while chosen or on disk, the Fast rows always', () => {
    expect(showTtsPackRow('tts-en', 'fast', 'absent')).toBe(true);
    expect(showTtsPackRow('tts-zh', 'kokoro', 'ready')).toBe(true);
    expect(showTtsPackRow(KOKORO_PACK_ID, 'fast', 'absent')).toBe(false);
    expect(showTtsPackRow(KOKORO_PACK_ID, 'fast', undefined)).toBe(false);
    expect(showTtsPackRow(KOKORO_PACK_ID, 'fast', 'ready')).toBe(true);
    expect(showTtsPackRow(KOKORO_PACK_ID, 'fast', 'downloading')).toBe(true);
    expect(showTtsPackRow(KOKORO_PACK_ID, 'kokoro', 'absent')).toBe(true);
  });

  it('Fish Audio (261103) saves at once and keeps the Fast rows as its backup', () => {
    expect(localModelPickAction('fish', 'absent')).toBe('save');
    expect(localModelPickAction('fish', undefined)).toBe('save');
    expect(showTtsPackRow('tts-en', 'fish', 'absent')).toBe(true);
    expect(showTtsPackRow(KOKORO_PACK_ID, 'fish', 'absent')).toBe(false);
    expect(showTtsPackRow(KOKORO_PACK_ID, 'fish', 'ready')).toBe(true);
  });
});
