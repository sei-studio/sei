/**
 * Voice-picker pure logic (260720) — grouping, selection, legacy detection.
 */
import { describe, it, expect } from 'vitest';
import type { OwnVoiceInfo, VoiceInfo } from '@shared/ipc';
import {
  groupVoices,
  reduceSelection,
  isUnlistedVoice,
  assetPathFor,
  normalizeVoiceParams,
  PITCH_DEFAULT,
  CALMNESS_DEFAULT,
  NO_VOICE_ID,
  OWN_TAB_KEY,
  ownVoicePickFor,
  ownVoiceCategoryLabel,
  ownVoiceDetail,
  ownVoicesView,
  poolUsesOwnKey,
  elevenKeyHintShown,
  defaultVoiceTab,
  applyVoicePick,
} from './voicePicker';

function v(id: string, gender: string): VoiceInfo {
  return { id, label: id, gender, age: 'adult', tags: [], vibe: 'test voice' };
}

describe('groupVoices', () => {
  it('groups by gender in female, male, neutral order with tab-label titles', () => {
    const groups = groupVoices([v('m1', 'male'), v('f1', 'female'), v('n1', 'neutral')]);
    expect(groups.map((g) => g.key)).toEqual(['female', 'male', 'neutral']);
    expect(groups.map((g) => g.title)).toEqual(['Feminine', 'Masculine', 'Neutral']);
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

describe('normalizeVoiceParams', () => {
  it('drops keys sitting at their engine default', () => {
    expect(normalizeVoiceParams({ pitch: PITCH_DEFAULT, calmness: CALMNESS_DEFAULT })).toEqual({});
    expect(normalizeVoiceParams({ pitch: PITCH_DEFAULT, calmness: 0.2 })).toEqual({ calmness: 0.2 });
  });

  it('keeps non-default values', () => {
    expect(normalizeVoiceParams({ pitch: 1.2, calmness: 0.05 })).toEqual({ pitch: 1.2, calmness: 0.05 });
  });

  it('passes through absent keys untouched', () => {
    expect(normalizeVoiceParams({})).toEqual({});
    expect(normalizeVoiceParams({ pitch: 0.9 })).toEqual({ pitch: 0.9 });
  });
});

// 261019: the user's own ElevenLabs voices tab.
function own(id: string, extra: Partial<OwnVoiceInfo> = {}): OwnVoiceInfo {
  return { id, name: `Voice ${id}`, category: 'cloned', hasPreview: false, ...extra };
}

describe('own ElevenLabs voices', () => {
  it('ownVoicePickFor marks only ids from the own list', () => {
    const list = [own('Own1', { gender: 'male' }), own('Own2')];
    expect(ownVoicePickFor('Own1', list)).toEqual({ name: 'Voice Own1', gender: 'male' });
    expect(ownVoicePickFor('Own2', list)).toEqual({ name: 'Voice Own2' });
    expect(ownVoicePickFor('pool1', list)).toBeNull();
    expect(ownVoicePickFor(null, list)).toBeNull();
    expect(ownVoicePickFor(NO_VOICE_ID, list)).toBeNull();
  });

  it('ownVoicePickFor never marks a Sei pool voice, even when the own list holds a copy (261024)', () => {
    const josh = 'NXaTw4ifg0LAguvKuIwZ'; // pool Josh
    const list = [own(josh, { name: 'Sei — Josh', gender: 'male', category: 'professional' }), own('Own1')];
    expect(ownVoicePickFor(josh, list)).toBeNull();
    expect(ownVoicePickFor('EXAVITQu4vr4xnSDxMaL', [own('EXAVITQu4vr4xnSDxMaL')])).toBeNull(); // legacy Sarah
    expect(applyVoicePick({ voiceId: josh, voiceOwn: { name: 'Sei — Josh' } }, josh, ownVoicePickFor(josh, list))).toEqual({
      voiceId: josh,
    });
  });

  it('a pick from the own tab persists the same voiceId path a pool pick does', () => {
    const id = 'aBcDeFgHiJkLmNoPqRsT';
    const list = [own(id, { name: 'My Clone', gender: 'female' })];
    const meta = applyVoicePick({ voicePitch: 1.2 }, id, ownVoicePickFor(id, list));
    expect(meta).toEqual({ voicePitch: 1.2, voiceId: id, voiceOwn: { name: 'My Clone', gender: 'female' } });
    // switching back to a Sei voice drops the marker
    expect(applyVoicePick(meta, 'PoolVoice1234567890a', ownVoicePickFor('PoolVoice1234567890a', list))).toEqual({
      voicePitch: 1.2,
      voiceId: 'PoolVoice1234567890a',
    });
  });

  it('category labels are fixed English strings, unknown → generic', () => {
    expect(ownVoiceCategoryLabel('cloned')).toBe('Cloned voice');
    expect(ownVoiceCategoryLabel('professional')).toBe('Professional clone');
    expect(ownVoiceCategoryLabel('generated')).toBe('Designed voice');
    expect(ownVoiceCategoryLabel('famous')).toBe('Library voice');
    expect(ownVoiceCategoryLabel('something_new')).toBe('Your voice');
  });

  it('detail prefers the description, else the labels', () => {
    expect(ownVoiceDetail(own('a', { description: 'raspy', gender: 'male' }))).toBe('raspy');
    expect(ownVoiceDetail(own('a', { gender: 'male', age: 'old', accent: 'british' }))).toBe('male, old, british');
    expect(ownVoiceDetail(own('a'))).toBe('');
  });

  it('view: tab on ok, quiet hint on a bad key or error, nothing otherwise', () => {
    expect(ownVoicesView(null)).toBe('none');
    expect(ownVoicesView({ status: 'unavailable', voices: [] })).toBe('none');
    expect(ownVoicesView({ status: 'ok', voices: [] })).toBe('tab');
    expect(ownVoicesView({ status: 'bad_key', voices: [] })).toBe('hint');
    expect(ownVoicesView({ status: 'error', voices: [] })).toBe('hint');
  });

  it('the free-plan pool hint shows only while the key route is active', () => {
    expect(poolUsesOwnKey(null, 'local')).toBe(false);
    expect(poolUsesOwnKey({ status: 'unavailable', voices: [] }, 'local')).toBe(false);
    expect(poolUsesOwnKey({ status: 'ok', voices: [] }, 'local')).toBe(true);
    expect(poolUsesOwnKey({ status: 'bad_key', voices: [] }, 'local')).toBe(true);
    // 261020 (T158): on Sei Cloud the pool stays on the proxy even with a key.
    expect(poolUsesOwnKey({ status: 'ok', voices: [] }, 'cloud-proxy')).toBe(false);
    expect(poolUsesOwnKey({ status: 'bad_key', voices: [] }, 'cloud-proxy')).toBe(false);
    expect(poolUsesOwnKey({ status: 'ok', voices: [] }, null)).toBe(false);
  });

  it('the add-your-key pointer shows once the probe says no key, on both backends', () => {
    expect(elevenKeyHintShown(false, false)).toBe(true);
    expect(elevenKeyHintShown(true, false)).toBe(false);
    expect(elevenKeyHintShown(null, false)).toBe(false); // still probing
    expect(elevenKeyHintShown(false, true)).toBe(false); // local voice packs
  });

  it('defaultVoiceTab opens where the selection lives', () => {
    const groups = groupVoices([v('f1', 'female'), v('m1', 'male')]);
    const list = [own('Own1')];
    expect(defaultVoiceTab('Own1', groups, list)).toBe(OWN_TAB_KEY);
    expect(defaultVoiceTab('m1', groups, list)).toBe('male');
    // a pool voice the own list also holds opens its pool tab (261024)
    expect(defaultVoiceTab('m1', groups, [own('m1'), own('Own1')])).toBe('male');
    // Auto / unknown: the own tab when it has voices, else the first group
    expect(defaultVoiceTab(null, groups, list)).toBe(OWN_TAB_KEY);
    expect(defaultVoiceTab(null, groups, [])).toBe('female');
    expect(defaultVoiceTab(null, groups, null)).toBe('female');
    expect(defaultVoiceTab(null, [], [])).toBe(OWN_TAB_KEY);
    expect(defaultVoiceTab(null, [], null)).toBeNull();
  });

  it('an own voice is not "unlisted" once the own list is merged in', () => {
    const pool = [v('f1', 'female')];
    expect(isUnlistedVoice('Own1', pool)).toBe(true);
    expect(isUnlistedVoice('Own1', [...pool, own('Own1')])).toBe(false);
  });
});
