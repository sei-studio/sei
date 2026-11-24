/**
 * Party full (261124): what a player sees when the party is at
 * MAX_COMPANION_SLOTS, and how they free a slot.
 *
 * Feedback 261123: "can't figure out how to remove companions to try
 * others". Unbind lives on a companion's page (More tab, Danger zone), which
 * a new player does not find. Every surface that says the party is full now
 * carries a "Free a slot" button (components/PartyFullHint.tsx) that opens a
 * small picker of the party; picking one opens that companion's page on the
 * Danger zone, where Unbind keeps its own confirm. Nothing is unbound for the
 * player.
 *
 * Analytics (shape only, docs/agents/party-slots.md):
 *   party_full_shown {surface}            a party-full line was shown (once per
 *                                          surface per app run)
 *   party_full_free_slot_tapped {surface} the Free a slot button
 *   party_full_slot_picked {surface}      a companion was picked in the picker
 *   party_full_unbind {surface, tapped, picked, secs_since_shown}
 *                                          a companion was unbound after a
 *                                          party-full line this run (first
 *                                          unbind only); `picked` = the one
 *                                          the picker opened
 */
import { errorMessageOf, stripIpcWrapper } from '@shared/ipcError';
import { sei } from './ipcClient';
import { requestProfileFocus } from './profileRows';

/** Where the party-full line showed. */
export type PartyFullSurface =
  /** World tab header ("Party full"). */
  | 'world'
  /** Invite to party on a World companion or a removed built-in. */
  | 'invite'
  /** Creating a companion (Awaken, add-character). */
  | 'create'
  /** A unique cast (Sui's scene) refused with slot_limit. */
  | 'cast'
  /** The own-key import notice over the app (sign-in / boot). */
  | 'import_notice'
  /** The own-key import modal, when main refused for a full party. */
  | 'import_modal'
  /** Settings, "Companions from before you signed in". */
  | 'import_settings';

/** The line shown where adding a companion failed for a full party. */
export const PARTY_FULL_HINT = 'Your party is full. Unbind a companion to make room.';
/** The button that opens the party picker. */
export const FREE_A_SLOT = 'Free a slot';

/** main's slot-limit message (ipc.ts SLOT_LIMIT_REACHED_MESSAGE, uniqueGeneration slot_limit). */
const SLOT_LIMIT_RE = /You can only have \d+ companions\. Remove one to make room\./;

/** Whether a caught error (or a result message) is main's party-full backstop. */
export function isPartyFullError(err: unknown): boolean {
  const msg = stripIpcWrapper(errorMessageOf(err));
  return SLOT_LIMIT_RE.test(msg);
}

/** Party size at or over the cap. */
export function partyIsFull(count: number, limit: number): boolean {
  return count >= limit;
}

/**
 * A companion picked in the Free a slot picker: their page opens on the
 * Danger zone (More tab), where Unbind asks to confirm. Never unbinds.
 */
export function openForUnbind(
  surface: PartyFullSurface,
  characterId: string,
  navigate: (view: { kind: 'character'; id: string }) => void,
): void {
  trackFreeSlotPicked(surface, characterId);
  requestProfileFocus('danger');
  navigate({ kind: 'character', id: characterId });
}

// ── Analytics ─────────────────────────────────────────────────────────────

function track(event: string, props: Record<string, string | number | boolean>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics must never break the hint */
  }
}

interface PartyFullSession {
  surface: PartyFullSurface;
  shownAt: number;
  tapped: boolean;
  pickedId: string | null;
}

/** The latest party-full line this run, until an unbind reports it. */
let session: PartyFullSession | null = null;
const shownThisRun = new Set<PartyFullSurface>();

/** A party-full line is on screen. Fires once per surface per run. */
export function trackPartyFullShown(surface: PartyFullSurface, now: number = Date.now()): void {
  if (!session || session.surface !== surface) {
    session = { surface, shownAt: now, tapped: false, pickedId: null };
  }
  if (shownThisRun.has(surface)) return;
  shownThisRun.add(surface);
  track('party_full_shown', { surface });
}

/** The Free a slot button was pressed. */
export function trackFreeSlotTapped(surface: PartyFullSurface, now: number = Date.now()): void {
  if (!session || session.surface !== surface) session = { surface, shownAt: now, tapped: false, pickedId: null };
  session.tapped = true;
  track('party_full_free_slot_tapped', { surface });
}

/** A companion was picked in the Free a slot picker (its page opens on Unbind). */
export function trackFreeSlotPicked(surface: PartyFullSurface, characterId: string, now: number = Date.now()): void {
  if (!session || session.surface !== surface) session = { surface, shownAt: now, tapped: true, pickedId: null };
  session.pickedId = characterId;
  track('party_full_slot_picked', { surface });
}

/**
 * A companion left the party (Unbind confirmed). Reports the first unbind
 * after a party-full line this run, then forgets the line.
 */
export function noteCompanionUnbound(characterId: string, now: number = Date.now()): void {
  if (!session) return;
  const s = session;
  session = null;
  track('party_full_unbind', {
    surface: s.surface,
    tapped: s.tapped,
    picked: s.pickedId === characterId,
    secs_since_shown: Math.max(0, Math.round((now - s.shownAt) / 1000)),
  });
}

/** Tests only. */
export function __resetPartyFullTracking(): void {
  session = null;
  shownThisRun.clear();
}
