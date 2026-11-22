/**
 * useBATTLESHIPStore — per-character Battleship games (renderer
 * mirror). The authoritative game lives in main
 * (src/main/battleship/); this store caches the last pushed
 * BATTLESHIPGameState per character and holds the panel open intent.
 * No engine download — main's AI fire() lands in the state push and the
 * grids render it directly.
 *
 * Contract: src/shared/battleshipIpc.ts. The preload members may not
 * exist yet in this build, so all access goes through ONE narrow cast
 * (BATTLESHIPApi below).
 */

import { create } from 'zustand';
import type { BATTLESHIPGameState } from '@shared/battleshipIpc';
import { t } from '../i18n';

interface BATTLESHIPApi {
  BATTLESHIPStart(
    characterId: string,
    opts?: { playerStarts?: boolean },
  ): Promise<BATTLESHIPGameState>;
  BATTLESHIPGetState(characterId: string): Promise<BATTLESHIPGameState | null>;
  BATTLESHIPMove(
    characterId: string,
    row: number,
    col: number,
  ): Promise<{ ok: boolean; error?: string; state: BATTLESHIPGameState }>;
  BATTLESHIPResign(characterId: string): Promise<BATTLESHIPGameState>;
  BATTLESHIPRematch(characterId: string): Promise<BATTLESHIPGameState>;
  BATTLESHIPEnd(characterId: string): Promise<void>;
  onBATTLESHIPState(cb: (state: BATTLESHIPGameState) => void): () => void;
}

function BATTLESHIPApi(): Partial<BATTLESHIPApi> {
  return window.sei as unknown as Partial<BATTLESHIPApi>;
}

const NOT_AVAILABLE = 'Battleship is not available in this build yet.';

export interface BATTLESHIPStoreState {
  /** characterId → last authoritative snapshot from main. */
  games: Record<string, BATTLESHIPGameState | null>;
  /** Panel open intent BEFORE a game exists (pre-game setup card). */
  panelIntent: Record<string, boolean>;
  /** characterId → BATTLESHIPStart in flight. */
  starting: Record<string, boolean>;
  /** characterId → hydrate (BATTLESHIPGetState) already attempted. */
  hydrated: Record<string, boolean>;

  /** Open the Battleship panel for a character (pre-game card if no game yet). */
  openPanel: (characterId: string) => void;
  /** Fetch any existing game once (resume after navigation / relaunch). */
  hydrate: (characterId: string) => Promise<void>;
  /** Start (or resume) a game. Throws on failure (e.g. Minecraft active). */
  start: (characterId: string, playerStarts?: boolean) => Promise<void>;
  /** Player fire at (row, col). Returns main's verdict; state applies either way. */
  move: (characterId: string, row: number, col: number) => Promise<boolean>;
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

export function isBATTLESHIPOpen(s: BATTLESHIPStoreState, characterId: string): boolean {
  return s.panelIntent[characterId] === true || !!s.games[characterId];
}

export const useBattleshipStore = create<BATTLESHIPStoreState>((set, get) => {
  const applyState = (state: BATTLESHIPGameState): void => {
    set((s) => {
      const prev = s.games[state.characterId];
      if (state.status === 'ended' && !prev && s.panelIntent[state.characterId] !== true) {
        return s;
      }
      return {
        games: { ...s.games, [state.characterId]: state },
      };
    });
  };

  try {
    offState = BATTLESHIPApi().onBATTLESHIPState?.(applyState) ?? null;
  } catch {
    /* preload without the Battleship bridge — pushes just won't stream */
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
      const fn = BATTLESHIPApi().BATTLESHIPGetState;
      if (!fn) return;
      try {
        const state = await fn(characterId);
        if (state) applyState(state);
      } catch {
        set((s) => ({ hydrated: { ...s.hydrated, [characterId]: false } }));
      }
    },

    start: async (characterId, playerStarts) => {
      const fn = BATTLESHIPApi().BATTLESHIPStart;
      if (!fn) throw new Error(t(NOT_AVAILABLE));
      set((s) => ({ starting: { ...s.starting, [characterId]: true } }));
      try {
        const state = await fn(characterId, { playerStarts });
        applyState(state);
        set((s) => ({ starting: { ...s.starting, [characterId]: false } }));
      } catch (err) {
        set((s) => ({ starting: { ...s.starting, [characterId]: false } }));
        throw err;
      }
    },

    move: async (characterId, row, col) => {
      const fn = BATTLESHIPApi().BATTLESHIPMove;
      if (!fn) return false;
      try {
        const res = await fn(characterId, row, col);
        applyState(res.state);
        return res.ok;
      } catch {
        return false;
      }
    },

    resign: async (characterId) => {
      const fn = BATTLESHIPApi().BATTLESHIPResign;
      if (!fn) return;
      try {
        applyState(await fn(characterId));
      } catch {
        /* next push reconciles */
      }
    },

    rematch: async (characterId) => {
      const fn = BATTLESHIPApi().BATTLESHIPRematch;
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
      const fn = BATTLESHIPApi().BATTLESHIPEnd;
      if (!fn) return;
      try {
        await fn(characterId);
      } catch {
        /* already gone in main */
      }
    },

    resetForScope: () =>
      set({ games: {}, panelIntent: {}, starting: {}, hydrated: {} }),
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
