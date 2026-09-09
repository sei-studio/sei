/**
 * Tests for the local-setup wizard's pure helpers (260817, china-compat W6)
 * plus the zh dictionary coverage of the wizard's new strings.
 */
import { describe, it, expect } from 'vitest';
import type { SpeechPackStatePush } from '../../../shared/ipc';
import {
  SENSEVOICE_PACK_ID,
  allPacksReady,
  keyProbeConsequence,
  keyProbeLine,
  keyProbeTransport,
  keyProbeVerdict,
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
  it('zh is one pack covering both genders (260908, parallel to en)', () => {
    expect(ttsPackIdsFor('zh')).toEqual(['tts-zh']);
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
    expect(mbLabel(31_559_701)).toBe('30'); // tts-zh
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

describe('key-step probe (260817)', () => {
  it('openrouter probes with a real llm:test because its model list is public', () => {
    expect(keyProbeTransport('openrouter')).toBe('test');
    for (const p of ['anthropic', 'openai', 'deepseek', 'qwen', 'gemini', 'grok', 'ollama']) {
      expect(keyProbeTransport(p), p).toBe('list');
    }
  });
  it('success is ok', () => {
    expect(keyProbeVerdict('anthropic', null)).toBe('ok');
    expect(keyProbeVerdict('ollama', null)).toBe('ok');
  });
  it('401/403 and a missing key read as rejected', () => {
    expect(keyProbeVerdict('anthropic', 'unauthorized')).toBe('rejected');
    expect(keyProbeVerdict('deepseek', 'unauthorized')).toBe('rejected');
    expect(keyProbeVerdict('openai', 'no_api_key')).toBe('rejected');
  });
  it("gemini's HTTP 400 means API_KEY_INVALID and reads as rejected; nobody else's does", () => {
    expect(keyProbeVerdict('gemini', 'http_400')).toBe('rejected');
    expect(keyProbeVerdict('openai', 'http_400')).toBe('ok');
  });
  it('network and timeout read as unreachable', () => {
    expect(keyProbeVerdict('anthropic', 'network')).toBe('unreachable');
    expect(keyProbeVerdict('qwen', 'timeout')).toBe('unreachable');
  });
  it('ambiguous tokens pass through — not a key problem, the model step Test diagnoses', () => {
    expect(keyProbeVerdict('anthropic', 'http_404')).toBe('ok');
    expect(keyProbeVerdict('openrouter', 'http_402')).toBe('ok'); // valid key, no credits
    expect(keyProbeVerdict('deepseek', 'unknown')).toBe('ok');
  });
  it('ollama has no key to reject: every failure is unreachable', () => {
    expect(keyProbeVerdict('ollama', 'network')).toBe('unreachable');
    expect(keyProbeVerdict('ollama', 'unauthorized')).toBe('unreachable');
    expect(keyProbeVerdict('ollama', 'http_500')).toBe('unreachable');
  });
  it('popup copy: rejected names the key, unreachable names the network, ollama its server', () => {
    expect(keyProbeLine('anthropic', 'rejected')).toMatch(/rejected/);
    expect(keyProbeLine('anthropic', 'unreachable')).toMatch(/reach the provider/);
    expect(keyProbeLine('ollama', 'unreachable')).toMatch(/Ollama is running/);
  });
  it('consequence: a rejected key WILL lose the companion, an unreachable one MAY', () => {
    expect(keyProbeConsequence('rejected')).toMatch(/will not/);
    expect(keyProbeConsequence('unreachable')).toMatch(/may not/);
  });
  it('every probe copy line has a zh entry', () => {
    const keys = [
      keyProbeLine('anthropic', 'rejected'),
      keyProbeLine('anthropic', 'unreachable'),
      keyProbeLine('ollama', 'unreachable'),
      keyProbeConsequence('rejected'),
      keyProbeConsequence('unreachable'),
      'Checking your key...',
      'Continue anyway',
      'Back',
    ];
    for (const k of keys) expect(ZH[k], `zh for "${k}"`).toBeTruthy();
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
      // 260907: the decorative "(free)" badges and ", free." tails were
      // dropped from the onboarding voice copy. 'Whisper' needs no zh entry
      // (a missing key renders the English name, which is the name).
      'SenseVoice (best for Chinese)',
      'These options run on your computer. Whisper downloads itself on first use.',
      'Decide later',
      'SenseVoice runs on your computer.',
      'And how should companions speak?',
      'ElevenLabs voices (your ElevenLabs key)',
      'Local voices',
      'Local voices run on your computer.',
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
