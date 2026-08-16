/**
 * Tests for the local-setup wizard's pure helpers (260817, china-compat W6)
 * plus the zh dictionary coverage of the wizard's new strings.
 */
import { describe, it, expect } from 'vitest';
import type { SpeechPackStatePush } from '../../../shared/ipc';
import {
  SENSEVOICE_PACK_ID,
  allPacksReady,
  llmTestErrorCopy,
  mbLabel,
  packsPct,
  packsTotalBytes,
  ttsPackIdsFor,
} from './localSetup';
import { ZH } from '../lib/i18n/zh';

const push = (state: SpeechPackStatePush['state'], bytes: number, pct?: number): SpeechPackStatePush => ({
  state,
  bytes,
  ...(pct !== undefined ? { pct } : {}),
});

describe('ttsPackIdsFor', () => {
  it('zh needs BOTH gendered packs (the companion has no gender yet)', () => {
    expect(ttsPackIdsFor('zh')).toEqual(['tts-zh-f', 'tts-zh-m']);
  });
  it('en is one pack covering both genders', () => {
    expect(ttsPackIdsFor('en')).toEqual(['tts-en']);
  });
  it('sensevoice pack id matches the main-side registry id', () => {
    expect(SENSEVOICE_PACK_ID).toBe('stt-sensevoice');
  });
});

describe('mbLabel', () => {
  it('rounds the exact archive bytes to whole MB', () => {
    // The real pack sizes from src/main/speech/packs.ts.
    expect(mbLabel(82_038_311)).toBe('78'); // tts-en
    expect(mbLabel(31_559_701)).toBe('30'); // tts-zh-f
    expect(mbLabel(14_011_298)).toBe('13'); // tts-zh-m
    expect(mbLabel(165_783_878)).toBe('158'); // stt-sensevoice
  });
  it('floors at 1 MB', () => {
    expect(mbLabel(1)).toBe('1');
  });
});

describe('packsTotalBytes', () => {
  it('sums the archives, and returns null while any pack is unknown', () => {
    const packs = { a: push('absent', 100), b: push('absent', 50) };
    expect(packsTotalBytes(['a', 'b'], packs)).toBe(150);
    expect(packsTotalBytes(['a', 'missing'], packs)).toBeNull();
    expect(packsTotalBytes(['a'], null)).toBeNull();
  });
});

describe('packsPct', () => {
  it('weights progress by archive bytes', () => {
    // 100-byte pack ready (100%), 300-byte pack at 0% → 25% overall.
    const packs = { a: push('ready', 100), b: push('downloading', 300, 0) };
    expect(packsPct(['a', 'b'], packs)).toBe(25);
  });
  it('uses the pushed pct for downloading packs and clamps to 100', () => {
    const packs = { a: push('downloading', 100, 50) };
    expect(packsPct(['a'], packs)).toBe(50);
    expect(packsPct(['a'], { a: push('ready', 100) })).toBe(100);
  });
  it('returns 0 with no state yet', () => {
    expect(packsPct(['a'], null)).toBe(0);
    expect(packsPct(['a'], {})).toBe(0);
  });
});

describe('allPacksReady', () => {
  it('true only when every pack reports ready', () => {
    expect(allPacksReady(['a', 'b'], { a: push('ready', 1), b: push('ready', 1) })).toBe(true);
    expect(allPacksReady(['a', 'b'], { a: push('ready', 1), b: push('downloading', 1, 99) })).toBe(false);
    expect(allPacksReady(['a'], null)).toBe(false);
  });
});

describe('llmTestErrorCopy', () => {
  it('maps every typed token to a copy line, folding http_NNN into the generic', () => {
    expect(llmTestErrorCopy('no_api_key')).toMatch(/API key/);
    expect(llmTestErrorCopy('unauthorized')).toMatch(/rejected/);
    expect(llmTestErrorCopy('timeout')).toMatch(/timed out/);
    expect(llmTestErrorCopy('network')).toMatch(/reach/);
    expect(llmTestErrorCopy('http_500')).toBe(llmTestErrorCopy('unknown'));
  });
  it('every copy line has a zh entry', () => {
    for (const token of ['no_api_key', 'unauthorized', 'timeout', 'network', 'unknown']) {
      expect(ZH[llmTestErrorCopy(token)], `zh for ${token}`).toBeTruthy();
    }
  });
});

describe('zh coverage of the wizard strings', () => {
  it('every new W6 onboarding string translates', () => {
    const keys = [
      'Ollama runs on your computer and needs no API key.',
      'Pick the model your companions will think with.',
      'Loading the model list...',
      'Model',
      "Couldn't load the model list. Keep the suggested model or type a model id.",
      'This model cannot see images. Screen sharing and Draw! need a vision model.',
      'Test',
      'Testing...',
      'Testing... DeepSeek can take up to a minute to answer.',
      'Connection works ({seconds}s).',
      'Voice calls: how should companions hear you?',
      'ElevenLabs Scribe (your ElevenLabs key)',
      'Whisper (free)',
      'SenseVoice (free, best for Chinese)',
      'The free options run on your computer. Whisper downloads itself on first use.',
      'Decide later',
      'SenseVoice runs on your computer, free.',
      'And how should companions speak?',
      'ElevenLabs voices (your ElevenLabs key)',
      'Local voices (free)',
      'Local voices run on your computer, free.',
      'Paste your ElevenLabs API key. It powers Scribe recognition and ElevenLabs voices.',
      'ElevenLabs API key',
      'Already downloaded. Continue',
      'Download? ({mb} MB)',
      'Downloading... {pct}%',
      'The download failed. Check your connection and try again.',
      'You can keep going; it finishes in the background.',
    ];
    for (const k of keys) expect(ZH[k], `zh for "${k}"`).toBeTruthy();
  });
  it('no em dash in any new value (both-language rule)', () => {
    for (const [k, v] of Object.entries(ZH)) {
      expect(v.includes('—'), `em dash in zh value for "${k}"`).toBe(false);
    }
  });
});
