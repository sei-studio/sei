/**
 * When the guide offers the SeiLink tour (261105, T337).
 *
 * The guide (Sui's onboarding sprites, TutorialOverlay) pops in once on a
 * calm Home screen and offers to show the new SeiLink button. "Sure" walks
 * to a companion's chat, spotlights the button, explains it in two lines and
 * opens the move-in sheet. "Not now" snoozes it: asked once more a few days
 * later, then never.
 *
 * Two audiences, told apart by a record written when onboarding finishes:
 *   new      — onboarded on a build with the tour. Never in the session that
 *              onboarded, and not before NEW_USER_DELAY_MS after it, so it
 *              never stacks on the onboarding tour or the first moment.
 *   existing — no onboarding record: they used Sei before this version. The
 *              guide says "Remember me? I'm back!".
 *
 * Nothing is offered when SeiLink is not available here, when the person
 * already linked (the intro was seen, or someone lives on the desktop), or
 * without a companion to show it with. Already linked retires the tour.
 *
 * localStorage per profile scope, like introPref (a lost record means one
 * more offer at worst). The rules are pure so they can be tested.
 */
import { profileScope } from './introPref';
import type { TourAudience } from '@shared/seilinkIntroTelemetry';

export const TOUR_SNOOZE_MS = 3 * 24 * 3_600_000;
export const NEW_USER_DELAY_MS = 24 * 3_600_000;
/** Offers in all: the first, and one more after a snooze. */
export const TOUR_MAX_OFFERS = 2;
/** First calm-screen look after launch, then the poll while busy. */
export const TOUR_FIRST_LOOK_MS = 12_000;
export const TOUR_POLL_MS = 4_000;

export interface SeilinkTourRecord {
  /** Onboarding finished on this account, on a build with the tour (ms). */
  onboardedAt?: number;
  /** Offers shown so far. */
  offers: number;
  /** Not now: ask again after this (ms). */
  snoozedUntil?: number;
  /** Retired: answered, finished, or no longer needed. */
  done?: boolean;
}

export const EMPTY_TOUR_RECORD: SeilinkTourRecord = { offers: 0 };

export interface TourDecisionInput {
  record: SeilinkTourRecord;
  now: number;
  /** SeiLink can run on this OS and build (availability.enabled). */
  available: boolean;
  /** This app session went through onboarding (the first-run scene). */
  onboardedThisSession: boolean;
  /** The intro was seen, or a companion lives on the desktop now. */
  alreadyLinked: boolean;
  /** A companion the tour can open the chat of. */
  hasCompanion: boolean;
}

export type TourDecision =
  | { kind: 'show'; audience: TourAudience; offer: number }
  /** Not now, maybe later this session or another launch. */
  | { kind: 'skip' }
  /** Never again on this account. */
  | { kind: 'retire' };

export function tourDecision(input: TourDecisionInput): TourDecision {
  const { record, now } = input;
  if (record.done) return { kind: 'retire' };
  if (!input.available) return { kind: 'skip' };
  if (input.alreadyLinked) return { kind: 'retire' };
  if (input.onboardedThisSession) return { kind: 'skip' };
  if (!input.hasCompanion) return { kind: 'skip' };
  if (record.offers >= TOUR_MAX_OFFERS) return { kind: 'retire' };
  const audience: TourAudience = record.onboardedAt !== undefined ? 'new' : 'existing';
  if (audience === 'new' && now - (record.onboardedAt ?? now) < NEW_USER_DELAY_MS) return { kind: 'skip' };
  if (record.snoozedUntil !== undefined && now < record.snoozedUntil) return { kind: 'skip' };
  return { kind: 'show', audience, offer: record.offers + 1 };
}

/** The offer went up. */
export function afterOffered(record: SeilinkTourRecord): SeilinkTourRecord {
  return { ...record, offers: record.offers + 1 };
}

/** Not now: snooze after the first offer, retire after the last. Returns whether it snoozed. */
export function afterNotNow(record: SeilinkTourRecord, now: number): { record: SeilinkTourRecord; snoozed: boolean } {
  if (record.offers >= TOUR_MAX_OFFERS) return { record: { ...record, done: true, snoozedUntil: undefined }, snoozed: false };
  return { record: { ...record, snoozedUntil: now + TOUR_SNOOZE_MS }, snoozed: true };
}

/** Sure, or anything else that ends it for good (finished, dropped, already linked). */
export function retired(record: SeilinkTourRecord): SeilinkTourRecord {
  return { ...record, done: true, snoozedUntil: undefined };
}

/** Onboarding finished: remember when, once (an older record keeps its date). */
export function afterOnboarded(record: SeilinkTourRecord, now: number): SeilinkTourRecord {
  if (record.onboardedAt !== undefined || record.offers > 0 || record.done) return record;
  return { ...record, onboardedAt: now };
}

// ── Storage ────────────────────────────────────────────────────────────────

const KEY_BASE = 'sei.seilinkTour.v1';

function parse(raw: string | null): SeilinkTourRecord {
  if (!raw) return { ...EMPTY_TOUR_RECORD };
  try {
    const v = JSON.parse(raw) as Partial<SeilinkTourRecord>;
    const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
    return {
      offers: Math.max(0, Math.min(9, Math.round(num(v.offers) ?? 0))),
      ...(num(v.onboardedAt) !== undefined ? { onboardedAt: num(v.onboardedAt) } : {}),
      ...(num(v.snoozedUntil) !== undefined ? { snoozedUntil: num(v.snoozedUntil) } : {}),
      ...(v.done === true ? { done: true } : {}),
    };
  } catch {
    return { ...EMPTY_TOUR_RECORD };
  }
}

export function readTourRecord(): SeilinkTourRecord {
  try {
    return parse(localStorage.getItem(`${KEY_BASE}.${profileScope()}`));
  } catch {
    return { ...EMPTY_TOUR_RECORD };
  }
}

export function writeTourRecord(record: SeilinkTourRecord): void {
  try {
    localStorage.setItem(`${KEY_BASE}.${profileScope()}`, JSON.stringify(record));
  } catch {
    /* private mode / quota */
  }
}

export function updateTourRecord(fn: (r: SeilinkTourRecord) => SeilinkTourRecord): SeilinkTourRecord {
  const next = fn(readTourRecord());
  writeTourRecord(next);
  return next;
}

// ── Session ────────────────────────────────────────────────────────────────

let onboardedThisSession = false;

/** App.tsx, when the first-run scene hands off (new or returning). */
export function noteOnboardingThisSession(opts: { newPlayer: boolean }, now = Date.now()): void {
  onboardedThisSession = true;
  if (opts.newPlayer) updateTourRecord((r) => afterOnboarded(r, now));
}

export function onboardingRanThisSession(): boolean {
  return onboardedThisSession;
}

/** Tests only. */
export function __resetTourSessionForTest(): void {
  onboardedThisSession = false;
}

/**
 * Who the tour shows SeiLink with: the companion she talked to last, else
 * Sui, else anyone. Ids only, so the caller passes what it has.
 */
export function pickTourCompanion(
  characters: readonly { id: string; lastAt?: string | null }[],
  suiId: string,
): string | null {
  if (characters.length === 0) return null;
  const withTime = characters.filter((c) => c.lastAt);
  if (withTime.length > 0) {
    return withTime.slice().sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))[0].id;
  }
  return characters.find((c) => c.id === suiId)?.id ?? characters[0].id;
}
