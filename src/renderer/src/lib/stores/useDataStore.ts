/**
 * Data store — characters, LAN state, summon (bot status), logs ring buffer.
 *
 * Per 04-RESEARCH.md §Resolved Q5: subscriptions to onLog/onStatus/onLan are
 * mounted at the STORE level (App.tsx calls subscribeIpc() once); navigation
 * MUST NOT drop log lines (D-53 buffer cap = 5000).
 *
 * Per Pitfall 7 — main coalesces log batches; renderer just appends and
 * trims the ring buffer with `slice(-MAX_LOG_LINES)`.
 *
 * Source: 04-CONTEXT.md D-22 (LanState), D-53 (5000-line cap),
 *         04-PATTERNS.md §useDataStore, 04-RESEARCH.md §Code Examples 6.
 */

import { create } from 'zustand';
import type { Character } from '@shared/characterSchema';
import type { BotStatus, LanState, LogEntry, LogBatch } from '@shared/ipc';
import { sei } from '../ipcClient';
import { useUiStore } from './useUiStore';

const MAX_LOG_LINES = 5000;

interface DataState {
  characters: Character[];
  lan: LanState;
  /**
   * Per-character bot status, keyed by characterId (multi-summon). An absent
   * key means "not summoned" (idle); a present entry is connecting/online/error.
   * Components that care about one character read `summons[id]`; "is any bot
   * running" reads `Object.values(summons)`.
   */
  summons: Record<string, BotStatus>;
  logs: LogEntry[];
  /** Cumulative count of dropped lines (Pitfall-7 backpressure sentinel). */
  dropped: number;

  /**
   * Session-local set of ids that the user just deleted. HomeGrid's
   * cloud-only placeholder list (the gray CLOUD card) is built from
   * chars:list-merged, which reads the cloud row directly. When the user
   * deletes a self-owned char, the cloud delete is enqueued fire-and-forget;
   * until it drains, the cloud row still exists and the placeholder would
   * pop back as "CLOUD". This set lets the grid suppress that flash so the
   * delete feels immediate. Cleared on auth state change / app restart.
   */
  recentlyDeletedIds: Set<string>;
  loadCharacters: () => Promise<void>;
  refreshCharacter: (id: string) => Promise<void>;
  addCharacter: (c: Character) => void;
  updateCharacter: (c: Character) => void;
  removeCharacter: (id: string) => void;

  setLan: (state: LanState) => void;
  /** Route a single status push into the per-character map (idle clears the key). */
  setStatus: (status: BotStatus) => void;

  appendLogBatch: (batch: LogBatch) => void;
  clearLogs: () => void;
}

export const useDataStore = create<DataState>((set) => ({
  characters: [],
  recentlyDeletedIds: new Set<string>(),
  lan: { kind: 'not_connected' },
  summons: {},
  logs: [],
  dropped: 0,

  loadCharacters: async () => {
    const list = await sei.listCharacters();
    set({ characters: list });
  },

  refreshCharacter: async (id) => {
    // Hard guard: chars:get validates its input as a non-optional string, so a
    // falsy id (a status push that predates the multi-summon characterId field,
    // or an undefined route param) would reject with a Zod "Required" error and
    // surface as an uncaught promise rejection. There is nothing to refresh for
    // an empty id, so bail before crossing the IPC boundary.
    if (!id) return;
    const c = await sei.getCharacter(id);
    if (!c) {
      set((s) => ({ characters: s.characters.filter((x) => x.id !== id) }));
      return;
    }
    set((s) => ({
      characters: s.characters.some((x) => x.id === id)
        ? s.characters.map((x) => (x.id === id ? c : x))
        : [...s.characters, c],
    }));
  },

  addCharacter: (c) => set((s) => ({ characters: [...s.characters, c] })),
  updateCharacter: (c) =>
    set((s) => ({ characters: s.characters.map((x) => (x.id === c.id ? c : x)) })),
  removeCharacter: (id) =>
    set((s) => {
      const next = new Set(s.recentlyDeletedIds);
      next.add(id);
      return {
        characters: s.characters.filter((x) => x.id !== id),
        recentlyDeletedIds: next,
      };
    }),

  setLan: (state) => set({ lan: state }),
  setStatus: (status) =>
    set((s) => {
      // Defend the map key: a malformed/legacy status without a characterId
      // must not land under an `"undefined"` key (which would then route to a
      // ghost character everywhere `summons[id]` is read). Ignore it.
      if (!status.characterId) return {};
      const next = { ...s.summons };
      // 'idle' means this character's session ended → drop the key so
      // `summons[id]` reads undefined (not summoned). Everything else upserts.
      if (status.kind === 'idle') delete next[status.characterId];
      else next[status.characterId] = status;
      return { summons: next };
    }),

  appendLogBatch: (batch) =>
    set((s) => {
      const next = s.logs.concat(batch.entries);
      const trimmed = next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
      return {
        logs: trimmed,
        dropped: s.dropped + (batch.dropped ?? 0),
      };
    }),

  clearLogs: () => set({ logs: [], dropped: 0 }),
}));

