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
 */
import { create } from 'zustand';
import { SEILINK_HOST_OFF, type SeilinkAvailability, type SeilinkHostStatus } from '@shared/seilinkHost';
import type { EditorOpenedFrom, MoveInReason } from '@shared/seilinkTelemetry';
import type { IntroTrigger, SeilinkEntrySource } from '@shared/seilinkIntroTelemetry';
import { sei } from '../ipcClient';

export type SeilinkFlow =
  | { kind: 'sheet'; characterId: string; reason: MoveInReason; entry: SeilinkEntrySource }
  | { kind: 'editor'; characterId: string; openedFrom: EditorOpenedFrom };

/** The first-link intro to play. `outcome` settles true when she is on the desktop, false when the start failed. */
export interface SeilinkIntroRequest {
  /** Bumps with each request, so a replay of the same companion is a new play. */
  seq: number;
  characterId: string;
  trigger: IntroTrigger;
  entry: SeilinkEntrySource;
  outcome: Promise<boolean>;
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
  /** The dock's edit button: her room editor. */
  requestEditor: (characterId: string) => void;
  openFlow: (flow: SeilinkFlow) => void;
  closeFlow: () => void;
  setMoveBusy: (busy: boolean) => void;
  playIntro: (req: Omit<SeilinkIntroRequest, 'seq'>) => void;
  endIntro: (seq: number) => void;
}

let introSeq = 0;

export const useSeilinkStore = create<SeilinkStoreState>((set) => ({
  availability: null,
  status: { ...SEILINK_HOST_OFF },
  flow: null,
  moveBusy: false,
  intro: null,
  init: () => {
    const offs = [
      sei.onSeilinkAvailability?.((a) => set({ availability: a })) ?? (() => {}),
      sei.onSeilinkHostStatus?.((status) => set({ status })) ?? (() => {}),
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
  requestEditor: (characterId) => set({ flow: { kind: 'editor', characterId, openedFrom: 'dock' } }),
  openFlow: (flow) => set({ flow }),
  closeFlow: () => set({ flow: null }),
  setMoveBusy: (moveBusy) => set({ moveBusy }),
  playIntro: (req) => set({ intro: { ...req, seq: ++introSeq } }),
  endIntro: (seq) => set((s) => (s.intro?.seq === seq ? { intro: null } : s)),
}));

/** The companion who moved in, while the host is up or coming up (null when off or failed). */
export function movedInId(status: SeilinkHostStatus): string | null {
  return status.state === 'starting' || status.state === 'running' || status.state === 'restarting' ? status.characterId : null;
}
