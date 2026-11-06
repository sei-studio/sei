/**
 * Profile rows (v0.7 "Option A", product call 261107): which settings row a
 * companion's profile shows, and whether it is live, locked or hidden.
 *
 * The page (screens/CharacterPage.tsx) is the companion's hero portrait plus
 * section tabs (Look, Voice, Personality, Games, Sharing, Danger zone). Each
 * row opens the existing editor for that one thing. This module is the single
 * place that decides who may use which row. The rules mirror the page and gear
 * menu they replace; they are not new:
 *
 *  - viewOnly (built-in, World, Awakened): the edit surfaces are locked.
 *    Only user-made `kind: 'custom'` companions edit name, description,
 *    persona, voice, skin, username and chess.
 *  - canShare = owned (custom or Awakened): public toggle, card image
 *    versions + Regenerate, Minecraft skin Regenerate.
 *  - In the library (not a World preview / removed built-in): Knowledge,
 *    DST survivor, WorldLink rows, Reset memory and Unbind.
 *  - World companions (foreign-owned): Report.
 *
 * Pure: no React, no IPC. Analytics helpers at the bottom (shape only).
 */
import { sei } from './ipcClient';

/** Who the companion is to the player, for row rules and analytics. */
export type ProfileKind = 'custom' | 'awakened' | 'builtin' | 'world';

export const PROFILE_TABS = ['look', 'voice', 'personality', 'games', 'sharing', 'danger'] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

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

export interface ProfileAccess {
  kind: ProfileKind;
  // Look
  cardImage: RowAccess;
  /** Upload / remove a card image inside the Versions popup. */
  cardUpload: boolean;
  skin: RowAccess;
  /** The Edit skin button (upload PNG, search a Minecraft name). */
  skinEdit: boolean;
  /** Generate / Regenerate the skin (free, product call 261028); the caller also needs a portrait. */
  skinGenerate: boolean;
  /** 'manage' = the avatar library (owner); 'pick' = choose which public avatar plays. */
  avatar: 'manage' | 'pick';
  floatingAvatar: RowAccess;
  // Voice
  voice: RowAccess;
  pitch: RowAccess;
  // Personality
  name: RowAccess;
  description: RowAccess;
  persona: RowAccess;
  knowledge: RowAccess;
  // Games
  username: RowAccess;
  chess: RowAccess;
  dst: RowAccess;
  // Sharing and WorldLink
  publicToggle: RowAccess;
  othersHear: RowAccess;
  desktopRoom: RowAccess;
  room: RowAccess;
  idleLines: RowAccess;
  intro: RowAccess;
  // Danger zone
  report: RowAccess;
  resetMemory: RowAccess;
  unbind: RowAccess;
}

export function profileAccess(input: ProfileAccessInput): ProfileAccess {
  const { kind, inLibrary } = input;
  const editable = kind === 'custom';
  const own = kind === 'custom' || kind === 'awakened';
  const editOrLock: RowAccess = editable ? 'edit' : 'locked';
  const ifLibrary: RowAccess = inLibrary ? 'edit' : 'hidden';
  const worldLink: RowAccess = input.seilinkOn && inLibrary ? 'edit' : 'hidden';
  const skinGenerate = own && inLibrary;
  return {
    kind,
    cardImage: own ? 'edit' : 'locked',
    cardUpload: editable,
    skin: editable || skinGenerate ? 'edit' : 'locked',
    skinEdit: editable,
    skinGenerate,
    avatar: editable ? 'manage' : 'pick',
    floatingAvatar: 'edit',
    voice: editOrLock,
    pitch: editable && !input.noVoice ? 'edit' : 'hidden',
    name: editOrLock,
    description: editOrLock,
    persona: editOrLock,
    knowledge: ifLibrary,
    username: editOrLock,
    chess: editOrLock,
    dst: ifLibrary,
    publicToggle: own ? 'edit' : 'hidden',
    othersHear: own && input.ownVoice ? editOrLock : 'hidden',
    desktopRoom: worldLink,
    room: worldLink,
    idleLines: worldLink === 'edit' && input.movedInHere ? 'edit' : 'hidden',
    intro: worldLink,
    report: kind === 'world' ? 'edit' : 'hidden',
    resetMemory: ifLibrary,
    unbind: ifLibrary,
  };
}

const TAB_ROWS: Record<ProfileTab, readonly (keyof Omit<ProfileAccess, 'kind' | 'avatar' | 'cardUpload' | 'skinEdit' | 'skinGenerate'>)[]> = {
  look: ['cardImage', 'skin', 'floatingAvatar'],
  voice: ['voice', 'pitch'],
  personality: ['name', 'description', 'persona', 'knowledge'],
  games: ['username', 'chess', 'dst'],
  sharing: ['publicToggle', 'othersHear', 'desktopRoom', 'room', 'idleLines', 'intro'],
  danger: ['report', 'resetMemory', 'unbind'],
};

/** The tabs that have at least one row, in page order. */
export function profileTabs(access: ProfileAccess): ProfileTab[] {
  return PROFILE_TABS.filter((tab) => TAB_ROWS[tab].some((row) => access[row] !== 'hidden'));
}

/** The Sharing tab is called WorldLink when only the WorldLink rows are in it. */
export function sharingTabLabel(access: ProfileAccess): 'Sharing' | 'WorldLink' {
  return access.publicToggle === 'hidden' && access.othersHear === 'hidden' ? 'WorldLink' : 'Sharing';
}

/** The tab to show: the asked-for one when it exists, else the first. */
export function resolveProfileTab(tabs: readonly ProfileTab[], wanted: ProfileTab | null | undefined): ProfileTab {
  if (wanted && tabs.includes(wanted)) return wanted;
  return tabs[0] ?? 'look';
}

// The tab the next profile opens on (a deep link, or the screenshot
// harness). Read once by the page when it mounts, then cleared.
let pendingTab: ProfileTab | null = null;

/** Open the next profile page on `tab` (used once). */
export function requestProfileTab(tab: ProfileTab | null): void {
  pendingTab = tab;
}

/** The requested tab, if any; clears the request. */
export function takeRequestedProfileTab(): ProfileTab | null {
  const tab = pendingTab;
  pendingTab = null;
  return tab;
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
  | 'pitch'
  | 'rename'
  | 'edit_description'
  | 'edit_persona'
  | 'knowledge'
  | 'change_username'
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

function track(event: string, props: Record<string, string | number>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics must never break the page */
  }
}

/** profile_tab_viewed {tab, character_kind}: on open and on every tab change. */
export function trackProfileTabViewed(tab: ProfileTab, kind: ProfileKind): void {
  track('profile_tab_viewed', { tab, character_kind: kind });
}

/** profile_action_clicked {action, tab, character_kind}. */
export function trackProfileActionClicked(action: ProfileAction, tab: ProfileTab, kind: ProfileKind): void {
  track('profile_action_clicked', { action, tab, character_kind: kind });
}

/** profile_tooltip_opened {key}: once per key per page visit (the caller dedupes). */
export function trackProfileTooltipOpened(key: string): void {
  track('profile_tooltip_opened', { key });
}
