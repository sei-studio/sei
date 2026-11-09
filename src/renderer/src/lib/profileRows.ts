/**
 * Profile rows: which settings row a companion's profile shows, and whether
 * it is live, locked or hidden, and which tab of the page it sits on. Single
 * source of truth for the page (screens/CharacterPage.tsx) and its rows
 * (components/profile/).
 *
 * Two views:
 *
 *  - OWNER (your own companion: 'custom', or an Awakened 'awakened' one):
 *    a top section menu, one tab shown at a time (product call 261110,
 *    second pass: "I don't like scrolling"; the first pass had made it one
 *    long page, 261107 had six tabs that hid too much). Tabs: Look, Voice,
 *    Personality, Games, WorldLink (only where WorldLink is available) and
 *    More (Sharing, then the Danger zone last, each under a small heading).
 *    WorldLink is its own tab so More never needs a scroll. Duplicates stay merged:
 *    "Name and description" is one row, the in-game username is part of the
 *    Minecraft skin row.
 *  - FOREIGN (a built-in like Sui, or someone else's World companion): the
 *    page leads with an Overview (its voice, games and public avatars). Once
 *    it is in your library, "Your settings" holds the few rows that are yours
 *    for it (which avatar plays, the floating avatar, Knowledge, the DST
 *    survivor), then WorldLink, and More holds the Danger zone, as on your
 *    own companion's page. Nothing an owner edits (look, voice, persona, Public)
 *    is shown there.
 *
 * Row groups (`ProfileSection`: look, voice, personality, games, sharing,
 * worldlink, danger) stay the unit rows belong to; a tab shows one or more
 * groups (`ProfileTab`).
 *
 * Access rules (unchanged from the gear menu era):
 *  - Only user-made `kind: 'custom'` companions edit name, description,
 *    persona, voice, skin, username and chess; an Awakened one shows them
 *    locked.
 *  - Owned (custom or Awakened): Public, card image versions, skin
 *    generation.
 *  - In the library (not a World preview, not a removed built-in):
 *    Knowledge, DST survivor, WorldLink rows, Reset memory, Unbind.
 *
 * Pure: no React, no IPC. Analytics helpers at the bottom (shape only).
 */
import { sei } from './ipcClient';

/** Who the companion is to the player, for row rules and analytics. */
export type ProfileKind = 'custom' | 'awakened' | 'builtin' | 'world';

/** Owner = settings tabs; foreign = Overview first. */
export type ProfileView = 'owner' | 'foreign';

/** Row groups, in page order (the Danger zone is always last). */
export const PROFILE_SECTIONS = ['look', 'voice', 'personality', 'games', 'sharing', 'worldlink', 'danger'] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** Your own companion's tabs, left to right. */
export const OWNER_TABS = ['look', 'voice', 'personality', 'games', 'worldlink', 'more'] as const;
export type OwnerTab = (typeof OWNER_TABS)[number];

/** A foreign companion's tabs (all but the Overview only while it is in your library). */
export const FOREIGN_TABS = ['overview', 'settings', 'worldlink', 'more'] as const;
export type ForeignTab = (typeof FOREIGN_TABS)[number];

/** Any tab of the page's section menu. */
export type ProfileTab = OwnerTab | ForeignTab;

/** The row groups the More tab holds, under small headings. */
const MORE_SECTIONS: readonly ProfileSection[] = ['sharing', 'danger'];

/** 'edit' = live controls, 'locked' = value plus a Locked marker, 'hidden' = no row. */
export type RowAccess = 'edit' | 'locked' | 'hidden';

export interface ProfileCharacter {
  is_default: boolean;
  owner?: string | null;
  kind?: string;
}

export function profileKind(character: ProfileCharacter, currentUserId: string | null): ProfileKind {
  if (character.is_default) return 'builtin';
  // A cloud owner that is not you: someone else's companion (World), signed
  // out included. Legacy null-owner local companions stay yours.
  if (character.owner && character.owner !== currentUserId) return 'world';
  // Only user-made companions are editable; a system-cast one ('unique') is
  // yours to share but stays as cast.
  if ((character.kind ?? 'custom') !== 'custom') return 'awakened';
  return 'custom';
}

export function profileView(kind: ProfileKind): ProfileView {
  return kind === 'custom' || kind === 'awakened' ? 'owner' : 'foreign';
}

