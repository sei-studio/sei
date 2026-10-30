/**
 * Voice for others (261019): what the share step, Edit companion > Voice and
 * the character page read and store for metadata.voiceShared.
 */
import { describe, it, expect } from 'vitest';
import type { VoiceInfo } from '@shared/ipc';
import {
  effectiveSharedVoice,
  poolVoiceLabel,
  sharedVoiceForChange,
  sharedVoiceGroups,
  sharedVoiceMetadataToSave,
  validSharedVoice,
} from './sharedVoice';
import { ZH } from './i18n/zh';

function v(id: string, gender: string, label = id): VoiceInfo {
  return { id, label, gender, age: 'adult', tags: [], vibe: 'test voice' };
}

const POOL = [v('fem1', 'female', 'Lily'), v('fem2', 'female', 'Bella'), v('mal1', 'male', 'Adam')];

describe('validSharedVoice', () => {
  it('keeps a listed pool voice and reads anything else as the default', () => {
    expect(validSharedVoice('fem2', POOL)).toBe('fem2');
    for (const bad of [null, undefined, '', 'gone-from-pool', 'aBcDeFgHiJkLmNoPqRsT']) {
      expect(validSharedVoice(bad, POOL)).toBeNull();
    }
    // pool still loading: nothing is valid yet
    expect(validSharedVoice('fem2', [])).toBeNull();
  });
});

describe('effectiveSharedVoice', () => {
  it('is the stored choice when valid, else the close match', () => {
    expect(effectiveSharedVoice('mal1', 'fem1', POOL)).toBe('mal1');
    expect(effectiveSharedVoice(null, 'fem1', POOL)).toBe('fem1');
    expect(effectiveSharedVoice('junk', 'fem1', POOL)).toBe('fem1');
    expect(effectiveSharedVoice(null, null, POOL)).toBeNull();
  });
});

describe('sharedVoiceForChange', () => {
  it('the default option (or the default voice itself) stores nothing', () => {
    expect(sharedVoiceForChange('', 'fem1', POOL)).toBeNull();
    expect(sharedVoiceForChange('fem1', 'fem1', POOL)).toBeNull();
  });

  it('another pool voice is stored; an unlisted value is not', () => {
    expect(sharedVoiceForChange('mal1', 'fem1', POOL)).toBe('mal1');
    expect(sharedVoiceForChange('not-listed', 'fem1', POOL)).toBeNull();
  });
});

describe('sharedVoiceMetadataToSave (publish step)', () => {
  const OWN = { voiceId: 'aBcDeFgHiJkLmNoPqRsT', voiceOwn: { name: 'Clone', gender: 'female' } };

  it('writes a changed choice beside an own voice', () => {
    expect(sharedVoiceMetadataToSave(OWN, 'mal1x0000000000000000')).toEqual({ ...OWN, voiceShared: 'mal1x0000000000000000' });
    expect(sharedVoiceMetadataToSave({ ...OWN, voiceShared: 'mal1x0000000000000000' }, null)).toEqual(OWN);
  });

  it('writes nothing when unchanged or not an own voice', () => {
    expect(sharedVoiceMetadataToSave(OWN, null)).toBeNull();
    expect(sharedVoiceMetadataToSave({ ...OWN, voiceShared: 'mal1x0000000000000000' }, 'mal1x0000000000000000')).toBeNull();
    expect(sharedVoiceMetadataToSave({ voiceId: 'pFZP5JQG7iQjIQuC4Bku' }, 'mal1x0000000000000000')).toBeNull();
    expect(sharedVoiceMetadataToSave(undefined, 'mal1x0000000000000000')).toBeNull();
  });

  it('a pool voice with a stale own-voice tag needs no "Others will hear" write (261024)', () => {
    const stale = { voiceId: 'NXaTw4ifg0LAguvKuIwZ', voiceOwn: { name: 'Sei — Josh', gender: 'male' } };
    expect(sharedVoiceMetadataToSave(stale, 'mal1x0000000000000000')).toBeNull();
  });
});

describe('labels and groups', () => {
  it('names a pool voice, null when unknown', () => {
    expect(poolVoiceLabel('fem2', POOL)).toBe('Bella');
    expect(poolVoiceLabel('nope', POOL)).toBeNull();
    expect(poolVoiceLabel(null, POOL)).toBeNull();
  });

  it('groups by gender like the picker', () => {
    expect(sharedVoiceGroups(POOL).map((g) => [g.title, g.voices.map((x) => x.id)])).toEqual([
      ['Feminine', ['fem1', 'fem2']],
      ['Masculine', ['mal1']],
    ]);
  });
});

describe('copy', () => {
  it('every new string has a Chinese entry with placeholders kept and no em dash', () => {
    const keys = [
      "Your voice is from your ElevenLabs account, so others can't play it. Others will hear:",
      'Voice others will hear',
      'Closest Sei voice ({name})',
      'Closest Sei voice',
      'Sei voice',
      'Voice for others: {name}',
      'Voice for others: a Sei voice',
      'Change',
      'Play {name} sample',
      'Stop {name} sample',
      'Sample unavailable right now.',
    ];
    for (const k of keys) {
      expect(ZH[k], k).toBeTruthy();
      expect(k.includes('—') || ZH[k].includes('—'), k).toBe(false);
      if (k.includes('{name}')) expect(ZH[k]).toContain('{name}');
    }
  });
});
