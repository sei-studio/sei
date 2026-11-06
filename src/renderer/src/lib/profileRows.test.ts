/**
 * profileRows (261107, profile v0.7 "Option A"): who may use which profile
 * row, which tabs a companion gets, and the analytics shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const track = vi.fn();
(globalThis as unknown as { window: unknown }).window = { sei: { track } };

const {
  PROFILE_TABS,
  lockTipKey,
  profileAccess,
  profileKind,
  profileTabs,
  requestProfileTab,
  resolveProfileTab,
  sharingTabLabel,
  takeRequestedProfileTab,
  trackProfileActionClicked,
  trackProfileTabViewed,
  trackProfileTooltipOpened,
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

describe('profileKind', () => {
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
    // kind defaults to custom
    expect(profileKind({ is_default: false, owner: null }, ME)).toBe('custom');
  });

  it('your own system-cast companion is awakened', () => {
    expect(profileKind({ is_default: false, owner: ME, kind: 'unique' }, ME)).toBe('awakened');
  });
});

describe('profileAccess', () => {
  it('custom: every edit surface is live', () => {
    const a = profileAccess({ ...base, kind: 'custom' });
    for (const row of ['cardImage', 'skin', 'voice', 'pitch', 'name', 'description', 'persona', 'username', 'chess'] as const) {
      expect(a[row], row).toBe('edit');
    }
    expect(a.cardUpload).toBe(true);
    expect(a.skinEdit).toBe(true);
    expect(a.skinGenerate).toBe(true);
    expect(a.avatar).toBe('manage');
    expect(a.publicToggle).toBe('edit');
    expect(a.report).toBe('hidden');
    expect(a.resetMemory).toBe('edit');
    expect(a.unbind).toBe('edit');
  });

  it('built-in: look, voice and personality are locked, the rest stays live', () => {
    const a = profileAccess({ ...base, kind: 'builtin' });
    for (const row of ['cardImage', 'skin', 'voice', 'name', 'description', 'persona', 'username', 'chess'] as const) {
      expect(a[row], row).toBe('locked');
    }
    expect(a.pitch).toBe('hidden');
    expect(a.cardUpload).toBe(false);
    expect(a.skinEdit).toBe(false);
    expect(a.skinGenerate).toBe(false);
    expect(a.avatar).toBe('pick');
    expect(a.floatingAvatar).toBe('edit');
    expect(a.knowledge).toBe('edit');
    expect(a.dst).toBe('edit');
    // The Sharing rows are hidden for built-ins.
    expect(a.publicToggle).toBe('hidden');
    expect(a.othersHear).toBe('hidden');
    expect(a.report).toBe('hidden');
    expect(a.resetMemory).toBe('edit');
    expect(a.unbind).toBe('edit');
  });

  it('World: locked like a built-in, plus Report', () => {
    const a = profileAccess({ ...base, kind: 'world' });
    expect(a.name).toBe('locked');
    expect(a.cardImage).toBe('locked');
    expect(a.publicToggle).toBe('hidden');
    expect(a.report).toBe('edit');
    expect(a.avatar).toBe('pick');
  });

  it('awakened: owned, so the card image, skin generation and Public stay live; the edit surfaces lock', () => {
    const a = profileAccess({ ...base, kind: 'awakened' });
    expect(a.cardImage).toBe('edit');
    expect(a.cardUpload).toBe(false);
    expect(a.skin).toBe('edit');
    expect(a.skinEdit).toBe(false);
    expect(a.skinGenerate).toBe(true);
    expect(a.publicToggle).toBe('edit');
    expect(a.name).toBe('locked');
    expect(a.voice).toBe('locked');
    expect(a.pitch).toBe('hidden');
  });

  it('a preview (not in the library) hides the library-only rows', () => {
    const a = profileAccess({ ...base, kind: 'world', inLibrary: false, seilinkOn: true });
    expect(a.knowledge).toBe('hidden');
    expect(a.dst).toBe('hidden');
    expect(a.desktopRoom).toBe('hidden');
    expect(a.resetMemory).toBe('hidden');
    expect(a.unbind).toBe('hidden');
    expect(a.report).toBe('edit');
    // A removed built-in previewed again cannot generate a skin either.
    expect(profileAccess({ ...base, kind: 'awakened', inLibrary: false }).skinGenerate).toBe(false);
  });

  it('WorldLink rows need WorldLink; Idle lines also needs her on the desktop', () => {
    const off = profileAccess({ ...base, kind: 'builtin' });
    expect([off.desktopRoom, off.room, off.idleLines, off.intro]).toEqual(['hidden', 'hidden', 'hidden', 'hidden']);
    const on = profileAccess({ ...base, kind: 'builtin', seilinkOn: true });
    expect([on.desktopRoom, on.room, on.idleLines, on.intro]).toEqual(['edit', 'edit', 'hidden', 'edit']);
    const here = profileAccess({ ...base, kind: 'builtin', seilinkOn: true, movedInHere: true });
    expect(here.idleLines).toBe('edit');
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
});

describe('tabs', () => {
  it('own companion: all six tabs, Sharing named Sharing', () => {
    const a = profileAccess({ ...base, kind: 'custom' });
    expect(profileTabs(a)).toEqual([...PROFILE_TABS]);
    expect(sharingTabLabel(a)).toBe('Sharing');
  });

  it('built-in without WorldLink: no Sharing tab', () => {
    const a = profileAccess({ ...base, kind: 'builtin' });
    expect(profileTabs(a)).toEqual(['look', 'voice', 'personality', 'games', 'danger']);
  });

  it('built-in with WorldLink: the tab holds only WorldLink rows and is named WorldLink', () => {
    const a = profileAccess({ ...base, kind: 'builtin', seilinkOn: true });
    expect(profileTabs(a)).toContain('sharing');
    expect(sharingTabLabel(a)).toBe('WorldLink');
  });

  it('a World preview keeps Danger zone for Report', () => {
    const a = profileAccess({ ...base, kind: 'world', inLibrary: false });
    expect(profileTabs(a)).toEqual(['look', 'voice', 'personality', 'games', 'danger']);
  });

  it('resolveProfileTab falls back to the first tab', () => {
    const tabs = ['look', 'voice', 'danger'] as const;
    expect(resolveProfileTab(tabs, 'voice')).toBe('voice');
    expect(resolveProfileTab(tabs, 'sharing')).toBe('look');
    expect(resolveProfileTab(tabs, null)).toBe('look');
    expect(resolveProfileTab([], null)).toBe('look');
  });

  it('a requested tab is used once', () => {
    requestProfileTab('games');
    expect(takeRequestedProfileTab()).toBe('games');
    expect(takeRequestedProfileTab()).toBe(null);
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

  it('sends the three profile events with closed props', () => {
    trackProfileTabViewed('voice', 'builtin');
    trackProfileActionClicked('replay_intro', 'sharing', 'custom');
    trackProfileTooltipOpened('locked');
    expect(track.mock.calls).toEqual([
      ['profile_tab_viewed', { tab: 'voice', character_kind: 'builtin' }],
      ['profile_action_clicked', { action: 'replay_intro', tab: 'sharing', character_kind: 'custom' }],
      ['profile_tooltip_opened', { key: 'locked' }],
    ]);
  });

  it('never throws when the bridge does', () => {
    track.mockImplementationOnce(() => {
      throw new Error('bridge gone');
    });
    expect(() => trackProfileTabViewed('look', 'custom')).not.toThrow();
  });
});
