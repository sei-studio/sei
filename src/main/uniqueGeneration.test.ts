/**
 * uniqueGeneration.test.ts (260703 procgen)
 *
 * Locks in the pure helpers of the unique-companion pipeline:
 *   - libraryCharacterCount: the Home slot-count = local non-default characters
 *     + bundled defaults whose id is in config.added_default_ids.
 *   - resolvePrefs: local vs cloud questionnaire reconciliation (cloud wins when
 *     newer; `hasCompleted` drives the first-sign-in gate).
 *   - buildPersonaBlurb / buildDescription: sheet → prompt/text.
 *
 * These are the two logic seams called out for unit coverage (slot count +
 * prefs merge) plus the deterministic sheet-derivation helpers. No electron,
 * network, or LLM is exercised — the module's top-level imports are all pure.
 */

import { describe, it, expect } from 'vitest';
import {
  libraryCharacterCount,
  resolvePrefs,
  resolveDynamic,
  mergePrefsPatch,
  buildPersonaBlurb,
  buildDescription,
  computeCropWindow,
  estimateCharacterBBox,
} from './uniqueGeneration';
import type { CompanionDynamic, UserPreferences } from '../shared/characterSchema';
import { COMPANION_DYNAMICS, missingPrefQuestions } from '../shared/characterSchema';

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

  it('excludes foreign-owned cached chars not added from World (browse must not eat slots)', () => {
    // Hovering World cards caches foreign rows locally (ensureLocallyCached);
    // they only occupy a slot once explicitly added (added_world_ids).
    const me = 'user-me';
    const chars = [
      { id: 'mine', is_default: false, owner: me },
      { id: 'legacy', is_default: false, owner: null },
      { id: 'hovered-1', is_default: false, owner: 'someone-else' },
      { id: 'hovered-2', is_default: false, owner: 'someone-else' },
      { id: 'invited', is_default: false, owner: 'someone-else' },
    ];
    expect(
      libraryCharacterCount(chars, { added_default_ids: [], added_world_ids: ['invited'] }, me),
    ).toBe(3); // mine + legacy + invited; the two hovered caches don't count
  });

  it('counts foreign-owned chars when signed out (no owner comparison possible)', () => {
    const chars = [{ id: 'x', is_default: false, owner: 'someone-else' }];
    expect(libraryCharacterCount(chars, { added_default_ids: [] }, null)).toBe(1);
  });
});

