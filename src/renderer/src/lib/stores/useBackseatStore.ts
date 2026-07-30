/**
 * Backseat store (260728).
 *
 * Deliberately thin. Backseat's real UI lives in a separate always-on-top
 * window that owns its own state, so the app-side store exists only to answer
 * one question for the rest of the app: does this character have a live
 * backseat session? That is what the cross-launch gate (lib/gameLaunch) and the
 * IconRail activity badge need, and nothing else in the app needs more.
 *
 * State pushes go to BOTH windows (260728): main mirrors every BackseatState
 * push here as well as to the overlay, precisely so the 'ended' push from the
 * overlay's own stop button clears this map. Before that, stopping from the
 * overlay left the IconRail badge lit until an unrelated launch gate or reload
 * happened to reconcile it.
 */

import { create } from 'zustand';
import type { BackseatState } from '../../../../shared/backseatIpc';
import { sei } from '../ipcClient';

interface BackseatStore {
  /** characterId -> true while a session is live. */
  active: Record<string, boolean>;
  /** Mark a session started (called right after backseatStart resolves). */
  markStarted: (characterId: string) => void;
  /** End a live session (the cross-launch gate's end path). */
  end: (characterId: string) => Promise<void>;
  /** Reconcile against main, e.g. after a reload. */
  refresh: (characterId: string) => Promise<void>;
}

/** Push unsubscriber, torn down on HMR dispose (see useChessStore). */
let offState: (() => void) | null = null;

export const useBackseatStore = create<BackseatStore>((set) => {
  try {
    offState =
      sei.onBackseatState?.((s: BackseatState) => {
        set((st) => {
          const next = { ...st.active };
          if (s.phase === 'ended') delete next[s.characterId];
          else next[s.characterId] = true;
          return { active: next };
        });
      }) ?? null;
  } catch {
    /* preload without the backseat bridge — refresh() still reconciles */
  }

  return {
    active: {},

    markStarted: (characterId) =>
      set((s) => ({ active: { ...s.active, [characterId]: true } })),

    end: async (characterId) => {
      set((s) => {
        const next = { ...s.active };
        delete next[characterId];
        return { active: next };
      });
      try {
        await sei.backseatEnd(characterId);
      } catch {
        /* already ended */
      }
    },

    refresh: async (characterId) => {
      let live = false;
      try {
        const state = await sei.backseatGetState(characterId);
        live = !!state && state.phase !== 'ended';
      } catch {
        live = false;
      }
      set((s) => {
        const next = { ...s.active };
        if (live) next[characterId] = true;
        else delete next[characterId];
        return { active: next };
      });
    },
  };
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offState?.();
    offState = null;
  });
}
