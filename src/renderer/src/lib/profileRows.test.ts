/**
 * profileRows (261107, reworked by product call 261110): who may use which
 * profile row, the owner page's sections, a foreign companion's tabs, and
 * the analytics shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const track = vi.fn();
(globalThis as unknown as { window: unknown }).window = { sei: { track } };

const {
  PROFILE_SECTIONS,
  foreignSettingsRows,
  foreignTabs,
  isProfileFocus,
  lockTipKey,
  ownerSections,
  profileAccess,
  profileKind,
  profileView,
  requestProfileFocus,
  resolveForeignTab,
  sectionOf,
  takeRequestedProfileFocus,
  trackProfileActionClicked,
  trackProfileCtaClicked,
  trackProfileTabViewed,
  trackProfileTooltipOpened,
  trackProfileViewed,
  trackProfileVoiceSample,
} = await import('./profileRows');
type Input = Parameters<typeof profileAccess>[0];

const ME = 'user-me';
const THEM = 'user-them';

const base: Omit<Input, 'kind'> = {
  inLibrary: true,
  seilinkOn: false,
  movedInHere: false,
  ownVoice: false,
  noVoice: false,
};

/** The owner page as section -> rows. */
const sections = (input: Input): Record<string, string[]> =>
  Object.fromEntries(ownerSections(profileAccess(input)).map((s) => [s.section, s.rows]));

describe('profileKind / profileView', () => {
  it('a bundled default is built-in, whoever owns the row', () => {
    expect(profileKind({ is_default: true, owner: THEM, kind: 'custom' }, ME)).toBe('builtin');
    expect(profileKind({ is_default: true, owner: null }, null)).toBe('builtin');
  });

  it("someone else's cloud companion is World, signed out included", () => {
    expect(profileKind({ is_default: false, owner: THEM, kind: 'custom' }, ME)).toBe('world');
    expect(profileKind({ is_default: false, owner: THEM, kind: 'custom' }, null)).toBe('world');
  });

  it('your own (or a legacy null-owner) custom companion is custom', () => {
    expect(profileKind({ is_default: false, owner: ME, kind: 'custom' }, ME)).toBe('custom');
    expect(profileKind({ is_default: false, owner: null, kind: 'custom' }, null)).toBe('custom');
    expect(profileKind({ is_default: false, owner: null }, ME)).toBe('custom');
  });

  it('your own system-cast companion is awakened', () => {
    expect(profileKind({ is_default: false, owner: ME, kind: 'unique' }, ME)).toBe('awakened');
  });

  it('owner view for yours, the Overview for everyone else', () => {
    expect(profileView('custom')).toBe('owner');
    expect(profileView('awakened')).toBe('owner');
    expect(profileView('builtin')).toBe('foreign');
    expect(profileView('world')).toBe('foreign');
  });
});

