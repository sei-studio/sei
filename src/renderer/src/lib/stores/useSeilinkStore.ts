/**
 * SeiLink in the main window (261104, M4): is it on, who moved in, and the
 * dock's "edit room" request. Main owns all of it; this mirrors the pushes
 * (seilink:availability-changed, seilink:host-status-changed) so the
 * companion page, the move-in sheet and Settings read one copy.
 *
 * `init()` runs once from App.tsx. After an account switch main restores the
 * new profile's move-in and pushes both again; `refresh()` re-reads them.
 */
import { create } from 'zustand';
import { SEILINK_HOST_OFF, type SeilinkAvailability, type SeilinkHostStatus } from '@shared/seilinkHost';
import { sei } from '../ipcClient';

interface SeilinkStoreState {
  availability: SeilinkAvailability | null;
  status: SeilinkHostStatus;
  /** The dock asked to edit this companion's room; her page opens the editor and clears it. */
  pendingEditor: string | null;
  init: () => () => void;
  refresh: () => void;
  requestEditor: (characterId: string) => void;
  clearEditor: () => void;
}

export const useSeilinkStore = create<SeilinkStoreState>((set) => ({
  availability: null,
  status: { ...SEILINK_HOST_OFF },
  pendingEditor: null,
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
  requestEditor: (characterId) => set({ pendingEditor: characterId }),
  clearEditor: () => set({ pendingEditor: null }),
}));

/** The companion who moved in, while the host is up or coming up (null when off or failed). */
export function movedInId(status: SeilinkHostStatus): string | null {
  return status.state === 'starting' || status.state === 'running' || status.state === 'restarting' ? status.characterId : null;
}
