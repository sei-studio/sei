/**
 * When to offer bringing the own-key (local) profile's companions into a Sei
 * account (261023).
 *
 * The offer used to come only on a sign-in to a NEW account (no name yet) made
 * outside the first-run scene. Signing into an EXISTING account, or signing in
 * from the scene's sign-in panel (where a signed-out own-key player lands at
 * every launch), skipped it, so the local companions and memories stayed
 * behind in the local profile with nothing pointing at them.
 */
import type { PeekLocalProfileResult, ScopeChangedEvent } from '../../../shared/ipc';

/**
 * Whether the peek has anything to offer. A new account also takes the
 * onboarding answers (name); an existing one already has its own, so only
 * companions or memories are worth a prompt.
 */
export function shouldOfferLocalImport(
  peek: PeekLocalProfileResult | null | undefined,
  existingAccount: boolean,
): boolean {
  if (!peek) return false;
  return existingAccount ? peek.hasCompanionData === true : peek.hasData === true;
}

/**
 * On a scope change: offer now, after the first-run scene hands off (it owns
 * navigation while it is up), or not at all (sign-out, account to account).
 */
export function localImportOfferTiming(
  reason: ScopeChangedEvent['reason'],
  inOnboarding: boolean,
  restored = false,
): 'now' | 'after-onboarding' | 'none' {
  if (reason !== 'sign-in') return 'none';
  // 261029: a session restored at launch is not a sign-in (the one-time boot
  // offer covers accounts that never saw the sign-in one).
  if (restored) return 'none';
  return inOnboarding ? 'after-onboarding' : 'now';
}

/**
 * Whether the local profile holds companions or memories worth bringing into
 * an existing account (261023): anything beyond the Sui the first-run scene
 * seeded and the player never touched. Drives the one-time boot offer and the
 * Settings row. (The sign-in offer keeps shouldOfferLocalImport.)
 */
export function hasImportableLeftovers(peek: PeekLocalProfileResult | null | undefined): boolean {
  if (!peek || peek.hasCompanionData !== true) return false;
  const untouched = new Set(peek.untouchedSeedIds ?? []);
  return [...peek.migratableCharacterIds, ...peek.memoryOnlyCharacterIds].some((id) => !untouched.has(id));
}

/** First boot-offer look after sign-in is known, then the poll while the UI is busy. */
export const BOOT_OFFER_FIRST_MS = 2500;
export const BOOT_OFFER_POLL_MS = 3000;

/** What the renderer is doing right now, for the boot offer's "quiet moment" gate. */
export interface BootOfferUi {
  signedIn: boolean;
  /** The current view, e.g. 'home', 'onboard', 'chat'. */
  viewKind: string;
  /** Any modal is up (a store modal, or any ModalShell dialog in the DOM). */
  modalOpen: boolean;
  /** The post-onboarding tour or the guided first moment is running. */
  tourActive: boolean;
  /** A call, game, screen share or summoned bot is live or starting. */
  liveSession: boolean;
}

/**
 * The boot offer only interrupts a calm Home screen: never onboarding (or
 * any of its setup screens), never a game, call or share, never over another
 * modal, and never during the tour.
 */
export function bootOfferUiReady(ui: BootOfferUi): boolean {
  return ui.signedIn && ui.viewKind === 'home' && !ui.modalOpen && !ui.tourActive && !ui.liveSession;
}

export interface BootOfferDeps {
  ui: () => BootOfferUi;
  peek: () => Promise<PeekLocalProfileResult>;
  /** Whether the signed-in account already answered the offer on this device. */
  offered: () => Promise<boolean>;
}

/**
 * One boot-offer check (261023). Accounts that signed in on a build without
 * the existing-account offer never saw it, so their local companions sit in
 * the local profile; this offers them once.
 *
 *   'wait' — not a good moment; check again later.
 *   'done' — nothing to offer, or this account already answered.
 *   'show' — show the modal now (the UI is re-checked after the reads).
 */
export async function checkBootImportOffer(
  deps: BootOfferDeps,
): Promise<{ kind: 'wait' } | { kind: 'done' } | { kind: 'show'; peek: PeekLocalProfileResult }> {
  if (!bootOfferUiReady(deps.ui())) return { kind: 'wait' };
  if (await deps.offered()) return { kind: 'done' };
  const peek = await deps.peek();
  if (!hasImportableLeftovers(peek)) return { kind: 'done' };
  // The reads took a moment; the player may have opened something meanwhile.
  if (!bootOfferUiReady(deps.ui())) return { kind: 'wait' };
  return { kind: 'show', peek };
}
