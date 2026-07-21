/**
 * Voice-picker pure logic (260720) — grouping, selection, legacy detection.
 */
import { describe, it, expect } from 'vitest';
import type { VoiceInfo } from '@shared/ipc';
import {
  groupVoices,
  reduceSelection,
  isUnlistedVoice,
  assetPathFor,
  NO_VOICE_ID,
} from './voicePicker';

function v(id: string, gender: string): VoiceInfo {
  return { id, label: id, gender, age: 'adult', tags: [], vibe: 'test voice' };
}

describe('groupVoices', () => {
  it('groups by gender in female, male, neutral order with sentence-case titles', () => {
    const groups = groupVoices([v('m1', 'male'), v('f1', 'female'), v('n1', 'neutral')]);
    expect(groups.map((g) => g.key)).toEqual(['female', 'male', 'neutral']);
    expect(groups.map((g) => g.title)).toEqual(['Female voices', 'Male voices', 'Neutral voices']);
  });

  it('preserves pool order within a group', () => {
    const groups = groupVoices([v('f1', 'female'), v('m1', 'male'), v('f2', 'female')]);
    expect(groups[0].voices.map((x) => x.id)).toEqual(['f1', 'f2']);
  });

  it('omits empty groups', () => {
    const groups = groupVoices([v('f1', 'female')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('female');
  });

  it('buckets unknown gender labels into neutral instead of dropping them', () => {
    const groups = groupVoices([v('x1', 'robotic'), v('f1', 'female')]);
    const neutral = groups.find((g) => g.key === 'neutral');
    expect(neutral?.voices.map((x) => x.id)).toEqual(['x1']);
  });

  it('returns no groups for an empty pool', () => {
    expect(groupVoices([])).toEqual([]);
  });
});

describe('reduceSelection', () => {
  it('selects a clicked voice', () => {
    expect(reduceSelection(null, 'f1')).toBe('f1');
    expect(reduceSelection('m1', 'f1')).toBe('f1');
  });

  it('clicking the selected voice again reverts to auto (null)', () => {
    expect(reduceSelection('f1', 'f1')).toBeNull();
  });

  it('handles the no-voice sentinel like any row (select, toggle back to auto)', () => {
    expect(reduceSelection(null, NO_VOICE_ID)).toBe(NO_VOICE_ID);
    expect(reduceSelection(NO_VOICE_ID, NO_VOICE_ID)).toBeNull();
    expect(reduceSelection(NO_VOICE_ID, 'f1')).toBe('f1');
  });
});

describe('isUnlistedVoice', () => {
  const pool = [v('f1', 'female')];

  it('flags a selection the pool does not list (legacy voice id)', () => {
    expect(isUnlistedVoice('legacy-id', pool)).toBe(true);
  });

  it('never flags auto, no-voice, or a listed pool voice', () => {
    expect(isUnlistedVoice(null, pool)).toBe(false);
    expect(isUnlistedVoice(NO_VOICE_ID, pool)).toBe(false);
    expect(isUnlistedVoice('f1', pool)).toBe(false);
  });
});

describe('assetPathFor', () => {
  it('builds the bundled sample path for a supported language', () => {
    expect(assetPathFor('FNhoq0qHG3T8YOWzBtd6', 'en')).toBe(
      './voice-previews/FNhoq0qHG3T8YOWzBtd6-en.mp3',
    );
    expect(assetPathFor('abc123', 'ja')).toBe('./voice-previews/abc123-ja.mp3');
  });

  it('covers every conversation language', () => {
    for (const lang of ['en', 'zh', 'ja', 'ko', 'fr', 'es']) {
      expect(assetPathFor('v1', lang)).toBe(`./voice-previews/v1-${lang}.mp3`);
    }
  });

  it('falls back to English for an unsupported or junk language', () => {
    expect(assetPathFor('v1', 'de')).toBe('./voice-previews/v1-en.mp3');
    expect(assetPathFor('v1', '')).toBe('./voice-previews/v1-en.mp3');
    expect(assetPathFor('v1', 'EN')).toBe('./voice-previews/v1-en.mp3');
  });
});
