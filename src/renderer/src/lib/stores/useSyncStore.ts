/**
 * useSyncStore — renderer-side mirror of main's cloud-sync queue state.
 *
 * The user-visible surface of D-18 (mirror-cloud-immediately): every cloud-backed
 * character card watches `pendingByUuid[character.id]` to render the inline sync
 * pill ('SYNCING' / 'SYNC FAILED — RETRY' / no pill when synced). See
 * CharacterCard.tsx for the rendering contract.
 *
 * Boot wiring (App.tsx mount): `useSyncStore.getState().init()` is fire-and-forget;
 * it subscribes once to `sei.onSyncStatusUpdate` (Plan 11-09 push channel) and
 * seeds the store via `sei.syncStatus()`. The subscription stays alive for the
 * lifetime of the renderer process — App.tsx never unmounts in practice, and a
 * single global init mirrors useDataStore's subscribeIpc pattern.
 *
 * Source: 11-CONTEXT §sync pill (specifics — disappears once synced; no badge
 * for defaults), Plan 11-09 SUMMARY (IPC surface: sync:status, sync:retry,
 * sync:status:update), Plan 11-16 must_haves.
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';

interface SyncState {
  /** Total number of in-flight + failed ops across all characters. */
  pending: number;
  /**
   * Per-character status. Keyed by character.id (UUID). Value is the slim
   * tri-state from SyncStatusPushEvent: 'syncing' | 'failed' | undefined
   * (the 'undefined' case is "no entry in the map" — synced or never queued).
   * 'failed' wins over 'syncing' in main when both somehow coexist.
   */
  pendingByUuid: Record<string, 'syncing' | 'failed'>;
  initialized: boolean;
  unsubscribe?: () => void;
}

interface SyncActions {
  /**
   * Idempotent boot wiring. Subscribes to onSyncStatusUpdate then refreshes
   * via syncStatus() to seed the store. Safe to call multiple times — the
   * `initialized` flag short-circuits subsequent calls.
   */
  init: () => Promise<void>;
  /**
   * Pull a fresh snapshot from main and overwrite local state. Used by `init`
   * for the initial seed and by `retry` to immediately reflect the
   * cleared-failure → in-flight transition for snappy UI.
   */
  refresh: () => Promise<void>;
  /**
   * Force a retry of a single failed op. Calls sei.syncRetry then refreshes
   * the snapshot so the pill flips warn→pulse without waiting on the next
   * push from main.
   */
  retry: (uuid: string) => Promise<void>;
  /**
   * Selector helper — O(1) lookup of a character's sync status. Used by
   * CharacterCard with shallow equality so unrelated characters don't
   * re-render on a sibling's status change.
   */
  getStatus: (uuid: string) => 'syncing' | 'failed' | undefined;
}

export const useSyncStore = create<SyncState & SyncActions>((set, get) => ({
  pending: 0,
  pendingByUuid: {},
  initialized: false,

  init: async (): Promise<void> => {
    if (get().initialized) return;
    // LR-05 — subscribe FIRST so we don't miss pushes that fire during the
    // refresh handshake, then await the initial seed. To avoid the
    // "newer push lands, older refresh snapshot overwrites" race, the push
    // handler bumps `pushSeq`; the seed below captures pre-await pushSeq and
    // skips its `set` if any push arrived during the await (their snapshot
    // is newer than ours by definition).
    let pushSeq = 0;
    const unsubscribe = sei.onSyncStatusUpdate((status) => {
      pushSeq += 1;
      set({ pending: status.pending, pendingByUuid: status.pendingByUuid });
    });
    set({ unsubscribe, initialized: true });
    const seqBefore = pushSeq;
    try {
      const s = await sei.syncStatus();
      // Only apply the initial seed if no push arrived during the await —
      // otherwise we'd overwrite the strictly-newer push state with an older
      // snapshot.
      if (pushSeq === seqBefore) {
        set({ pending: s.pending, pendingByUuid: s.pendingByUuid });
      }
    } catch {
      // Same fallback as refresh: pill defaults to no-pill on transient IPC
      // failure; the next push or manual refresh re-populates.
    }
  },

  refresh: async (): Promise<void> => {
    try {
      const s = await sei.syncStatus();
      set({ pending: s.pending, pendingByUuid: s.pendingByUuid });
    } catch {
      // Swallow — the pill defaults to no-pill when pendingByUuid is empty,
      // which is the safest fallback for a transient IPC error. The next
      // status:update push (or a manual retry) will re-populate.
    }
  },

  retry: async (uuid: string): Promise<void> => {
    await sei.syncRetry(uuid);
    await get().refresh();
  },

  getStatus: (uuid: string): 'syncing' | 'failed' | undefined =>
    get().pendingByUuid[uuid],
}));
