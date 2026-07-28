/**
 * Backseat store (260728).
 *
 * Deliberately thin. Backseat's real UI lives in a separate always-on-top
 * window that owns its own state, so the app-side store exists only to answer
 * one question for the rest of the app: does this character have a live
 * backseat session? That is what the cross-launch gate (lib/gameLaunch) and the
 * IconRail activity badge need, and nothing else in the app needs more.
 *
 * The main window never sees the overlay's state pushes (those go to the
 * overlay), so this tracks the sessions it started and clears them when the
 * session's play row lands in chat or a launch gate ends it.
 */

import { create } from 'zustand';
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

export const useBackseatStore = create<BackseatStore>((set) => ({
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
}));