describe('owner page (one scroll, sections in use order)', () => {
  it('custom: Look, Voice, Personality, Games, Sharing, Danger zone, every row live', () => {
    expect(sections({ ...base, kind: 'custom' })).toEqual({
      look: ['cardImage', 'skin', 'avatar', 'floatingAvatar'],
      voice: ['voice', 'pitch'],
      personality: ['about', 'persona', 'knowledge'],
      games: ['chess', 'dst'],
      sharing: ['publicToggle'],
      danger: ['resetMemory', 'unbind'],
    });
    const a = profileAccess({ ...base, kind: 'custom' });
    for (const row of ['cardImage', 'skin', 'voice', 'pitch', 'about', 'persona', 'chess'] as const) {
      expect(a[row], row).toBe('edit');
    }
    expect(a.cardUpload).toBe(true);
    expect(a.skinEdit).toBe(true);
    expect(a.skinGenerate).toBe(true);
    expect(a.avatarMode).toBe('manage');
    expect(a.report).toBe(false);
  });

  it('the order is the one people use: look first, destructive last', () => {
    expect(PROFILE_SECTIONS[0]).toBe('look');
    expect(PROFILE_SECTIONS[PROFILE_SECTIONS.length - 1]).toBe('danger');
  });

  it('merged rows: name and description are one row, the username lives in the skin row', () => {
    const rows = ownerSections(profileAccess({ ...base, kind: 'custom' })).flatMap((s) => s.rows) as string[];
    expect(rows).toContain('about');
    expect(rows).not.toContain('name');
    expect(rows).not.toContain('description');
    expect(rows).not.toContain('username');
    expect(new Set(rows).size).toBe(rows.length);
  });

  it('WorldLink is its own section; Idle lines needs her on the desktop', () => {
    expect(sections({ ...base, kind: 'custom', seilinkOn: true }).worldlink).toEqual(['desktopRoom', 'room', 'intro']);
    expect(sections({ ...base, kind: 'custom', seilinkOn: true, movedInHere: true }).worldlink).toEqual([
      'desktopRoom',
      'room',
      'idleLines',
      'intro',
    ]);
  });

  it('awakened: owned, so card image, skin generation and Public stay live; the edit surfaces lock', () => {
    const a = profileAccess({ ...base, kind: 'awakened' });
    expect(a.cardImage).toBe('edit');
    expect(a.cardUpload).toBe(false);
    expect(a.skin).toBe('edit');
    expect(a.skinEdit).toBe(false);
    expect(a.skinGenerate).toBe(true);
    expect(a.publicToggle).toBe('edit');
    expect(a.about).toBe('locked');
    expect(a.voice).toBe('locked');
    expect(a.pitch).toBe('hidden');
  });

  it('Others will hear: own ElevenLabs voice on an owned companion only', () => {
    expect(profileAccess({ ...base, kind: 'custom' }).othersHear).toBe('hidden');
    expect(profileAccess({ ...base, kind: 'custom', ownVoice: true }).othersHear).toBe('edit');
    expect(profileAccess({ ...base, kind: 'awakened', ownVoice: true }).othersHear).toBe('locked');
    expect(profileAccess({ ...base, kind: 'world', ownVoice: true }).othersHear).toBe('hidden');
  });

  it('No voice: nothing to tune, so no Pitch row', () => {
    expect(profileAccess({ ...base, kind: 'custom', noVoice: true }).pitch).toBe('hidden');
  });

  it('sectionOf maps every row to its section', () => {
    expect(sectionOf('about')).toBe('personality');
    expect(sectionOf('intro')).toBe('worldlink');
    expect(sectionOf('unbind')).toBe('danger');
  });
});

describe('foreign companions (Overview first, no owner rows)', () => {
  for (const kind of ['builtin', 'world'] as const) {
    it(`${kind}: no owner-only row exists at all, not even locked`, () => {
      const a = profileAccess({ ...base, kind, seilinkOn: true, ownVoice: true });
      for (const row of ['cardImage', 'skin', 'voice', 'pitch', 'about', 'persona', 'chess', 'publicToggle', 'othersHear'] as const) {
        expect(a[row], row).toBe('hidden');
      }
      expect(a.view).toBe('foreign');
      expect(ownerSections(a).flatMap((s) => s.rows).every((r) => !['cardImage', 'persona'].includes(r))).toBe(true);
    });
  }

  it('in the library: Overview + Your settings with only your per-companion rows', () => {
    const a = profileAccess({ ...base, kind: 'builtin', seilinkOn: true });
    expect(foreignTabs(a)).toEqual(['overview', 'settings']);
    expect(foreignSettingsRows(a)).toEqual([
      'avatar',
      'floatingAvatar',
      'knowledge',
      'dst',
      'desktopRoom',
      'room',
      'intro',
      'resetMemory',
      'unbind',
    ]);
    expect(a.avatarMode).toBe('pick');
  });

  it('a preview (World, or a removed built-in): the Overview only', () => {
    const a = profileAccess({ ...base, kind: 'world', inLibrary: false, seilinkOn: true });
    expect(foreignTabs(a)).toEqual(['overview']);
    expect(foreignSettingsRows(a)).toEqual([]);
    expect(a.report).toBe(true);
    expect(profileAccess({ ...base, kind: 'builtin', inLibrary: false }).report).toBe(false);
    // A removed Awakened companion previewed again cannot generate a skin.
    expect(profileAccess({ ...base, kind: 'awakened', inLibrary: false }).skinGenerate).toBe(false);
  });

  it('Report is for World companions, never a built-in', () => {
    expect(profileAccess({ ...base, kind: 'world' }).report).toBe(true);
    expect(profileAccess({ ...base, kind: 'builtin' }).report).toBe(false);
  });

  it('an owner has no foreign settings list', () => {
    expect(foreignSettingsRows(profileAccess({ ...base, kind: 'custom' }))).toEqual([]);
  });

  it('resolveForeignTab falls back to Overview', () => {
    expect(resolveForeignTab(['overview', 'settings'], 'settings')).toBe('settings');
    expect(resolveForeignTab(['overview'], 'settings')).toBe('overview');
    expect(resolveForeignTab(['overview'], null)).toBe('overview');
  });
});