export interface ProfileAccessInput {
  kind: ProfileKind;
  /** In the player's library (not a World preview, not a removed built-in). */
  inLibrary: boolean;
  /** WorldLink is available on this install. */
  seilinkOn: boolean;
  /** This companion currently lives on the desktop. */
  movedInHere: boolean;
  /** The voice is the author's own ElevenLabs voice (shared/voiceIds ownVoiceOf). */
  ownVoice: boolean;
  /** The voice is set to "No voice" (nothing to tune). */
  noVoice: boolean;
}

/** Every row a profile can have. */
export type RowKey =
  | 'cardImage'
  | 'skin'
  | 'avatar'
  | 'floatingAvatar'
  | 'voice'
  | 'pitch'
  | 'about'
  | 'persona'
  | 'knowledge'
  | 'chess'
  | 'dst'
  | 'publicToggle'
  | 'othersHear'
  | 'desktopRoom'
  | 'room'
  | 'idleLines'
  | 'intro'
  | 'resetMemory'
  | 'unbind';

export type ProfileAccess = Record<RowKey, RowAccess> & {
  kind: ProfileKind;
  view: ProfileView;
  /** Upload / remove a card image inside the Versions popup. */
  cardUpload: boolean;
  /** The skin popup's editing (upload PNG, search a Minecraft name, username). */
  skinEdit: boolean;
  /** Generate / Regenerate the skin (free, product call 261028); the caller also needs a portrait. */
  skinGenerate: boolean;
  /** 'manage' = the avatar library (owner); 'pick' = choose which public avatar plays. */
  avatarMode: 'manage' | 'pick';
  /** The Report link (someone else's World companion). */
  report: boolean;
};

export function profileAccess(input: ProfileAccessInput): ProfileAccess {
  const { kind, inLibrary } = input;
  const editable = kind === 'custom';
  const own = kind === 'custom' || kind === 'awakened';
  const editOrLock: RowAccess = editable ? 'edit' : 'locked';
  const ifLibrary: RowAccess = inLibrary ? 'edit' : 'hidden';
  const ownOnly = (a: RowAccess): RowAccess => (own ? a : 'hidden');
  const worldLink: RowAccess = input.seilinkOn && inLibrary ? 'edit' : 'hidden';
  const skinGenerate = own && inLibrary;
  return {
    kind,
    view: profileView(kind),
    cardUpload: editable,
    skinEdit: editable,
    skinGenerate,
    avatarMode: editable ? 'manage' : 'pick',
    report: kind === 'world',
    // Look (the owner's; a foreign companion's look is on its Overview)
    cardImage: ownOnly('edit'),
    skin: ownOnly(editable || skinGenerate ? 'edit' : 'locked'),
    avatar: own || inLibrary ? 'edit' : 'hidden',
    floatingAvatar: ifLibrary,
    // Voice
    voice: ownOnly(editOrLock),
    pitch: editable && !input.noVoice ? 'edit' : 'hidden',
    // Personality
    about: ownOnly(editOrLock),
    persona: ownOnly(editOrLock),
    knowledge: ifLibrary,
    // Games
    chess: ownOnly(editOrLock),
    dst: ifLibrary,
    // Sharing
    publicToggle: ownOnly('edit'),
    othersHear: own && input.ownVoice ? editOrLock : 'hidden',
    // WorldLink
    desktopRoom: worldLink,
    room: worldLink,
    idleLines: worldLink === 'edit' && input.movedInHere ? 'edit' : 'hidden',
    intro: worldLink,
    // Danger zone
    resetMemory: ifLibrary,
    unbind: ifLibrary,
  };
}

const SECTION_ROWS: Record<ProfileSection, readonly RowKey[]> = {
  look: ['cardImage', 'skin', 'avatar', 'floatingAvatar'],
  voice: ['voice', 'pitch'],
  personality: ['about', 'persona', 'knowledge'],
  games: ['chess', 'dst'],
  sharing: ['publicToggle', 'othersHear'],
  worldlink: ['desktopRoom', 'room', 'idleLines', 'intro'],
  danger: ['resetMemory', 'unbind'],
};

