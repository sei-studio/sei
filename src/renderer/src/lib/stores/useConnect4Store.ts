/**
 * useConnect4Store — per-character Connect 4 games (renderer mirror).
 *
 * CLONED from useChessStore minus the chess board UI state (no arrows, flip,
 * promotion picker, or move-list scrubbing; the only local UI is the hovered
 * column, which lives in the board component itself). The authoritative game
 * lives in main (src/main/connect4/); this store caches the last pushed
 * C4GameState per character.
 *
 * AI move reveal: main pushes state with `pendingAiMove` once the character's
 * think delay elapses, but the board must NOT show it until the table has
 * gone quiet (useAiDropReveal's postthink gate decides when). `reveal()`
 * applies the move visually (revealed[characterId] = col, the disc falls)
 * and acks it to main after the drop animation; the next state push commits
 * the board and clears the local overlay. A state push that drops or replaces
 * pendingAiMove (commit, a mid-conversation revision, or a wait() hold-back)
 * always clears `revealed`, so a retracted move never lingers on the board.
 *
 * Contract: src/shared/connect4Ipc.ts. The preload members may not exist yet
 * in this build, so all access goes through ONE narrow cast (c4Api below).
 */

import { create } from 'zustand';
import type { C4GameState } from '@shared/connect4Ipc';

/**
 * Narrow local view of the connect4 members on window.sei — matches the doc
 * comment in src/shared/connect4Ipc.ts exactly. Single cast point by design.
 */
interface Connect4Api {
  connect4Start(
    characterId: string,
    opts?: { playerColor?: 'r' | 'y' | 'random' },
  ): Promise<C4GameState>;
  connect4GetState(characterId: string): Promise<C4GameState | null>;
  connect4Move(
    characterId: string,
    col: number,
  ): Promise<{ ok: boolean; error?: string; state: C4GameState }>;
  connect4Resign(characterId: string): Promise<C4GameState>;
  connect4Rematch(characterId: string): Promise<C4GameState>;
  connect4End(characterId: string): Promise<void>;
  connect4AckReveal(characterId: string, col: number): Promise<C4GameState>;
  onConnect4State(cb: (state: C4GameState) => void): () => void;
}

function c4Api(): Partial<Connect4Api> {
  return window.sei as unknown as Partial<Connect4Api>;
}

const NOT_AVAILABLE = 'Connect 4 is not available in this build yet.';

interface Connect4StoreState {
  /** characterId → last authoritative snapshot from main. */
  games: Record<string, C4GameState | null>;
  /** Panel open intent BEFORE a game exists (pre-game setup card). */
  panelIntent: Record<string, boolean>;
  /** Pending AI drop applied locally after commentary finished (column). */
  revealed: Record<string, number | null>;
  /** characterId → connect4Start in flight. */
  starting: Record<string, boolean>;
  /** characterId → hydrate (connect4GetState) already attempted. */
  hydrated: Record<string, boolean>;

  /** Open the panel for a character (pre-game card if no game yet). */
  openPanel: (characterId: string) => void;
  /** Fetch any existing game once (resume after navigation / relaunch). */
  hydrate: (characterId: string) => Promise<void>;
  /** Start (or resume) a game. Throws on failure so the panel can branch:
   * CONNECT4_MC_SESSION_ACTIVE rejections open the disconnect confirm. */
  start: (characterId: string, playerColor: 'r' | 'y' | 'random') => Promise<void>;
  /** Player drop into a column. Returns main's verdict; state applies either way. */
  move: (characterId: string, col: number) => Promise<boolean>;
  resign: (characterId: string) => Promise<void>;
  rematch: (characterId: string) => Promise<void>;
  /** Close the panel. Ends any game in main (unfinished → 'abandoned'). */
  end: (characterId: string) => Promise<void>;
  /** Apply the pending AI drop visually, then ack it to main after the fall. */
  reveal: (characterId: string, col: number) => void;
}

/** How long the falling-disc animation runs before the ack is sent. Keep in
 * sync with the drop animation duration in Connect4Board.module.css. */
const REVEAL_ANIM_MS = 480;