describe('requested focus', () => {
  it('is used once, a tab or a section', () => {
    requestProfileFocus('games');
    expect(takeRequestedProfileFocus()).toBe('games');
    expect(takeRequestedProfileFocus()).toBe(null);
    requestProfileFocus('settings');
    expect(takeRequestedProfileFocus()).toBe('settings');
  });

  it('isProfileFocus accepts tabs and sections only', () => {
    expect(isProfileFocus('overview')).toBe(true);
    expect(isProfileFocus('worldlink')).toBe(true);
    expect(isProfileFocus('sharing')).toBe(true);
    expect(isProfileFocus('nope')).toBe(false);
    expect(isProfileFocus(null)).toBe(false);
  });
});

describe('lock tooltip', () => {
  it('names why, per kind, with the {name} placeholder', () => {
    expect(lockTipKey('builtin')).toMatch(/^\{name\} is a built-in companion/);
    expect(lockTipKey('world')).toMatch(/another player/);
    expect(lockTipKey('awakened')).toMatch(/awakened by Sei/);
    for (const k of ['builtin', 'world', 'awakened'] as const) expect(lockTipKey(k)).not.toContain('—');
  });
});

describe('analytics (shape only)', () => {
  beforeEach(() => track.mockClear());

  it('sends the profile events with closed props', () => {
    trackProfileViewed('foreign', 'world', 'world', false);
    trackProfileTabViewed('overview', 'builtin');
    trackProfileActionClicked('replay_intro', 'worldlink', 'custom');
    trackProfileTooltipOpened('locked');
    trackProfileVoiceSample('foreign', 'world', 'overview', 'bundled', 'played');
    trackProfileCtaClicked('invite', 'foreign', 'world', 'world');
    expect(track.mock.calls).toEqual([
      ['profile_viewed', { view: 'foreign', character_kind: 'world', entry: 'world', in_library: false }],
      ['profile_tab_viewed', { tab: 'overview', character_kind: 'builtin' }],
      ['profile_action_clicked', { action: 'replay_intro', tab: 'worldlink', character_kind: 'custom' }],
      ['profile_tooltip_opened', { key: 'locked' }],
      [
        'profile_voice_sample_played',
        { view: 'foreign', character_kind: 'world', tab: 'overview', source: 'bundled', outcome: 'played' },
      ],
      ['profile_cta_clicked', { cta: 'invite', view: 'foreign', character_kind: 'world', entry: 'world' }],
    ]);
  });

  it('never throws when the bridge does', () => {
    track.mockImplementationOnce(() => {
      throw new Error('bridge gone');
    });
    expect(() => trackProfileViewed('owner', 'custom', 'library', true)).not.toThrow();
  });
});