/** The section a row sits in (analytics groups actions by it). */
export function sectionOf(row: RowKey): ProfileSection {
  for (const s of PROFILE_SECTIONS) if (SECTION_ROWS[s].includes(row)) return s;
  return 'look';
}

/** The owner page: each section with its visible rows, empty sections dropped. */
export function ownerSections(access: ProfileAccess): { section: ProfileSection; rows: RowKey[] }[] {
  return PROFILE_SECTIONS.map((section) => ({
    section,
    rows: SECTION_ROWS[section].filter((row) => access[row] !== 'hidden'),
  })).filter((s) => s.rows.length > 0);
}

/** The owner tab a row group sits on. */
export function ownerTabOf(section: ProfileSection): OwnerTab {
  return MORE_SECTIONS.includes(section) ? 'more' : (section as OwnerTab);
}

/**
 * A foreign companion's settings rows, in page order: the avatar pick and
 * floating avatar, Knowledge, the DST survivor, WorldLink, then the danger
 * rows. Empty for a preview (nothing is yours yet).
 */
const FOREIGN_SETTINGS_ROWS: readonly RowKey[] = [
  'avatar',
  'floatingAvatar',
  'knowledge',
  'dst',
  'desktopRoom',
  'room',
  'idleLines',
  'intro',
  'resetMemory',
  'unbind',
];

export function foreignSettingsRows(access: ProfileAccess): RowKey[] {
  if (access.view !== 'foreign' || access.unbind === 'hidden') return [];
  return FOREIGN_SETTINGS_ROWS.filter((row) => access[row] !== 'hidden');
}

/** One heading's worth of rows on a tab; `section` null = no heading. */
export interface TabGroup {
  section: ProfileSection | null;
  rows: RowKey[];
}

/**
 * The rows a tab shows, grouped. A tab that is one row group (Look, Voice,
 * WorldLink) has no heading (the tab names it); More heads each group.
 */
export function tabGroups(access: ProfileAccess, tab: ProfileTab): TabGroup[] {
  if (tab === 'overview') return [];
  if (access.view === 'owner') {
    const groups = ownerSections(access).filter((g) => ownerTabOf(g.section) === tab);
    return tab === 'more' ? groups : groups.map((g) => ({ section: null, rows: g.rows }));
  }
  const rows = foreignSettingsRows(access);
  if (tab === 'settings' || tab === 'worldlink') {
    const plain = rows.filter((r) => {
      const section = sectionOf(r);
      return tab === 'worldlink' ? section === 'worldlink' : section !== 'worldlink' && !MORE_SECTIONS.includes(section);
    });
    return plain.length > 0 ? [{ section: null, rows: plain }] : [];
  }
  if (tab === 'more') {
    return MORE_SECTIONS.map((section) => ({ section, rows: rows.filter((r) => sectionOf(r) === section) })).filter(
      (g) => g.rows.length > 0,
    );
  }
  return [];
}

/** The page's tabs: your own companion's sections, or Overview plus what is yours. */
export function profileTabs(access: ProfileAccess): ProfileTab[] {
  if (access.view === 'owner') return OWNER_TABS.filter((tab) => tabGroups(access, tab).length > 0);
  return FOREIGN_TABS.filter((tab) => tab === 'overview' || tabGroups(access, tab).length > 0);
}

/**
 * The tab a focus request lands on: a tab itself, or the tab that holds a
 * row group (Sharing and the Danger zone are on More). Falls back to
 * the first tab when the page has no such tab.
 */
export function resolveProfileTab(tabs: readonly ProfileTab[], wanted: ProfileFocus | null | undefined): ProfileTab {
  if (wanted) {
    const tab: ProfileTab = (PROFILE_SECTIONS as readonly string[]).includes(wanted)
      ? ownerTabOf(wanted as ProfileSection)
      : (wanted as ProfileTab);
    if (tabs.includes(tab)) return tab;
  }
  return tabs[0] ?? 'overview';
}

// Where the next profile opens (a deep link, or the screenshot harness): a
// tab, or a row group (the page opens the tab that holds it and brings the
// group into view). Read once by the page when it mounts, then cleared.
export type ProfileFocus = ProfileTab | ProfileSection;
let pendingFocus: ProfileFocus | null = null;

/** Open the next profile page on `focus` (used once). */
export function requestProfileFocus(focus: ProfileFocus | null): void {
  pendingFocus = focus;
}

