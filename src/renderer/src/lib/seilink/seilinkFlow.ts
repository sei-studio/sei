/**
 * The SeiLink entry points, in one place (261105, T337).
 *
 * Every way into SeiLink goes through here: the chat top bar's SeiLink
 * button, the companion page's gear menu ("Move onto desktop" / "Edit room"),
 * the dock's edit button and the guide's SeiLink tour. They open the same
 * move-in sheet and room editor (rendered once by SeilinkFlowHost) and start
 * the host the same way, so the first-link intro plays whichever path made
 * the first move-in.
 *
 *  - openSeilink (the button and the tour): she lives on the desktop -> her
 *    room editor; otherwise move her in (the sheet when it is her first room
 *    or someone else moves out, else straight in).
 *  - moveInOrOut (the gear menu): the old toggle: move her off when she lives
 *    there, else move her in as above.
 *  - startSeilinkHost: every host start. Plays the first-link intro alongside
 *    the start (never before it) the first time on this account.
 *
 * 261106 (first-link flow, v3): she first moves in on a plain background, no
 * room yet (MoveInSheet). The first link plays the intro on the desktop stage
 * and ends on that plain background there; the window steps aside and the
 * dock asks about setting up her room together (the editor's guided setup)
 * (main/seilink/decorateOffer.ts). A first room without the intro (it was
 * seen already) steps aside the same way once she is in. The room editor
 * opens on the desktop for the companion who lives there, from every entry
 * point (the dock, the offer, the SeiLink button, the gear menu).
 */
import type { SeilinkHostStatus, SeilinkOfferVia } from '@shared/seilinkHost';
import { SEILINK_ENTRY_EVENT, type EntryAction, type SeilinkEntrySource } from '@shared/seilinkIntroTelemetry';
import type { EditorOpenedFrom } from '@shared/seilinkTelemetry';
import { sei } from '../ipcClient';
import { movedInId, useSeilinkStore } from '../stores/useSeilinkStore';
import { moveInFailed, needsMoveInSheet } from './moveIn';
import { introSeen, shouldPlayFirstLink } from './introPref';
import { liveHintDismissed } from './liveHintPref';

export function trackEntry(characterId: string, source: SeilinkEntrySource, action: EntryAction): void {
  try {
    sei.track(SEILINK_ENTRY_EVENT, { character_id: characterId, source, action });
  } catch {
    /* analytics must never disrupt SeiLink */
  }
}

function editorFrom(source: SeilinkEntrySource): EditorOpenedFrom {
  return source;
}

/**
 * Start the host for her (the sheet's Move in, or a direct move-in). The
 * first time on this account the intro plays while the host comes up; a
 * failed start ends it early into the caller's error state.
 */
export function startSeilinkHost(
  characterId: string,
  opts: { firstRoom?: boolean; entry: SeilinkEntrySource; /** 261106: she just moved in fresh (a plain background, no room yet). */ fresh?: boolean },
): Promise<SeilinkHostStatus | null> {
  if (!sei.seilinkHostStart) return Promise.resolve(null);
  const start = sei.seilinkHostStart(characterId, opts.firstRoom !== undefined ? { firstRoom: opts.firstRoom } : undefined);
  if (shouldPlayFirstLink({ seen: introSeen() })) {
    useSeilinkStore.getState().playIntro({
      characterId,
      trigger: 'first_link',
      entry: opts.entry,
      outcome: start.then(
        (s) => !moveInFailed(s),
        () => false,
      ),
      stage: true,
    });
  } else if (opts.fresh || !liveHintDismissed()) {
    // No intro: once she is in, step aside so the desktop shows her there, and offer to set up her room together.
    // 261110: until it was dismissed once, the "lives on your desktop" card comes first (SeilinkFlowHost reveals after it).
    void start.then(
      (s) => {
        if (moveInFailed(s)) return;
        if (!liveHintDismissed()) useSeilinkStore.getState().showLiveHint({ characterId, fresh: opts.fresh === true });
        else void revealAndOffer(characterId, 'move_in');
      },
      () => {},
    );
  }
  return start;
}

/** The desktop shows her: the app steps aside (resolves then), and the dock offers to set up (or decorate) her room together. */
export async function revealAndOffer(characterId: string, via: SeilinkOfferVia, opts: { staged?: boolean } = {}): Promise<void> {
  try {
    if (opts.staged) await sei.seilinkStage?.({ action: 'exit', reveal: true });
    else await sei.seilinkStage?.({ action: 'reveal', purpose: via, characterId });
  } catch {
    /* the offer still goes up on the dock */
  }
  // Not awaited: her line can take a few seconds, and the window has already stepped aside.
  void sei.seilinkOffer?.(characterId, via).catch(() => null);
}

/** Her editor opens on the desktop when she lives there and the host is up (a refused stage keeps it in the app). */
function onDesktop(characterId: string): boolean {
  const s = useSeilinkStore.getState();
  return Boolean(s.availability?.enabled) && s.status.state === 'running' && s.status.characterId === characterId;
}

/** "Replay WorldLink intro": the intro for her room, with nothing starting. */
export function replayIntro(characterId: string, source: SeilinkEntrySource): void {
  trackEntry(characterId, source, 'replay_intro');
  useSeilinkStore.getState().playIntro({ characterId, trigger: 'replay', entry: source, outcome: Promise.resolve(true) });
}

export function openRoomEditor(characterId: string, source: SeilinkEntrySource): void {
  trackEntry(characterId, source, 'edit');
  useSeilinkStore.getState().openFlow({ kind: 'editor', characterId, openedFrom: editorFrom(source), desktop: onDesktop(characterId) });
}

async function moveIn(characterId: string, source: SeilinkEntrySource): Promise<void> {
  const store = useSeilinkStore.getState();
  const living = movedInId(store.status);
  const room = await sei.seilinkRoomGet?.(characterId).catch(() => null);
  if (needsMoveInSheet({ saved: room?.saved === true, movedInId: living, characterId })) {
    trackEntry(characterId, source, 'sheet');
    store.openFlow({ kind: 'sheet', characterId, reason: room?.saved === true ? 'swap' : 'first_room', entry: source });
    return;
  }
  trackEntry(characterId, source, 'move_in');
  const status = await startSeilinkHost(characterId, { entry: source }).catch(() => null);
  // A start that did not take opens the sheet, which has the retry and the error line.
  if (!status || moveInFailed(status)) {
    useSeilinkStore.getState().openFlow({ kind: 'sheet', characterId, reason: 'retry', entry: source });
  }
}

/** Run one move at a time (main also queues them). */
async function guarded(fn: () => Promise<void>): Promise<void> {
  const store = useSeilinkStore.getState();
  if (store.moveBusy) return;
  store.setMoveBusy(true);
  try {
    await fn();
  } finally {
    useSeilinkStore.getState().setMoveBusy(false);
  }
}

/** The SeiLink button and the tour: her editor when she lives there, else move her in. */
export function openSeilink(characterId: string, source: SeilinkEntrySource): Promise<void> {
  if (movedInId(useSeilinkStore.getState().status) === characterId) {
    openRoomEditor(characterId, source);
    return Promise.resolve();
  }
  return guarded(() => moveIn(characterId, source));
}

/** The gear menu's "Move onto desktop" / "Move off desktop". */
export function moveInOrOut(characterId: string, source: SeilinkEntrySource): Promise<void> {
  return guarded(async () => {
    if (movedInId(useSeilinkStore.getState().status) === characterId) {
      trackEntry(characterId, source, 'move_out');
      await sei.seilinkHostStop?.().catch(() => null);
      return;
    }
    await moveIn(characterId, source);
  });
}
