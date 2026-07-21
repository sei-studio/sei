/**
 * previewCacheKey (260720) — the voice-sample disk-cache key.
 *
 * Pins: deterministic per (voiceId, text) pair, changes with either input,
 * filename-safe, and sanitized ids cannot collide (the hash covers the raw id).
 */
import { describe, it, expect } from 'vitest';
import { previewCacheKey } from './previewCache';

const LINE = 'Hi, this is what I sound like.';

describe('previewCacheKey', () => {
  it('is deterministic for the same voice + text', () => {
    expect(previewCacheKey('EXAVITQu4vr4xnSDxMaL', LINE)).toBe(
      previewCacheKey('EXAVITQu4vr4xnSDxMaL', LINE),
    );
  });

  it('changes when the sample text changes (language switch, copy change)', () => {
    expect(previewCacheKey('EXAVITQu4vr4xnSDxMaL', LINE)).not.toBe(
      previewCacheKey('EXAVITQu4vr4xnSDxMaL', '嗨，这就是我的声音。'),
    );
  });

  it('changes when the voice changes', () => {
    expect(previewCacheKey('voiceA', LINE)).not.toBe(previewCacheKey('voiceB', LINE));
  });

  it('is filename-safe, ends in .mp3, and keeps the id recognizable', () => {
    const key = previewCacheKey('EXAVITQu4vr4xnSDxMaL', LINE);
    expect(key).toMatch(/^[A-Za-z0-9_-]+\.mp3$/);
    expect(key.startsWith('EXAVITQu4vr4xnSDxMaL-')).toBe(true);
  });

  it('sanitizes hostile ids without letting sanitized forms collide', () => {
    const a = previewCacheKey('../evil', LINE);
    const b = previewCacheKey('__.evil', LINE);
    expect(a).toMatch(/^[A-Za-z0-9_-]+\.mp3$/);
    expect(a).not.toContain('/');
    expect(a).not.toContain('..');
    // Both sanitize toward similar shapes; the raw-id hash keeps them distinct.
    expect(a).not.toBe(b);
  });
});
