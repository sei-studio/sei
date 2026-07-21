/**
 * useTwentyQStore — per-character 20 Questions sessions (renderer mirror).
 *
 * CLONED from useConnect4Store and simplified: no board, no pendingAiMove
 * reveal/ack machinery (the party-tier game has no presentation hold). The
 * authoritative session lives in main (src/main/twentyq/); this store caches
 * the last pushed TQGameState per character for the status-card panel.
 *
 * Contract: src/shared/twentyqIpc.ts. The preload members may not exist yet
 * in this build, so all access goes through ONE narrow cast (tqApi below).
 */

import { create } from 'zustand';
import type { TQGameState, TQMode } from '@shared/twentyqIpc';

/**
 * Narrow local view of the twentyq members on window.sei — matches the doc
 * comment in src/shared/twentyqIpc.ts exactly. Single cast point by design.
 */
interface TwentyQApi {
  twentyqStart(characterId: string, opts?: { mode?: TQMode }): Promise<TQGameState>;
  twentyqGetState(characterId: string): Promise<TQGameState | null>;
  twentyqNewRound(characterId: string): Promise<TQGameState>;
  twentyqEnd(characterId: string): Promise<void>;
  onTwentyQState(cb: (state: TQGameState) => void): () => void;
}

function tqApi(): Partial<TwentyQApi> {
  return window.sei as unknown as Partial<TwentyQApi>;
}

const NOT_AVAILABLE = '20 Questions is not available in this build yet.';

interface TwentyQStoreState {
  /** characterId → last authoritative snapshot from main. */
  games: Record<string, TQGameState | null>;
  /** Panel open intent BEFORE a session exists (pre-game setup card). */
  panelIntent: Record<string, boolean>;
  /** characterId → twentyqStart in flight. */
  starting: Record<string, boolean>;
  /** characterId → hydrate (twentyqGetState) already attempted. */
  hydrated: Record<string, boolean>;

  /** Open the panel for a character (pre-game card if no session yet). */
  openPanel: (characterId: string) => void;
  /** Fetch any existing session once (resume after navigation / relaunch). */
  hydrate: (characterId: string) => Promise<void>;
  /** Start (or resume) a session. Throws on failure so the panel can branch:
   * TWENTYQ_MC_SESSION_ACTIVE rejections open the disconnect confirm. */
  start: (characterId: string, mode: TQMode) => Promise<void>;
  /** Start the next round after one ends (same mode, score carries over). */
  newRound: (characterId: string) => Promise<void>;
  /** Close the panel. Ends the session in main (a live round → 'abandoned'). */
  end: (characterId: string) => Promise<void>;
}

/** Push unsubscriber, torn down on HMR dispose (same pattern as useChessStore:
 * a stale hot-reloaded instance would double-handle every push). */
let offState: (() => void) | null = null;

/** The chat screen's game aside is open when there is intent OR a session. */
export function isTwentyQOpen(s: TwentyQStoreState, characterId: string): boolean {
  return s.panelIntent[characterId] === true || !!s.games[characterId];
}

export const useTwentyQStore = create<TwentyQStoreState>((set, get) => {
  const applyState = (state: TQGameState): void => {
    set((s) => ({ games: { ...s.games, [state.characterId]: state } }));
  };

  try {
    offState = tqApi().onTwentyQState?.(applyState) ?? null;
  } catch {
    /* preload without the twentyq bridge — pushes just won't stream */
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
      const fn = tqApi().twentyqGetState;
      if (!fn) return;
      try {
        const state = await fn(characterId);
        if (state) applyState(state);
      } catch {
        // Allow a later open to retry.
        set((s) => ({ hydrated: { ...s.hydrated, [characterId]: false } }));
      }
    },

    start: async (characterId, mode) => {
      const fn = tqApi().twentyqStart;
      if (!fn) throw new Error(NOT_AVAILABLE);
      set((s) => ({ starting: { ...s.starting, [characterId]: true } }));
      try {
        const state = await fn(characterId, { mode });
        applyState(state);
        set((s) => ({ starting: { ...s.starting, [characterId]: false } }));
      } catch (err) {
        set((s) => ({ starting: { ...s.starting, [characterId]: false } }));
        throw err;
      }
    },

    newRound: async (characterId) => {
      const fn = tqApi().twentyqNewRound;
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
      const fn = tqApi().twentyqEnd;
      if (!fn) return;
      try {
        await fn(characterId);
      } catch {
        /* already gone in main */
      }
    },
  };
});

// Dev-only (Vite HMR): drop the stale instance's push listener before the
// re-executed module registers a fresh one (same hazard as useChatStore's).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offState?.();
    offState = null;
  });
}
