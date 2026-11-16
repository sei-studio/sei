/**
 * SeiLink in the main window (261104, M4): is it on, who moved in, and the
 * dock's "edit room" request. Main owns all of it; this mirrors the pushes
 * (seilink:availability-changed, seilink:host-status-changed) so the
 * companion page, the move-in sheet and Settings read one copy.
 *
 * `init()` runs once from App.tsx. After an account switch main restores the
 * new profile's move-in and pushes both again; `refresh()` re-reads them.
 *
 * 261105 (T337): it also holds the SeiLink FLOW that is open (the move-in
 * sheet or the room editor) and the first-link intro that is playing, so
 * every entry point (the chat top bar's SeiLink button, the companion page's
 * gear menu, the dock, the guide's tour) opens the same surfaces, rendered
 * once by SeilinkFlowHost in App.tsx. lib/seilink/seilinkFlow.ts decides.
 *
 * 261106 (first-link flow): an editor flow with `desktop` opens ON the
 * desktop (the main window steps out over it: main/seilink/desktopStage.ts),
 * and the first-link intro plays there too (`stage`).
 *
 * Product call (261116): `desktopHint`, the one-line "desktop updated" hint
 * (lib/seilink/desktopHint.ts decides; components/seilink/DesktopHint.tsx).
 */
import { create } from 'zustand';
import { SEILINK_HOST_OFF, type SeilinkAvailability, type SeilinkHostStatus, type SeilinkOpenEditor } from '@shared/seilinkHost';
import type { EditorOpenedFrom, MoveInReason } from '@shared/seilinkTelemetry';
import type { IntroTrigger, SeilinkEntrySource } from '@shared/seilinkIntroTelemetry';
import { sei } from '../ipcClient';
import { openedHintFor, updatedHintFor, type DesktopHint } from '../seilink/desktopHint';

export type SeilinkFlow =
  | { kind: 'sheet'; characterId: string; reason: MoveInReason; entry: SeilinkEntrySource }
  | { kind: 'editor'; characterId: string; openedFrom: EditorOpenedFrom; desktop?: boolean };

/** The first-link intro to play. `outcome` settles true when she is on the desktop, false when the start failed. */
export interface SeilinkIntroRequest {
  /** Bumps with each request, so a replay of the same companion is a new play. */
  seq: number;
  characterId: string;
  trigger: IntroTrigger;
  entry: SeilinkEntrySource;
  outcome: Promise<boolean>;
  /** 261106: play it on the desktop stage and end on her room there (the first link). */
  stage?: boolean;
}

interface SeilinkStoreState {
  availability: SeilinkAvailability | null;
  status: SeilinkHostStatus;
  /** The move-in sheet or room editor that is open (one at a time), or null. */
  flow: SeilinkFlow | null;
  /** A move in or out is on its way (a second click waits for it). */
  moveBusy: boolean;
  /** The first-link intro playing now, or null. */
  intro: SeilinkIntroRequest | null;
  init: () => () => void;
  refresh: () => void;
  /** Main's push (the dock's edit button, the offer): her room editor. */
  requestEditor: (req: SeilinkOpenEditor) => void;
  openFlow: (flow: SeilinkFlow) => void;
  closeFlow: () => void;
  setMoveBusy: (busy: boolean) => void;
  playIntro: (req: Omit<SeilinkIntroRequest, 'seq'>) => void;
  endIntro: (seq: number) => void;
  /** 261110: the "lives on your desktop" card in the app (a move-in without the intro), or null. */
  liveHint: SeilinkLiveHint | null;
  showLiveHint: (hint: SeilinkLiveHint) => void;
  endLiveHint: () => void;
  /** 261116: the one-line hint after WorldLink opened or updated the desktop, or null. */
  desktopHint: DesktopHint | null;
  endDesktopHint: (seq: number) => void;
  /** 261116: her room was saved from an editor (the in-app one says "updated" when it closes). */
  noteRoomSaved: (characterId: string) => void;
}

/** 261110: the live card after a move-in without the intro. `fresh`: the window steps aside once it is dismissed. */
export interface SeilinkLiveHint {
  characterId: string;
  fresh: boolean;
}

let introSeq = 0;
let hintSeq = 0;
const startedAt = Date.now();
/** Rooms saved since their editor opened (261116). */
const savedRooms = new Set<string>();

export const useSeilinkStore = create<SeilinkStoreState>((set) => ({
  availability: null,
  status: { ...SEILINK_HOST_OFF },
  flow: null,
  moveBusy: false,
  intro: null,
  liveHint: null,
  desktopHint: null,
  init: () => {
    const offs = [
      sei.onSeilinkAvailability?.((a) => set({ availability: a })) ?? (() => {}),
      sei.onSeilinkHostStatus?.((status) =>
        set((s) => {
          const opened = openedHintFor(s.status, status, {
            sinceStartMs: Date.now() - startedAt,
            intro: s.intro !== null,
            liveCard: s.liveHint !== null,
            desktopEditor: s.flow?.kind === 'editor' && s.flow.desktop === true,
          });
          return opened ? { status, desktopHint: { kind: 'opened', characterId: opened, seq: ++hintSeq, at: Date.now() } } : { status };
        }),
      ) ?? (() => {}),
    ];
    useSeilinkStore.getState().refresh();
    return () => offs.forEach((off) => off());
  },
  refresh: () => {
    void sei.seilinkAvailability?.().then(
      (a) => set({ availability: a }),
      () => {},
    );
    void sei.seilinkHostStatus?.().then(
      (status) => set({ status }),
      () => {},
    );
  },
  requestEditor: (req) => {
    savedRooms.delete(req.characterId);
    set({ flow: { kind: 'editor', characterId: req.characterId, openedFrom: req.openedFrom, desktop: req.desktop } });
  },
  openFlow: (flow) => {
    if (flow.kind === 'editor') savedRooms.delete(flow.characterId);
    set({ flow });
  },
  closeFlow: () =>
    set((s) => {
      const f = s.flow;
      if (f?.kind !== 'editor') return { flow: null };
      const updated = updatedHintFor({ characterId: f.characterId, desktop: f.desktop === true }, savedRooms, movedInId(s.status));
      savedRooms.delete(f.characterId);
      return updated ? { flow: null, desktopHint: { kind: 'updated', characterId: f.characterId, seq: ++hintSeq, at: Date.now() } } : { flow: null };
    }),
  setMoveBusy: (moveBusy) => set({ moveBusy }),
  playIntro: (req) => set({ intro: { ...req, seq: ++introSeq } }),
  endIntro: (seq) => set((s) => (s.intro?.seq === seq ? { intro: null } : s)),
  showLiveHint: (liveHint) => set({ liveHint }),
  endLiveHint: () => set({ liveHint: null }),
  endDesktopHint: (seq) => set((s) => (s.desktopHint?.seq === seq ? { desktopHint: null } : s)),
  noteRoomSaved: (characterId) => {
    savedRooms.add(characterId);
  },
}));

/** The companion who moved in, while the host is up or coming up (null when off or failed). */
export function movedInId(status: SeilinkHostStatus): string | null {
  return status.state === 'starting' || status.state === 'running' || status.state === 'restarting' ? status.characterId : null;
}