/** The requested focus, if any; clears the request. */
export function takeRequestedProfileFocus(): ProfileFocus | null {
  const focus = pendingFocus;
  pendingFocus = null;
  return focus;
}

export function isProfileFocus(v: unknown): v is ProfileFocus {
  return (
    typeof v === 'string' &&
    ((FOREIGN_TABS as readonly string[]).includes(v) ||
      (OWNER_TABS as readonly string[]).includes(v) ||
      (PROFILE_SECTIONS as readonly string[]).includes(v))
  );
}

/** English key of the Locked marker's tooltip (translated by the caller). */
export function lockTipKey(kind: ProfileKind): string {
  switch (kind) {
    case 'builtin':
      return '{name} is a built-in companion, so the look, voice and personality stay as made. Companions you create can change all of it.';
    case 'world':
      return '{name} was made by another player, so only they can change this. Companions you create can change all of it.';
    default:
      return '{name} was awakened by Sei, so the look, voice and personality stay as cast. Companions you create can change all of it.';
  }
}

// ── Analytics (shape only: closed enums, no names or text) ────────────────

/** What a row's button did. */
export type ProfileAction =
  | 'card_versions'
  | 'regenerate_card'
  | 'edit_skin'
  | 'regenerate_skin'
  | 'manage_avatars'
  | 'change_avatar'
  | 'floating_avatar'
  | 'edit_voice'
  | 'voice_sample'
  | 'pitch'
  | 'edit_about'
  | 'edit_persona'
  | 'knowledge'
  | 'edit_chess'
  | 'dst_survivor'
  | 'toggle_public'
  | 'others_hear'
  | 'move_onto_desktop'
  | 'move_off_desktop'
  | 'edit_room'
  | 'idle_lines_on'
  | 'idle_lines_off'
  | 'replay_intro'
  | 'report'
  | 'reset_memory'
  | 'unbind';

/** How the player got to the profile. */
export type ProfileEntry = 'world' | 'chat' | 'library';

/** Where on the page an action happened: the tab it was on. */
export type ProfilePlace = ProfileTab;

/** The page's main buttons. */
export type ProfileCta = 'invite' | 'chat' | 'play';

function track(event: string, props: Record<string, string | number | boolean>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics must never break the page */
  }
}

/** profile_viewed {view, character_kind, entry, in_library}: once per opened companion. */
export function trackProfileViewed(view: ProfileView, kind: ProfileKind, entry: ProfileEntry, inLibrary: boolean): void {
  track('profile_viewed', { view, character_kind: kind, entry, in_library: inLibrary });
}

/**
 * profile_tab_viewed {tab, view, character_kind}: the section menu's tab, on
 * open and on every change (your own companion's tabs too, since 261110's
 * second pass).
 */
export function trackProfileTabViewed(tab: ProfileTab, view: ProfileView, kind: ProfileKind): void {
  track('profile_tab_viewed', { tab, view, character_kind: kind });
}

/** profile_action_clicked {action, tab, character_kind}; `tab` is the tab the action was on. */
export function trackProfileActionClicked(action: ProfileAction, place: ProfilePlace, kind: ProfileKind): void {
  track('profile_action_clicked', { action, tab: place, character_kind: kind });
}

/** profile_tooltip_opened {key}: once per key per page visit (the caller dedupes). */
export function trackProfileTooltipOpened(key: string): void {
  track('profile_tooltip_opened', { key });
}

/**
 * profile_voice_sample_played {view, character_kind, tab, source, outcome}:
 * the Overview's (or the owner's Voice row's) sample button. source: bundled
 * (the shipped clip, no TTS call) | synth (voicePreview); outcome: played |
 * failed.
 */
export function trackProfileVoiceSample(
  view: ProfileView,
  kind: ProfileKind,
  place: ProfilePlace,
  source: 'bundled' | 'synth',
  outcome: 'played' | 'failed',
): void {
  track('profile_voice_sample_played', { view, character_kind: kind, tab: place, source, outcome });
}

/** profile_cta_clicked {cta, view, character_kind, entry}. */
export function trackProfileCtaClicked(cta: ProfileCta, view: ProfileView, kind: ProfileKind, entry: ProfileEntry): void {
  track('profile_cta_clicked', { cta, view, character_kind: kind, entry });
}