/** Push unsubscriber, torn down on HMR dispose (same pattern as useChessStore:
 * a stale hot-reloaded instance would double-handle every push). */
let offState: (() => void) | null = null;

/** The chat screen's game aside is open when there is intent OR a game. */
export function isConnect4Open(s: Connect4StoreState, characterId: string): boolean {
  return s.panelIntent[characterId] === true || !!s.games[characterId];
}

export const useConnect4Store = create<Connect4StoreState>((set, get) => {
  const applyState = (state: C4GameState): void => {
    set((s) => {
      const prevRevealed = s.revealed[state.characterId] ?? null;
      // Keep the local reveal overlay ONLY while main still reports the same
      // pending move. Commit and rollback both drop pendingAiMove; a fresh
      // pending move replaces it.
      const keepReveal =
        prevRevealed !== null &&
        state.pendingAiMove !== null &&
        state.pendingAiMove.col === prevRevealed;
      return {
        games: { ...s.games, [state.characterId]: state },
        revealed: { ...s.revealed, [state.characterId]: keepReveal ? prevRevealed : null },
      };
    });
  };

  try {
    offState = c4Api().onConnect4State?.(applyState) ?? null;
  } catch {
    /* preload without the connect4 bridge — pushes just won't stream */
  }

  return {
    games: {},
    panelIntent: {},
    revealed: {},
    starting: {},
    hydrated: {},

    openPanel: (characterId) => {
      set((s) => ({ panelIntent: { ...s.panelIntent, [characterId]: true } }));
      void get().hydrate(characterId);
    },

    hydrate: async (characterId) => {
      if (get().hydrated[characterId]) return;
      set((s) => ({ hydrated: { ...s.hydrated, [characterId]: true } }));
      const fn = c4Api().connect4GetState;
      if (!fn) return;
      try {
        const state = await fn(characterId);
        if (state) applyState(state);
      } catch {
        // Allow a later open to retry.
        set((s) => ({ hydrated: { ...s.hydrated, [characterId]: false } }));
      }
    },

    start: async (characterId, playerColor) => {
      const fn = c4Api().connect4Start;
      if (!fn) throw new Error(NOT_AVAILABLE);
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

    move: async (characterId, col) => {
      const fn = c4Api().connect4Move;
      if (!fn) return false;
      try {
        const res = await fn(characterId, col);
        applyState(res.state);
        return res.ok;
      } catch {
        return false;
      }
    },

    resign: async (characterId) => {
      const fn = c4Api().connect4Resign;
      if (!fn) return;
      try {
        applyState(await fn(characterId));
      } catch {
        /* next push reconciles */
      }
    },

    rematch: async (characterId) => {
      const fn = c4Api().connect4Rematch;
      if (!fn) return;
      try {
        applyState(await fn(characterId));
        set((s) => ({ revealed: { ...s.revealed, [characterId]: null } }));
      } catch {
        /* next push reconciles */
      }
    },

    end: async (characterId) => {
      set((s) => ({
        panelIntent: { ...s.panelIntent, [characterId]: false },
        games: { ...s.games, [characterId]: null },
        revealed: { ...s.revealed, [characterId]: null },
        hydrated: { ...s.hydrated, [characterId]: false },
      }));
      const fn = c4Api().connect4End;
      if (!fn) return;
      try {
        await fn(characterId);
      } catch {
        /* already gone in main */
      }
    },

    reveal: (characterId, col) => {
      const game = get().games[characterId];
      if (!game || game.pendingAiMove?.col !== col) return;
      if (get().revealed[characterId] === col) return;
      set((s) => ({ revealed: { ...s.revealed, [characterId]: col } }));
      window.setTimeout(() => {
        const now = get().games[characterId];
        // Interrupt rollback may have landed during the fall; only ack a move
        // main still considers pending.
        if (!now || now.pendingAiMove?.col !== col) return;
        const fn = c4Api().connect4AckReveal;
        if (!fn) return;
        fn(characterId, col)
          .then(applyState)
          .catch(() => {
            /* next push reconciles */
          });
      }, REVEAL_ANIM_MS);
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
