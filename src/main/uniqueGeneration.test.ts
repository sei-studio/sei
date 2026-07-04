/**
 * uniqueGeneration.test.ts (260703 procgen)
 *
 * Locks in the pure helpers of the unique-companion pipeline:
 *   - libraryCharacterCount: the Home slot-count = local non-default characters
 *     + bundled defaults whose id is in config.added_default_ids.
 *   - resolvePrefs: local vs cloud questionnaire reconciliation (cloud wins when
 *     newer; `hasCompleted` drives the first-sign-in gate).
 *   - artStyleSuffix / buildPersonaBlurb / buildDescription: sheet → prompt/text.
 *
 * These are the two logic seams called out for unit coverage (slot count +
 * prefs merge) plus the deterministic sheet-derivation helpers. No electron,
 * network, or LLM is exercised — the module's top-level imports are all pure.
 */

import { describe, it, expect } from 'vitest';
import {
  libraryCharacterCount,
  resolvePrefs,
  artStyleSuffix,
  buildPersonaBlurb,
  buildDescription,
} from './uniqueGeneration';
import type { UserPreferences } from '../shared/characterSchema';

type MiniChar = { id: string; is_default: boolean };

describe('libraryCharacterCount', () => {
  it('counts local non-default characters', () => {
    const chars: MiniChar[] = [
      { id: 'a', is_default: false },
      { id: 'b', is_default: false },
    ];
    expect(libraryCharacterCount(chars, { added_default_ids: [] })).toBe(2);
  });

  it('excludes bundled defaults not added to Home', () => {
    const chars: MiniChar[] = [
      { id: 'unique-1', is_default: false },
      { id: 'sui', is_default: true },
      { id: 'lyra', is_default: true },
    ];
    expect(libraryCharacterCount(chars, { added_default_ids: [] })).toBe(1);
  });

  it('counts bundled defaults present in added_default_ids', () => {
    const chars: MiniChar[] = [
      { id: 'unique-1', is_default: false },
      { id: 'sui', is_default: true },
      { id: 'lyra', is_default: true },
    ];
    expect(libraryCharacterCount(chars, { added_default_ids: ['sui'] })).toBe(2);
  });

  it('never double-counts a default (defaults are is_default=true)', () => {
    const chars: MiniChar[] = [
      { id: 'sui', is_default: true },
      { id: 'lyra', is_default: true },
      { id: 'clawd', is_default: true },
    ];
    // Only sui is on Home → 1, even though all three exist on disk.
    expect(libraryCharacterCount(chars, { added_default_ids: ['sui'] })).toBe(1);
  });

  it('treats a missing added_default_ids as empty', () => {
    const chars: MiniChar[] = [{ id: 'a', is_default: false }, { id: 'sui', is_default: true }];
    expect(libraryCharacterCount(chars, {} as { added_default_ids?: string[] })).toBe(1);
  });
});

const prefs = (over: Partial<UserPreferences> = {}): UserPreferences => ({
  companion_age_range: null,
  art_style: null,
  completed_at: null,
  ...over,
});

describe('resolvePrefs', () => {
  it('returns empty + needed when neither side has data', () => {
    const { profile, cloudIsNewer, hasCompleted } = resolvePrefs(null, null);
    expect(profile.completed_at).toBeNull();
    expect(cloudIsNewer).toBe(false);
    expect(hasCompleted).toBe(false);
  });

  it('keeps local when only local is completed', () => {
    const local = prefs({ art_style: 'anime', completed_at: '2026-07-01T00:00:00.000Z' });
    const { profile, cloudIsNewer, hasCompleted } = resolvePrefs(local, null);
    expect(profile).toEqual(local);
    expect(cloudIsNewer).toBe(false);
    expect(hasCompleted).toBe(true);
  });

  it('adopts cloud when only cloud is completed', () => {
    const cloud = prefs({ art_style: '3d', completed_at: '2026-07-02T00:00:00.000Z' });
    const { profile, cloudIsNewer, hasCompleted } = resolvePrefs(prefs(), cloud);
    expect(profile).toEqual(cloud);
    expect(cloudIsNewer).toBe(true);
    expect(hasCompleted).toBe(true);
  });

  it('cloud wins when its completed_at is newer', () => {
    const local = prefs({ art_style: 'anime', completed_at: '2026-07-01T00:00:00.000Z' });
    const cloud = prefs({ art_style: 'chibi', completed_at: '2026-07-05T00:00:00.000Z' });
    const { profile, cloudIsNewer } = resolvePrefs(local, cloud);
    expect(profile).toEqual(cloud);
    expect(cloudIsNewer).toBe(true);
  });

  it('local wins when its completed_at is newer', () => {
    const local = prefs({ art_style: 'anime', completed_at: '2026-07-10T00:00:00.000Z' });
    const cloud = prefs({ art_style: 'chibi', completed_at: '2026-07-05T00:00:00.000Z' });
    const { profile, cloudIsNewer, hasCompleted } = resolvePrefs(local, cloud);
    expect(profile).toEqual(local);
    expect(cloudIsNewer).toBe(false);
    expect(hasCompleted).toBe(true);
  });
});

describe('artStyleSuffix', () => {
  it('maps each art style, defaulting null → anime', () => {
    expect(artStyleSuffix('chibi')).toBe('round chibi style');
    expect(artStyleSuffix('anime')).toBe('anime style');
    expect(artStyleSuffix('celshaded')).toBe('cel-shaded, Genshin Impact-like');
    expect(artStyleSuffix('cartoon')).toBe('western cartoon style');
    expect(artStyleSuffix('3d')).toBe('high-quality stylized 3D render');
    expect(artStyleSuffix(null)).toBe('anime style');
  });
});

const SAMPLE_SHEET = {
  name: 'Mirelle',
  gender: 'female',
  age: 28,
  age_note: null,
  background: 'elf',
  species_detail: 'wood elf with tapered ears',
  personality: {
    tone: 'wry and warm',
    values: ['loyalty', 'curiosity', 'craft'],
    quirks: ['hums while thinking', 'collects river stones'],
    fears: ['being forgotten'],
  },
  backstory:
    'Mirelle grew up in a canopy village. She left to map the lowland rivers. ' +
    'Along the way she learned to read weather in the moss. She now wanders, ' +
    'trading stories for shelter and always heading toward the next unknown bend.',
  voice_style: 'speaks in short, vivid images',
  appearance: {},
  image_prompt: 'a wood elf woman with tapered ears, green cloak, standing in a forest clearing',
};

describe('buildPersonaBlurb / buildDescription', () => {
  it('produces a readable multi-line blurb (not JSON)', () => {
    const blurb = buildPersonaBlurb(SAMPLE_SHEET);
    expect(blurb).toContain('Mirelle');
    expect(blurb).toContain('wood elf with tapered ears');
    expect(blurb).toContain('Tone: wry and warm');
    expect(blurb).toContain('Values: loyalty, curiosity, craft');
    expect(blurb).toContain('Voice: speaks in short, vivid images');
    expect(blurb).toContain('Backstory:');
    expect(blurb).not.toContain('{');
  });

  it('produces a short public description', () => {
    const desc = buildDescription(SAMPLE_SHEET);
    expect(desc).toContain('Mirelle');
    expect(desc.length).toBeLessThanOrEqual(221);
  });
});
