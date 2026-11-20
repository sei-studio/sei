/**
 * The desktop hint (product call (261116)): when WorldLink opens or updates
 * the desktop, the app says so in one brief line that hides itself after
 * DESKTOP_HINT_MS, with "Hide windows" (main: seilink:stage minimize_others
 * with `reveal`: every other app's windows minimized on Windows, hidden on
 * macOS, then Sei steps aside; nothing is closed or quit).
 *
 * Pure decisions here; the store holds the hint (useSeilinkStore.desktopHint)
 * and components/seilink/DesktopHint.tsx shows it.
 *  - opened: the host came up running for a companion (a move-in, or a swap
 *    to another one). Not the move-in restored at launch (BOOT_QUIET_MS after
 *    the store started), not a restart after a host crash, and not while the
 *    first-link intro, the live card or the desktop editor is up (they say it
 *    already, or the app is not in front).
 *  - updated: her room was saved from the in-app editor while she lives on
 *    the desktop, shown when that editor closes (the desktop editor already
 *    shows the desktop when it closes).
 */
import type { SeilinkHostStatus } from '@shared/seilinkHost';
import type { DesktopHintKind } from '@shared/seilinkSetupTelemetry';

/** How long the hint stays (hover keeps it). */
export const DESKTOP_HINT_MS = 6_000;
/** A host that comes up this soon after the app started is the move-in restored at launch. */
export const BOOT_QUIET_MS = 20_000;

export interface DesktopHint {
  kind: DesktopHintKind;
  characterId: string;
  /** Counts up, so the same hint twice is shown afresh. */
  seq: number;
  /** When it was raised (Date.now()); one that waited past HINT_STALE_MS behind a sheet is dropped. */
  at: number;
}

/** A hint still waiting this long (a sheet or card was up) is no longer news. */
export const HINT_STALE_MS = 15_000;

export interface OpenedContext {
  /** ms since the store started (app launch). */
  sinceStartMs: number;
  intro: boolean;
  liveCard: boolean;
  /** The room editor is open on the desktop stage. */
  desktopEditor: boolean;
}

/** The companion to say "opened" for, or null. */
export function openedHintFor(prev: SeilinkHostStatus, next: SeilinkHostStatus, ctx: OpenedContext): string | null {
  if (next.state !== 'running' || !next.characterId) return null;
  if (prev.state === 'running' && prev.characterId === next.characterId) return null;
  // A host restart (a crash, Explorer restarting) is not WorldLink opening the desktop.
  if (prev.state === 'restarting' && prev.characterId === next.characterId) return null;
  if (ctx.sinceStartMs < BOOT_QUIET_MS) return null;
  if (ctx.intro || ctx.liveCard || ctx.desktopEditor) return null;
  return next.characterId;
}

/** Whether closing the in-app editor says "updated". */
export function updatedHintFor(closed: { characterId: string; desktop: boolean }, savedFor: ReadonlySet<string>, livingId: string | null): boolean {
  return !closed.desktop && livingId === closed.characterId && savedFor.has(closed.characterId);
}