/**
 * Wire push subscriptions from preload into the data store.
 * Called once at App.tsx mount; returns a teardown function.
 *
 * Per RESEARCH §Resolved Q5: subscriptions live at the STORE level, not inside
 * individual screen components. Navigation cannot drop log lines.
 */
export function subscribeIpc(): () => void {
  const offLan = sei.onLan((state) => useDataStore.getState().setLan(state));
  // Seed the LAN state once the listener is attached. The onLan push only
  // fires on CHANGE, so on a (re)load while a world is already open the store
  // would otherwise sit at its initial 'not_connected' until the next change.
  // Pulling the snapshot here (not relying on a replay-push that races this
  // subscription) fixes "open world → connected → reload → not connected".
  void sei
    .getLanState()
    .then((state) => useDataStore.getState().setLan(state))
    .catch(() => {
      /* leave initial state; a subsequent push will correct it */
    });
  const offStatus = sei.onStatus((status) => {
    // Clear the console when the FIRST bot starts connecting (no other session
    // already live). This preserves single-summon behavior — a fresh session
    // gets a clean console — while a SECOND concurrent summon must not wipe the
    // logs of a bot that's already running.
    if (status.kind === 'connecting') {
      const others = useDataStore.getState().summons;
      const anyOther = Object.entries(others).some(
        ([cid, st]) =>
          cid !== status.characterId && (st.kind === 'connecting' || st.kind === 'online'),
      );
      if (!anyOther) useDataStore.getState().clearLogs();
    }
    // When a session ends (idle), pull the character's freshly-written
    // last_launched / playtime_ms. Main defers emitting 'idle' until the
    // exit-time playtime write lands, so this reads the updated totals — and
    // every status now carries characterId, so no separate tracking is needed.
    if (status.kind === 'idle' && status.characterId) {
      void useDataStore.getState().refreshCharacter(status.characterId);
    }
    useDataStore.getState().setStatus(status);
  });
  const offLog = sei.onLog((batch) => useDataStore.getState().appendLogBatch(batch));
  // Phase 15 (D-10/VIS-03): mirror the active provider's vision capability into
  // useUiStore so the Settings auto-render toggle (15-05) gates its disabled
  // state on a real signal. The bot emits this on summon-ready and on each
  // backend switch; subscribed here alongside the other store-level bot pushes
  // (one subscription for the lifetime of the renderer — App.tsx calls
  // subscribeIpc once). Fail-closed default (false) lives in useUiStore.
  const offVisionCapability = sei.onVisionCapability((cap) => {
    useUiStore.getState().setVisionCapable(cap.visionCapable === true);
  });
  return () => {
    offLan();
    offStatus();
    offLog();
    offVisionCapability();
  };
}
