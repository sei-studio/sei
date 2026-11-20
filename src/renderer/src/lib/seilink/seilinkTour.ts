/**
 * The guide's SeiLink tour, its answers (261105, T337). The decision of WHEN
 * it is offered is tourPref.tourDecision (App.tsx asks it on a calm screen);
 * this file records what the player did with it and starts the tour mode of
 * useTutorialStore that TutorialOverlay draws.
 *
 *   offer    Sui asks (Sure / Not now). Not now snoozes it a few days, once;
 *            the second Not now retires it.
 *   button   Sure: her chat, the top bar's SeiLink button spotlighted, a line.
 *   room     A second line, then the move-in sheet opens (openSeilink 'tour').
 * Skip tutorial during button/room counts as dropped and retires the tour.
 */
import { SEILINK_TOUR_EVENT, type TourAction, type TourAudience, type TourStepName } from '@shared/seilinkIntroTelemetry';
import { sei } from '../ipcClient';
import { useTutorialStore } from '../stores/useTutorialStore';
import { afterNotNow, afterOffered, retired, updateTourRecord } from './tourPref';
import { openSeilink } from './seilinkFlow';

function track(action: TourAction, extra: Record<string, string | number | boolean> = {}): void {
  const { seilink } = useTutorialStore.getState();
  try {
    sei.track(SEILINK_TOUR_EVENT, { action, audience: seilink?.audience ?? 'existing', offer_n: seilink?.offer ?? 1, ...extra });
  } catch {
    /* analytics must never disrupt the tour */
  }
}

/** Show the offer for `characterId`'s chat (the scheduler already said 'show'). */
export function beginSeilinkTour(characterId: string, audience: TourAudience): void {
  const record = updateTourRecord(afterOffered);
  useTutorialStore.getState().startSeilink(characterId, audience, record.offers);
  track('offered');
}

export function seilinkTourSure(): void {
  track('sure');
  // Saying yes is the answer: whatever happens next, it is not asked again.
  updateTourRecord(retired);
}

export function seilinkTourNotNow(now = Date.now()): void {
  let snoozed = false;
  updateTourRecord((r) => {
    const next = afterNotNow(r, now);
    snoozed = next.snoozed;
    return next.record;
  });
  track('not_now', { snoozed });
  useTutorialStore.getState().end();
}

/** The last line was read: open SeiLink for her. */
export function seilinkTourCompleted(): void {
  const id = useTutorialStore.getState().characterId;
  track('completed');
  useTutorialStore.getState().end();
  if (id) void openSeilink(id, 'tour');
}

export function seilinkTourDropped(step: TourStepName): void {
  track('dropped', { step });
  updateTourRecord(retired);
  useTutorialStore.getState().end();
}
