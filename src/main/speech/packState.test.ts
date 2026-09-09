/**
 * Mirror-first URL builder + pack-state reducer tests (260816 local speech).
 */
import { describe, expect, it } from 'vitest';
import { MIRROR_CONNECT_TIMEOUT_MS, SPEECH_MIRROR_BASE, speechSources } from './mirrors';
import { SPEECH_PACKS, SPEECH_PACK_IDS, isSpeechPackId } from './packs';
import { reducePackState, type PackStates } from './packStore';

describe('speechSources (mirror-first)', () => {
  it('tries dl.sei.gg first with a bounded connect timeout, then the origin', () => {
    const def = SPEECH_PACKS['tts-en'];
    const sources = speechSources(def.asset, def.originUrl);
    expect(sources).toHaveLength(2);
    expect(sources[0].url).toBe(`${SPEECH_MIRROR_BASE}/${def.asset}`);
    expect(sources[0].url.startsWith('https://dl.sei.gg/speech/')).toBe(true);
    expect(sources[0].connectTimeoutMs).toBe(MIRROR_CONNECT_TIMEOUT_MS);
    expect(sources[1].url).toBe(def.originUrl);
    // The origin has NO short connect timeout — it must work mirror-less.
    expect(sources[1].connectTimeoutMs).toBeUndefined();
  });

  it('every pack builds a k2-fsa origin URL and a mirror key from its asset', () => {
    for (const id of SPEECH_PACK_IDS) {
      const def = SPEECH_PACKS[id];
      expect(def.originUrl.endsWith(`/${def.asset}`)).toBe(true);
      expect(def.originUrl).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);
      expect(def.archiveBytes).toBeGreaterThan(1_000_000);
    }
  });

  it('isSpeechPackId is the closed set', () => {
    expect(isSpeechPackId('tts-en')).toBe(true);
    expect(isSpeechPackId('stt-sensevoice')).toBe(true);
    expect(isSpeechPackId('tts-ja')).toBe(false);
    expect(isSpeechPackId('')).toBe(false);
  });
});

describe('reducePackState', () => {
  it('a snapshot fills every pack with its archive size', () => {
    const s = reducePackState(null, { kind: 'snapshot', ready: ['tts-zh'] });
    for (const id of SPEECH_PACK_IDS) {
      expect(s[id].bytes).toBe(SPEECH_PACKS[id].archiveBytes);
    }
    expect(s['tts-zh'].state).toBe('ready');
    expect(s['tts-en'].state).toBe('absent');
  });

  it('download-start → progress (monotonic) → done', () => {
    let s = reducePackState(null, { kind: 'snapshot', ready: [] });
    s = reducePackState(s, { kind: 'download-start', packId: 'tts-en' });
    expect(s['tts-en']).toMatchObject({ state: 'downloading', pct: 0 });
    s = reducePackState(s, { kind: 'progress', packId: 'tts-en', pct: 40 });
    expect(s['tts-en'].pct).toBe(40);
    // Progress never runs backwards (a retried source restarts its own count).
    s = reducePackState(s, { kind: 'progress', packId: 'tts-en', pct: 10 });
    expect(s['tts-en'].pct).toBe(40);
    s = reducePackState(s, { kind: 'done', packId: 'tts-en' });
    expect(s['tts-en']).toEqual({ state: 'ready', bytes: SPEECH_PACKS['tts-en'].archiveBytes });
  });

  it('failed and removed both land absent', () => {
    let s = reducePackState(null, { kind: 'download-start', packId: 'tts-zh' });
    s = reducePackState(s, { kind: 'failed', packId: 'tts-zh' });
    expect(s['tts-zh'].state).toBe('absent');
    s = reducePackState(s, { kind: 'snapshot', ready: ['stt-sensevoice'] });
    s = reducePackState(s, { kind: 'removed', packId: 'stt-sensevoice' });
    expect(s['stt-sensevoice'].state).toBe('absent');
  });

  it('a disk snapshot never demotes a live download', () => {
    let s: PackStates = reducePackState(null, { kind: 'download-start', packId: 'stt-sensevoice' });
    s = reducePackState(s, { kind: 'progress', packId: 'stt-sensevoice', pct: 55 });
    s = reducePackState(s, { kind: 'snapshot', ready: [] });
    expect(s['stt-sensevoice']).toMatchObject({ state: 'downloading', pct: 55 });
  });

  it('stale progress after done/failed is ignored', () => {
    let s = reducePackState(null, { kind: 'download-start', packId: 'tts-zh' });
    s = reducePackState(s, { kind: 'done', packId: 'tts-zh' });
    s = reducePackState(s, { kind: 'progress', packId: 'tts-zh', pct: 90 });
    expect(s['tts-zh']).toEqual({ state: 'ready', bytes: SPEECH_PACKS['tts-zh'].archiveBytes });
  });

  it('progress clamps to 100', () => {
    let s = reducePackState(null, { kind: 'download-start', packId: 'tts-en' });
    s = reducePackState(s, { kind: 'progress', packId: 'tts-en', pct: 250 });
    expect(s['tts-en'].pct).toBe(100);
  });
});
