/**
 * useConnect4Store — per-character Connect 4 games (renderer mirror).
 *
 * The authoritative game lives in main (src/main/connect4/); this store caches
 * the last pushed CONNECT4GameState per character and holds the panel open
 * intent. No engine download, no reveal animation — main's AI pick lands in
 * the state push and the board renders it directly.
 *
 * Contract: src/shared/connect4Ipc.ts. The preload members may not exist yet in
 * this build, so all access goes through ONE narrow cast (connect4Api below).
 */

import { create } from 'zustand';
import type { CONNECT4GameState } from '@shared/connect4Ipc';
import { t } from '../i18n';

interface ForzaApi {
  CONNECT4Start(
    characterId: string,
    opts?: { playerColor?: 'r' | 'y' | 'random' },
  ): Promise<CONNECT4GameState>;
  CONNECT4GetState(characterId: string): Promise<CONNECT4GameState | null>;
  CONNECT4Move(
    characterId: string,
    column: number,
  ): Promise<{ ok: boolean; error?: string; state: CONNECT4GameState }>;
  CONNECT4Resign(characterId: string): Promise<CONNECT4GameState>;
  CONNECT4Rematch(characterId: string): Promise<CONNECT4GameState>;
  CONNECT4End(characterId: string): Promise<void>;
  onCONNECT4State(cb: (state: CONNECT4GameState) => void): () => void;
}

function connect4Api(): Partial<ForzaApi> {
  return window.sei as unknown as Partial<ForzaApi>;
}

const NOT_AVAILABLE = 'Forza 4 is not available in this build yet.';

export interface ForzaStoreState {
  /** characterId → last authoritative snapshot from main. */
  games: Record<string, CONNECT4GameState | null>;
  /** Panel open intent BEFORE a game exists (pre-game setup card). */
  panelIntent: Record<string, boolean>;
  /** characterId → CONNECT4Start in flight. */
  starting: Record<string, boolean>;
  /** characterId → hydrate (CONNECT4GetState) already attempted. */
  hydrated: Record<string, boolean>;

  /** Open the Forza 4 panel for a character (pre-game card if no game yet). */
  openPanel: (characterId: string) => void;
  /** Fetch any existing game once (resume after navigation / relaunch). */
  hydrate: (characterId: string) => Promise<void>;
  /** Start (or resume) a game. Throws on failure (e.g. Minecraft active). */
  start: (characterId: string, playerColor?: 'r' | 'y' | 'random') => Promise<void>;
  /** Player drop in a column. Returns main's verdict; state applies either way. */
  move: (characterId: string, column: number) => Promise<boolean>;
  resign: (characterId: string) => Promise<void>;
  rematch: (characterId: string) => Promise<void>;
  /** Close the panel. Ends any game in main (unfinished → 'abandoned'). */
  end: (characterId: string) => Promise<void>;
  /**
   * Account switch (260926): forget every game and open panel without calling
   * main, which already ended the games for the outgoing account.
   */
  resetForScope: () => void;
}

/** Push unsubscribers, torn down on HMR dispose. */
let offState: (() => void) | null = null;

export function isCONNECT4Open(s: ForzaStoreState, characterId: string): boolean {
  return s.panelIntent[characterId] === true || !!s.games[characterId];
}

export const useConnect4Store = create<ForzaStoreState>((set, get) => {
  const applyState = (state: CONNECT4GameState): void => {
    set((s) => {
      const prev = s.games[state.characterId];
      // Ended-state pushes with no local game and no open intent: drop them so
      // a dismissed panel doesn't resurrect just to show the result screen.
      if (state.status === 'ended' && !prev && s.panelIntent[state.characterId] !== true) {
        return s;
      }
      return {
        games: { ...s.games, [state.characterId]: state },
      };
    });
  };

  try {
    offState = connect4Api().onCONNECT4State?.(applyState) ?? null;
  } catch {
    /* preload without the CONNECT4 bridge — pushes just won't stream */
  }

  return {
    games: {},
    panelIntent: {},
    starting: {},
    hydrated: {},

    openPanel: (characterId) => {
      set((s) => ({ panelIntent: { ...s.panelIntent, [characterId]: true } }));
      void get().hydrate(characterId);
    },

    hydrate: async (characterId) => {
      if (get().hydrated[characterId]) return;
      set((s) => ({ hydrated: { ...s.hydrated, [characterId]: true } }));
      const fn = connect4Api().CONNECT4GetState;
      if (!fn) return;
      try {
        const state = await fn(characterId);
        if (state) applyState(state);
      } catch {
        set((s) => ({ hydrated: { ...s.hydrated, [characterId]: false } }));
      }
    },

    start: async (characterId, playerColor) => {
      const fn = connect4Api().CONNECT4Start;
      if (!fn) throw new Error(t(NOT_AVAILABLE));
      set((s) => ({ starting: { ...s.starting, [characterId]: true } }));
      try {
        const state = await fn(characterId, { playerColor });
        applyState(state);
        set((s) => ({ starting: { ...s.starting, [characterId]: false } }));
      } catch (err) {
        set((s) => ({ starting: { ...s.starting, [characterId]: false } }));
        throw err;
      }
    },

    move: async (characterId, column) => {
      const fn = connect4Api().CONNECT4Move;
      if (!fn) return false;
      try {
        const res = await fn(characterId, column);
        applyState(res.state);
        return res.ok;
      } catch {
        return false;
      }
    },

    resign: async (characterId) => {
      const fn = connect4Api().CONNECT4Resign;
      if (!fn) return;
      try {
        applyState(await fn(characterId));
      } catch {
        /* next push reconciles */
      }
    },

    rematch: async (characterId) => {
      const fn = connect4Api().CONNECT4Rematch;
      if (!fn) return;
      try {
        applyState(await fn(characterId));
      } catch {
        /* next push reconciles */
      }
    },

    end: async (characterId) => {
      set((s) => ({
        panelIntent: { ...s.panelIntent, [characterId]: false },
        games: { ...s.games, [characterId]: null },
        hydrated: { ...s.hydrated, [characterId]: false },
      }));
      const fn = connect4Api().CONNECT4End;
      if (!fn) return;
      try {
        await fn(characterId);
      } catch {
        /* already gone in main */
      }
    },

    resetForScope: () => set({ games: {}, panelIntent: {}, starting: {}, hydrated: {} }),
  };
});

// Dev-only (Vite HMR): drop the stale instance's push listener before the
// re-executed module registers fresh ones.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offState?.();
    offState = null;
  });
}
