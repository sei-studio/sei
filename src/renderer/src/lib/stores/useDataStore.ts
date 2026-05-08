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

const MAX_LOG_LINES = 5000;

interface DataState {
  characters: Character[];
  lan: LanState;
  summon: BotStatus;
  logs: LogEntry[];
  /** Cumulative count of dropped lines (Pitfall-7 backpressure sentinel). */
  dropped: number;

  loadCharacters: () => Promise<void>;
  refreshCharacter: (id: string) => Promise<void>;
  addCharacter: (c: Character) => void;
  updateCharacter: (c: Character) => void;
  removeCharacter: (id: string) => void;

  setLan: (state: LanState) => void;
  setStatus: (status: BotStatus) => void;

  appendLogBatch: (batch: LogBatch) => void;
  clearLogs: () => void;
}

export const useDataStore = create<DataState>((set) => ({
  characters: [],
  lan: { kind: 'not_connected' },
  summon: { kind: 'idle' },
  logs: [],
  dropped: 0,

  loadCharacters: async () => {
    const list = await sei.listCharacters();
    set({ characters: list });
  },

  refreshCharacter: async (id) => {
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
    set((s) => ({ characters: s.characters.filter((x) => x.id !== id) })),

  setLan: (state) => set({ lan: state }),
  setStatus: (status) => set({ summon: status }),

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
  const offStatus = sei.onStatus((status) => useDataStore.getState().setStatus(status));
  const offLog = sei.onLog((batch) => useDataStore.getState().appendLogBatch(batch));
  return () => {
    offLan();
    offStatus();
    offLog();
  };
}
