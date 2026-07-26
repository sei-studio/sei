/**
 * useNoticesStore — the notices inbox (260725).
 *
 * Two entry points share this state, which is why it's a store and not local
 * component state:
 *   - App.tsx subscribes once at mount, and lets main's snapshot decide whether
 *     the inbox should open ITSELF (a notice arriving for the first time).
 *   - Playtime → "Inbox" reopens it on demand, and shows the unread count.
 *
 * Main owns the durable half (which notices exist, which were announced, which
 * were read); this store is a thin mirror plus the selection cursor. Every
 * mutation round-trips through IPC and re-seeds from the returned snapshot, so
 * the disk state and the UI can't drift.
 */

import { create } from 'zustand';
import type { Notice, NoticesSnapshot } from '@shared/ipc';
import { sei } from '../ipcClient';

interface NoticesStore {
  notices: Notice[];
  readIds: string[];
  /** Inbox modal visibility. */
  open: boolean;
  /** Currently-selected notice id (right pane), or null when the feed is empty. */
  selectedId: string | null;
  /** Number of cached notices the user has not opened. */
  unreadCount: () => number;
  /**
   * Subscribe to main's pushes and pull the current snapshot. Call once from
   * App.tsx; returns the unsubscribe.
   */
  init: () => () => void;
  /** Open the inbox from a user action (Playtime → Inbox). */
  openInbox: () => void;
  close: () => void;
  /** Select a notice in the left column and mark it read. */
  select: (id: string) => void;
}

/** Newest unread, else the newest notice, else null. */
function firstToShow(notices: Notice[], readIds: string[]): string | null {
  const unread = notices.find((n) => !readIds.includes(n.id));
  return unread?.id ?? notices[0]?.id ?? null;
}

export const useNoticesStore = create<NoticesStore>((set, get) => ({
  notices: [],
  readIds: [],
  open: false,
  selectedId: null,

  unreadCount: () => {
    const { notices, readIds } = get();
    return notices.filter((n) => !readIds.includes(n.id)).length;
  },

  init: () => {
    /**
     * Apply a snapshot. When main says `autoOpen`, at least one notice has never
     * been announced: open the inbox on the newest unread and ack, so this
     * happens exactly once per notice. An inbox the user already has open just
     * absorbs the new entries.
     */
    const apply = (snapshot: NoticesSnapshot): void => {
      const { notices, readIds, autoOpen } = snapshot;
      const prev = get();
      // On an auto-open the newest unread is what the user is being shown the
      // inbox FOR, so it wins over a stale cursor left by an earlier visit.
      // Otherwise keep the current selection, unless its notice was retracted.
      const kept = prev.selectedId && notices.some((n) => n.id === prev.selectedId)
        ? prev.selectedId
        : null;
      const selectedId = autoOpen ? firstToShow(notices, readIds) : kept;
      set({ notices, readIds, open: prev.open || autoOpen, selectedId });
      if (autoOpen) {
        // Ack first (stops any repeat open), then mark the shown one read.
        void sei
          .ackNotices()
          .then((s) => set({ notices: s.notices, readIds: s.readIds }))
          .catch(() => undefined);
        if (selectedId) get().select(selectedId);
      }
    };

    const unsub = sei.onNotices(apply);
    // Race-proof pull: the startup refresh can land before this listener
    // exists, and `autoOpen` is derived from persisted state, so the dropped
    // push and this pull carry the same answer.
    void sei.getNotices().then(apply).catch(() => undefined);
    return unsub;
  },

  openInbox: () => {
    const { notices, readIds, selectedId } = get();
    const next = selectedId && notices.some((n) => n.id === selectedId)
      ? selectedId
      : firstToShow(notices, readIds);
    set({ open: true, selectedId: next });
    if (next) get().select(next);
  },

  close: () => set({ open: false }),

  select: (id: string) => {
    set({ selectedId: id });
    if (get().readIds.includes(id)) return;
    void sei
      .markNoticeRead(id)
      .then((s) => set({ notices: s.notices, readIds: s.readIds }))
      .catch(() => undefined);
  },
}));
