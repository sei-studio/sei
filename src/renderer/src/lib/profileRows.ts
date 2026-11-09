/**
 * Profile rows: which settings row a companion's profile shows, and whether
 * it is live, locked or hidden. Single source of truth for the page
 * (screens/CharacterPage.tsx) and its rows (components/profile/).
 *
 * Two views (product call 261110):
 *
 *  - OWNER (your own companion: 'custom', or an Awakened 'awakened' one):
 *    one scrolling settings page, no tabs, so nothing sits behind an extra
 *    click. Sections in the order people use them: Look, Voice,
 *    Personality, Games, Sharing, WorldLink, Danger zone. 261107 had six
 *    tabs; the call found too much hidden. Duplicates merged: Name and
 *    Description were two rows into the same editor (now "Name and
 *    description"), and the in-game username was its own row into the skin
 *    popup (now part of the Minecraft skin row).
 *  - FOREIGN (a built-in like Sui, or someone else's World companion): the
 *    page leads with an Overview (who made it, how many players added it,
 *    what it is, its voice, its games and its public avatars). The few
 *    settings that are genuinely yours for a companion in your library
 *    (which avatar plays, the floating avatar, Knowledge, the DST survivor,
 *    WorldLink, Reset memory, Unbind) sit on a second "Your settings" tab.
 *    Nothing an owner edits (look, voice, persona, Public) is shown there.
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

/** Owner = one settings page; foreign = Overview first. */
export type ProfileView = 'owner' | 'foreign';

/** The owner page's sections, top to bottom. */
export const PROFILE_SECTIONS = ['look', 'voice', 'personality', 'games', 'sharing', 'worldlink', 'danger'] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** A foreign companion's tabs (settings only while it is in your library). */
export const FOREIGN_TABS = ['overview', 'settings'] as const;
export type ForeignTab = (typeof FOREIGN_TABS)[number];

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

/**
 * A foreign companion's "Your settings" rows, in page order: the avatar pick
 * and floating avatar, Knowledge, the DST survivor, WorldLink, then the
 * danger rows. Empty for a preview (nothing is yours yet).
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

/** A foreign companion's tabs: Overview, plus Your settings once it is in the library. */
export function foreignTabs(access: ProfileAccess): ForeignTab[] {
  return foreignSettingsRows(access).length > 0 ? ['overview', 'settings'] : ['overview'];
}

/** The tab to show: the asked-for one when it exists, else Overview. */
export function resolveForeignTab(tabs: readonly ForeignTab[], wanted: ForeignTab | null | undefined): ForeignTab {
  if (wanted && tabs.includes(wanted)) return wanted;
  return 'overview';
}

// Where the next profile opens (a deep link, or the screenshot harness): a
// foreign tab, or an owner section scrolled into view. Read once by the
// page when it mounts, then cleared.
export type ProfileFocus = ForeignTab | ProfileSection;
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
    ((FOREIGN_TABS as readonly string[]).includes(v) || (PROFILE_SECTIONS as readonly string[]).includes(v))
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

/** Where on the page an action happened: an owner section, or a foreign tab. */
export type ProfilePlace = ProfileSection | ForeignTab;

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

/** profile_tab_viewed {tab, character_kind}: a foreign companion's tab, on open and on every change. */
export function trackProfileTabViewed(tab: ForeignTab, kind: ProfileKind): void {
  track('profile_tab_viewed', { tab, character_kind: kind });
}

/** profile_action_clicked {action, tab, character_kind}; `tab` is the section or foreign tab. */
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