const prefs = (over: Partial<UserPreferences> = {}): UserPreferences => ({
  companion_age_range: null,
  art_style: null,
  companion_dynamics: null,
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

describe('resolveDynamic', () => {
  const ranking: CompanionDynamic[] = ['caretaker', 'partner-in-crime'];

  it('grants the first not-yet-granted ranked dynamic, top pick first', () => {
    expect(resolveDynamic(ranking, [])).toBe('caretaker');
    expect(resolveDynamic(ranking, ['caretaker'])).toBe('partner-in-crime');
    // Grant order follows the RANKING, not the granted list's order.
    expect(resolveDynamic(ranking, ['partner-in-crime'])).toBe('caretaker');
  });

  it('never re-grants a ranked dynamic (deleting a companion frees no preference)', () => {
    // Both ranked prefs consumed → random, even though rng would land on rank 1.
    const rngZero = (): number => 0;
    expect(resolveDynamic(ranking, ['caretaker', 'partner-in-crime'], rngZero)).toBe(
      COMPANION_DYNAMICS[0],
    );
  });

  it('rolls a random dynamic once the ranking is exhausted or absent', () => {
    // rng → 0 picks the first table entry; rng → just-under-1 picks the last.
    const rngZero = (): number => 0;
    const rngMax = (): number => 0.999999;
    expect(resolveDynamic([], [], rngZero)).toBe(COMPANION_DYNAMICS[0]);
    expect(resolveDynamic(null, null, rngMax)).toBe(COMPANION_DYNAMICS[COMPANION_DYNAMICS.length - 1]);
    expect(resolveDynamic(undefined, undefined, rngZero)).toBe(COMPANION_DYNAMICS[0]);
    // Every cast has a dynamic — random rolls stay within the closed set.
    for (let i = 0; i < 50; i += 1) {
      expect(COMPANION_DYNAMICS).toContain(resolveDynamic([], [], Math.random));
    }
  });
});

describe('COMPANION_DYNAMICS ↔ soulcaster DYNAMICS key sync', () => {
  it('every client dynamic key exists in soulcaster (a drift fails casts at runtime)', async () => {
    const { DYNAMICS } = await import('soulcaster');
    // Exact two-way match: a key soulcaster grew that the client can't offer
    // is equally a bug (the questionnaire could never rank it).
    expect([...COMPANION_DYNAMICS].sort()).toEqual(Object.keys(DYNAMICS).sort());
  });
});

describe('mergePrefsPatch', () => {
  const NOW = '2026-07-06T00:00:00.000Z';

  it('applies only the keys present in the patch and stamps completed_at', () => {
    const current = prefs({
      companion_age_range: 'adult',
      art_style: 'anime',
      companion_dynamics: ['caretaker'],
      completed_at: '2026-07-01T00:00:00.000Z',
    });
    const merged = mergePrefsPatch(current, { art_style: 'chibi' }, NOW);
    expect(merged).toEqual({
      companion_age_range: 'adult',
      art_style: 'chibi',
      companion_dynamics: ['caretaker'],
      completed_at: NOW,
    });
  });

  it('lets an explicit [] (Surprise me) and explicit null through', () => {
    const current = prefs({ companion_dynamics: ['challenger'] });
    expect(mergePrefsPatch(current, { companion_dynamics: [] }, NOW).companion_dynamics).toEqual([]);
    expect(
      mergePrefsPatch(current, { companion_dynamics: null }, NOW).companion_dynamics,
    ).toBeNull();
  });

  it('seeds from an all-null profile when nothing is stored yet', () => {
    const merged = mergePrefsPatch(null, { companion_age_range: 'elder' }, NOW);
    expect(merged.companion_age_range).toBe('elder');
    expect(merged.art_style).toBeNull();
    expect(merged.companion_dynamics).toBeNull();
    expect(merged.completed_at).toBe(NOW);
  });
});

describe('missingPrefQuestions', () => {
  it('reports all questions for a null/empty profile, in ask order', () => {
    expect(missingPrefQuestions(null)).toEqual([
      'companion_age_range',
      'companion_dynamics',
      'art_style',
    ]);
    expect(missingPrefQuestions(prefs())).toEqual([
      'companion_age_range',
      'companion_dynamics',
      'art_style',
    ]);
  });

  it('treats [] (Surprise me) as ANSWERED but null as missing', () => {
    const p = prefs({ companion_age_range: 'adult', companion_dynamics: [] });
    expect(missingPrefQuestions(p)).toEqual(['art_style']);
  });

  it('is empty for a fully answered profile', () => {
    const p = prefs({
      companion_age_range: 'adult',
      art_style: '3d',
      companion_dynamics: ['chill-friend'],
    });
    expect(missingPrefQuestions(p)).toEqual([]);
  });
});

describe('buildPersonaBlurb / buildDescription', () => {
  it('includes the With-the-player line when the sheet carries player_dynamic', () => {
    const sheet = {
      ...SAMPLE_SHEET,
      player_dynamic: 'The steady hand who quietly keeps you fed, rested, and out of lava.',
    };
    const blurb = buildPersonaBlurb(sheet);
    expect(blurb).toContain('With the player: The steady hand who quietly keeps you fed');
    // It sits with the personality block, before Voice.
    expect(blurb.indexOf('Fears:')).toBeLessThan(blurb.indexOf('With the player:'));
    expect(blurb.indexOf('With the player:')).toBeLessThan(blurb.indexOf('Voice:'));
  });

  it('omits the With-the-player line for sheets without player_dynamic (pre-260705)', () => {
    expect(buildPersonaBlurb(SAMPLE_SHEET)).not.toContain('With the player:');
  });

  it('adds the Texting style line ONLY for deliberate punctuation sheets', () => {
    expect(buildPersonaBlurb(SAMPLE_SHEET)).not.toContain('Texting style:');
    expect(buildPersonaBlurb({ ...SAMPLE_SHEET, punctuation: 'casual' })).not.toContain('Texting style:');
    const blurb = buildPersonaBlurb({ ...SAMPLE_SHEET, punctuation: 'deliberate' });
    expect(blurb).toContain('Texting style: ends every sentence with a period');
    // Rides with the voice block: after Voice, before Backstory.
    expect(blurb.indexOf('Voice:')).toBeLessThan(blurb.indexOf('Texting style:'));
    expect(blurb.indexOf('Texting style:')).toBeLessThan(blurb.indexOf('Backstory:'));
  });

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

  it('omits the Appearance line when the sheet carries no appearance data', () => {
    // SAMPLE_SHEET.appearance is {} — defensive fixture for older/incomplete sheets.
    const blurb = buildPersonaBlurb(SAMPLE_SHEET);
    expect(blurb).not.toContain('Appearance:');
  });

  it('folds outfit + hair/eyes/build/accessories into a compact Appearance line', () => {
    const sheet = {
      ...SAMPLE_SHEET,
      appearance: {
        overall: 'A weathered wood elf with a wanderer\'s ease',
        hair: 'moss-green, braided back',
        eyes: 'amber',
        skin: 'sun-browned',
        height: 'tall',
        build: 'lean',
        bust: null,
        outfit: 'A patched brown leather jerkin over a faded green tunic, with a woven grey traveling cloak.',
        accessories: ['a river-stone necklace', 'a carved walking staff'],
        distinguishing_features: ['a thin scar over one brow'],
      },
    };
    const blurb = buildPersonaBlurb(sheet);
    expect(blurb).toContain('Appearance:');
    expect(blurb).toContain('Wears: A patched brown leather jerkin over a faded green tunic');
    expect(blurb).toContain('Hair: moss-green, braided back');
    expect(blurb).toContain('Eyes: amber');
    expect(blurb).toContain('tall, lean');
    expect(blurb).toContain('Accessories: a river-stone necklace, a carved walking staff');
    expect(blurb).toContain('Features: a thin scar over one brow');
    // Appearance line must land before Backstory, after Voice, and stay compact.
    expect(blurb.indexOf('Voice:')).toBeLessThan(blurb.indexOf('Appearance:'));
    expect(blurb.indexOf('Appearance:')).toBeLessThan(blurb.indexOf('Backstory:'));
  });

  it('is a one-sentence identity summary that never leaks the backstory', () => {
    const desc = buildDescription(SAMPLE_SHEET);
    // species_detail is trimmed to its leading noun phrase ("wood elf", not
    // "…with tapered ears" — appearance stays off the card).
    expect(desc).toBe('Mirelle, a wry and warm wood elf.');
    expect(desc).not.toContain('canopy village');
    expect(desc).not.toContain('rivers');
  });

  it('never shows a human species_detail (it is appearance text by contract)', () => {
    const sheet = {
      ...SAMPLE_SHEET,
      name: 'Layla',
      background: 'human',
      species_detail:
        'Medium-brown skin with a warm undertone; sharp, angular cheekbones and a defined jawline.',
      personality: {
        ...SAMPLE_SHEET.personality,
        tone: 'sardonic and calculating; quick to joke about circumstances but always thinking three moves ahead',
      },
    };
    // Long compound tone → first clause only; appearance never surfaces.
    expect(buildDescription(sheet)).toBe('Layla, a sardonic and calculating human.');
  });

  it('drops the tone clause when the sheet has no tone', () => {
    const sheet = { ...SAMPLE_SHEET, personality: { ...SAMPLE_SHEET.personality, tone: '  ' } };
    expect(buildDescription(sheet)).toBe('Mirelle, a wood elf.');
  });

  it('recovers from sentence-style tone and species_detail (Anaya regression)', () => {
    // Real 260705 sheet output: tone and species_detail came back as full
    // sentences, producing "Anaya, a Anaya speaks with unhurried calm Anaya is
    // a wolf-person." — the sentence tone is dropped, the species lead-in is
    // stripped.
    const sheet = {
      ...SAMPLE_SHEET,
      name: 'Anaya',
      background: 'beastkin',
      species_detail: 'Anaya is a wolf-person',
      personality: { ...SAMPLE_SHEET.personality, tone: 'Anaya speaks with unhurried calm' },
    };
    expect(buildDescription(sheet)).toBe('Anaya, a wolf-person.');
  });

  it('lowercases capitalized tone and species tags mid-sentence', () => {
    const sheet = {
      ...SAMPLE_SHEET,
      name: 'Sölvi',
      background: 'robot',
      species_detail: 'Android chassis',
      personality: { ...SAMPLE_SHEET.personality, tone: 'Direct and candid' },
    };
    expect(buildDescription(sheet)).toBe('Sölvi, a direct and candid android chassis.');
  });

  it('prefers a soulcaster-authored card_line over the derived tone/species line', () => {
    const sheet = { ...SAMPLE_SHEET, card_line: 'a wry wood elf cartographer' };
    expect(buildDescription(sheet)).toBe('Mirelle, a wry wood elf cartographer.');
  });

  it('sanitizes a disobedient card_line (leading name, capital, trailing period)', () => {
    expect(buildDescription({ ...SAMPLE_SHEET, card_line: 'Mirelle, A quiet mapmaker.' })).toBe(
      'Mirelle, a quiet mapmaker.',
    );
    // Blank card_line falls back to the derived line.
    expect(buildDescription({ ...SAMPLE_SHEET, card_line: '   ' })).toBe(
      'Mirelle, a wry and warm wood elf.',
    );
  });

  it('falls back to the background word when species_detail is empty or unwieldy', () => {
    expect(buildDescription({ ...SAMPLE_SHEET, species_detail: '' })).toBe(
      'Mirelle, a wry and warm elf.',
    );
    const beast = {
      ...SAMPLE_SHEET,
      background: 'beastkin',
      species_detail: 'an unusually elaborate nine-tailed spirit-fox person',
    };
    expect(buildDescription(beast)).toBe('Mirelle, a wry and warm beastkin.');
  });
});

describe('computeCropWindow (zoom-to-character geometry)', () => {
  const W = 960;
  const H = 1680; // KusArt 4:7 frame

  it('frames a 40%-tall subject to ~75% fill, aspect-locked to 4:7, centered', () => {
    // Subject occupies 0.4*H (672px) tall, centered horizontally-ish.
    const win = computeCropWindow({ left: 400, top: 600, width: 200, height: 672 }, W, H);
    expect(win).not.toBeNull();
    // winH = round(672 / 0.75) = 896; winW = round(896 * 4/7) = 512.
    expect(win!.height).toBe(896);
    expect(win!.width).toBe(512);
    // Subject height / crop height ≈ 0.75.
    expect(672 / win!.height).toBeCloseTo(0.75, 2);
    // 4:7 aspect preserved.
    expect(win!.width / win!.height).toBeCloseTo(4 / 7, 3);
    // Centered on the subject center (cx=500, cy=936).
    expect(win!.left + win!.width / 2).toBeCloseTo(500, 0);
    expect(win!.top + win!.height / 2).toBeCloseTo(936, 0);
    // Stays inside the frame.
    expect(win!.left).toBeGreaterThanOrEqual(0);
    expect(win!.top).toBeGreaterThanOrEqual(0);
    expect(win!.left + win!.width).toBeLessThanOrEqual(W);
    expect(win!.top + win!.height).toBeLessThanOrEqual(H);
  });

  it('no-ops (null) when the subject already fills the frame (would require upscale)', () => {
    // A near-full-height subject: winH would exceed H, so no crop is possible.
    expect(computeCropWindow({ left: 20, top: 40, width: 900, height: 1600 }, W, H)).toBeNull();
  });

  it('clamps the window to the frame when the subject hugs an edge', () => {
    const win = computeCropWindow({ left: 0, top: 0, width: 200, height: 672 }, W, H);
    expect(win).not.toBeNull();
    expect(win!.left).toBe(0); // clamped left, not negative
    expect(win!.top).toBe(0); // clamped top, not negative
    expect(win!.left + win!.width).toBeLessThanOrEqual(W);
  });

  it('rejects degenerate bboxes', () => {
    expect(computeCropWindow({ left: 0, top: 0, width: 0, height: 100 }, W, H)).toBeNull();
    expect(computeCropWindow({ left: 0, top: 0, width: 100, height: 0 }, W, H)).toBeNull();
  });

  it('rescues a full standing figure (tall narrow bbox) by cropping to the upper body', () => {
    // Anaya regression (260705): a full-body render fills ~99% of the frame
    // height (bbox h/w 2.75), so the whole-subject window cannot fit — but a
    // no-op leaves the face a tiny sliver at the top. Expect an upper-body
    // window anchored at the figure's top, 4:7, torso-fraction sized.
    const win = computeCropWindow({ left: 180, top: 0, width: 605, height: 1663 }, W, H);
    expect(win).not.toBeNull();
    // upperH = round(1663 * 0.55 / 0.75) = 1220; upperW = round(1220 * 4/7) = 697.
    expect(win!.height).toBe(1220);
    expect(win!.width).toBe(697);
    // Head-anchored: top clamps to 0 (bbox.top is 0), never centered on the hips.
    expect(win!.top).toBe(0);
    expect(win!.width / win!.height).toBeCloseTo(4 / 7, 2);
    expect(win!.left + win!.width).toBeLessThanOrEqual(W);
  });

  it('still no-ops for a frame-filling WAIST-UP subject (wide bbox, h/w < 2.4)', () => {
    // The existing no-op case: subject fills the frame but is not a standing
    // figure — cropping would just cut into a compliant composition.
    expect(computeCropWindow({ left: 20, top: 40, width: 900, height: 1600 }, W, H)).toBeNull();
  });
});

describe('estimateCharacterBBox (focus-energy detector)', () => {
  const w = 240;
  const h = 420;

  // Grayscale raster (1 channel) with a high-frequency checkerboard block over
  // a flat background — mimics a sharp subject on a blurred (flat) background.
  function raster(fill: (x: number, y: number) => number): Uint8Array {
    const g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = fill(x, y);
    return g;
  }

  it('locates a centered sharp block against a flat background', () => {
    // Subject occupies x∈[0.3,0.7)·w, y∈[0.3,0.7)·h → ~40% of each dimension.
    const x0 = Math.round(0.3 * w), x1 = Math.round(0.7 * w);
    const y0 = Math.round(0.3 * h), y1 = Math.round(0.7 * h);
    const g = raster((x, y) => {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) return (x + y) % 2 === 0 ? 40 : 210;
      return 128; // flat background → zero Laplacian energy
    });
    const bbox = estimateCharacterBBox(g, w, h, 1);
    expect(bbox).not.toBeNull();
    expect(bbox!.left).toBeGreaterThan(0.2);
    expect(bbox!.left).toBeLessThan(0.4);
    expect(bbox!.top).toBeGreaterThan(0.2);
    expect(bbox!.top).toBeLessThan(0.4);
    expect(bbox!.width).toBeGreaterThan(0.3);
    expect(bbox!.height).toBeGreaterThan(0.3);
  });

  it('returns null on a flat frame (nothing in focus)', () => {
    expect(estimateCharacterBBox(raster(() => 128), w, h, 1)).toBeNull();
  });

  it('returns null when the whole frame is textured (weak separation, blur failed)', () => {
    // Checkerboard everywhere → peak energy ≈ median energy → separation gate.
    const g = raster((x, y) => ((x + y) % 2 === 0 ? 40 : 210));
    expect(estimateCharacterBBox(g, w, h, 1)).toBeNull();
  });
});
