/**
 * useChessStore — per-character chess games (renderer mirror).
 *
 * The authoritative game lives in main (src/main/chess/); this store caches
 * the last pushed ChessGameState per character, tracks the one-time engine
 * download progress, and holds the board's local UI state (selected square,
 * planning arrows, flip override, promotion picker, move-list scrubbing).
 *
 * AI move reveal: main pushes state with `pendingAiMove` once the character's
 * think delay elapses, but the board must NOT show it until the table has
 * gone quiet (useAiMoveReveal's postthink gate decides when). `reveal()`
 * applies the move visually (revealed[characterId] = uci, the board animates)
 * and acks it to main after the slide; the next state push commits the FEN and
 * clears the local overlay. A state push that drops or replaces pendingAiMove
 * (commit, a mid-conversation revision, or a wait() hold-back) always clears
 * `revealed`, so a retracted move never lingers on the board.
 *
 * Contract: src/shared/chessIpc.ts. The preload members may not exist yet in
 * this build, so all access goes through ONE narrow cast (chessApi below).
 */

import { create } from 'zustand';
import type { ChessDownloadProgress, ChessGameState } from '@shared/chessIpc';

/**
 * Narrow local view of the chess members on window.sei — matches the doc
 * comment in src/shared/chessIpc.ts exactly. Single cast point by design.
 */
interface ChessApi {
  chessStart(
    characterId: string,
    opts?: { playerColor?: 'w' | 'b' | 'random' },
  ): Promise<ChessGameState>;
  chessGetState(characterId: string): Promise<ChessGameState | null>;
  chessMove(
    characterId: string,
    uci: string,
  ): Promise<{ ok: boolean; error?: string; state: ChessGameState }>;
  chessResign(characterId: string): Promise<ChessGameState>;
  chessOfferDraw(characterId: string): Promise<ChessGameState>;
  chessRespondDraw(characterId: string, accept: boolean): Promise<ChessGameState>;
  chessRematch(characterId: string): Promise<ChessGameState>;
  chessEnd(characterId: string): Promise<void>;
  chessAckReveal(characterId: string, uci: string): Promise<ChessGameState>;
  onChessState(cb: (state: ChessGameState) => void): () => void;
  onChessDownload(cb: (p: ChessDownloadProgress) => void): () => void;
}

function chessApi(): Partial<ChessApi> {
  return window.sei as unknown as Partial<ChessApi>;
}

const NOT_AVAILABLE = 'Chess is not available in this build yet.';

export interface ChessArrow {
  from: string;
  to: string;
}

export interface ChessBoardUi {
  /** Square selected for click-click moving (null = none). */
  selected: string | null;
  /** Right-drag planning arrows. */
  arrows: ChessArrow[];
  /** Right-clicked circle highlights. */
  circles: string[];
  /** Orientation override; null = auto (player color at the bottom). */
  flip: boolean | null;
  /** A promotion move waiting on the piece picker. */
  pendingPromotion: { from: string; to: string } | null;
  /** Move-list scrub index into history (null = live position). */
  viewPly: number | null;
}

const DEFAULT_UI: ChessBoardUi = {
  selected: null,
  arrows: [],
  circles: [],
  flip: null,
  pendingPromotion: null,
  viewPly: null,
};

interface ChessStoreState {
  /** characterId → last authoritative snapshot from main. */
  games: Record<string, ChessGameState | null>;
  /** characterId → engine warm-up download progress. */
  downloads: Record<string, ChessDownloadProgress>;
  /** Panel open intent BEFORE a game exists (pre-game setup card). */
  panelIntent: Record<string, boolean>;
  /** Pending AI move applied locally after commentary finished (UCI). */
  revealed: Record<string, string | null>;
  /** characterId → chessStart in flight. */
  starting: Record<string, boolean>;
  /** characterId → hydrate (chessGetState) already attempted. */
  hydrated: Record<string, boolean>;
  /** characterId → board-local UI state. */
  ui: Record<string, ChessBoardUi>;

  /** Open the chess panel for a character (pre-game card if no game yet). */
  openPanel: (characterId: string) => void;
  /** Fetch any existing game once (resume after navigation / relaunch). */
  hydrate: (characterId: string) => Promise<void>;
  /** Start (or resume) a game. Throws on failure so the panel can branch:
   * CHESS_MC_SESSION_ACTIVE rejections open the disconnect confirm. */
  start: (characterId: string, playerColor: 'w' | 'b' | 'random') => Promise<void>;
  /** Player move in UCI. Returns main's verdict; state applies either way. */
  move: (characterId: string, uci: string) => Promise<boolean>;
  resign: (characterId: string) => Promise<void>;
  offerDraw: (characterId: string) => Promise<void>;
  respondDraw: (characterId: string, accept: boolean) => Promise<void>;
  rematch: (characterId: string) => Promise<void>;
  /** Close the panel. Ends any game in main (unfinished → 'abandoned'). */
  end: (characterId: string) => Promise<void>;
  /** Apply the pending AI move visually, then ack it to main after the slide. */
  reveal: (characterId: string, uci: string) => void;
  /** Patch board-local UI state. */
  setUi: (characterId: string, patch: Partial<ChessBoardUi>) => void;
}

/** How long the reveal slide animation runs before the ack is sent. Keep in
 * sync with the piece slide duration in ChessBoard.module.css. */
const REVEAL_ANIM_MS = 320;

/** Push unsubscribers, torn down on HMR dispose (same pattern as useChatStore:
 * a stale hot-reloaded instance would double-handle every push). */
let offState: (() => void) | null = null;
let offDownload: (() => void) | null = null;

export function boardUiFor(s: ChessStoreState, characterId: string): ChessBoardUi {
  return s.ui[characterId] ?? DEFAULT_UI;
}

/** The chat screen's chess aside is open when there is intent OR a game. */
export function isChessOpen(s: ChessStoreState, characterId: string): boolean {
  return s.panelIntent[characterId] === true || !!s.games[characterId];
}

export const useChessStore = create<ChessStoreState>((set, get) => {
  const applyState = (state: ChessGameState): void => {
    set((s) => {
      const prev = s.games[state.characterId];
      const prevRevealed = s.revealed[state.characterId] ?? null;
      // Keep the local reveal overlay ONLY while main still reports the same
      // pending move. Commit and rollback both drop pendingAiMove; a fresh
      // pending move replaces it.
      const keepReveal =
        prevRevealed !== null && state.pendingAiMove !== null && state.pendingAiMove.uci === prevRevealed;
      // A new committed move (or a new game) snaps move-list scrubbing back to
      // live so the board never silently stays in the past.
      const ui = s.ui[state.characterId];
      const moveLanded =
        !prev || prev.gameId !== state.gameId || prev.history.length !== state.history.length;
      const nextUi =
        ui && ui.viewPly !== null && moveLanded ? { ...ui, viewPly: null, selected: null } : ui;
      return {
        games: { ...s.games, [state.characterId]: state },
        revealed: { ...s.revealed, [state.characterId]: keepReveal ? prevRevealed : null },
        ...(nextUi !== ui ? { ui: { ...s.ui, [state.characterId]: nextUi as ChessBoardUi } } : {}),
      };
    });
  };

  try {
    offState = chessApi().onChessState?.(applyState) ?? null;
    offDownload =
      chessApi().onChessDownload?.((p) => {
        set((s) => ({ downloads: { ...s.downloads, [p.characterId]: p } }));
      }) ?? null;
  } catch {
    /* preload without the chess bridge — pushes just won't stream */
  }

  return {
    games: {},
    downloads: {},
    panelIntent: {},
    revealed: {},
    starting: {},
    hydrated: {},
    ui: {},

    openPanel: (characterId) => {
      set((s) => ({ panelIntent: { ...s.panelIntent, [characterId]: true } }));
      void get().hydrate(characterId);
    },

    hydrate: async (characterId) => {
      if (get().hydrated[characterId]) return;
      set((s) => ({ hydrated: { ...s.hydrated, [characterId]: true } }));
      const fn = chessApi().chessGetState;
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
      const fn = chessApi().chessStart;
      if (!fn) throw new Error(NOT_AVAILABLE);
      set((s) => ({ starting: { ...s.starting, [characterId]: true } }));
      try {
        const state = await fn(characterId, { playerColor });
        applyState(state);
        set((s) => ({
          starting: { ...s.starting, [characterId]: false },
          ui: { ...s.ui, [characterId]: { ...DEFAULT_UI } },
        }));
      } catch (err) {
        set((s) => ({ starting: { ...s.starting, [characterId]: false } }));
        throw err;
      }
    },

    move: async (characterId, uci) => {
      const fn = chessApi().chessMove;
      if (!fn) return false;
      // Clear transient interaction state up front; the returned snapshot is
      // authoritative either way.
      get().setUi(characterId, { selected: null, pendingPromotion: null });
      try {
        const res = await fn(characterId, uci);
        applyState(res.state);
        return res.ok;
      } catch {
        return false;
      }
    },

    resign: async (characterId) => {
      const fn = chessApi().chessResign;
      if (!fn) return;
      try {
        applyState(await fn(characterId));
      } catch {
        /* next push reconciles */
      }
    },

    offerDraw: async (characterId) => {
      const fn = chessApi().chessOfferDraw;
      if (!fn) return;
      try {
        applyState(await fn(characterId));
      } catch {
        /* next push reconciles */
      }
    },

    respondDraw: async (characterId, accept) => {
      const fn = chessApi().chessRespondDraw;
      if (!fn) return;
      try {
        applyState(await fn(characterId, accept));
      } catch {
        /* next push reconciles */
      }
    },

    rematch: async (characterId) => {
      const fn = chessApi().chessRematch;
      if (!fn) return;
      try {
        applyState(await fn(characterId));
        set((s) => ({
          revealed: { ...s.revealed, [characterId]: null },
          ui: { ...s.ui, [characterId]: { ...DEFAULT_UI } },
        }));
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
        ui: { ...s.ui, [characterId]: { ...DEFAULT_UI } },
      }));
      const fn = chessApi().chessEnd;
      if (!fn) return;
      try {
        await fn(characterId);
      } catch {
        /* already gone in main */
      }
    },

    reveal: (characterId, uci) => {
      const game = get().games[characterId];
      if (!game || game.pendingAiMove?.uci !== uci) return;
      if (get().revealed[characterId] === uci) return;
      set((s) => ({ revealed: { ...s.revealed, [characterId]: uci } }));
      window.setTimeout(() => {
        const now = get().games[characterId];
        // Interrupt rollback may have landed during the slide; only ack a move
        // main still considers pending.
        if (!now || now.pendingAiMove?.uci !== uci) return;
        const fn = chessApi().chessAckReveal;
        if (!fn) return;
        fn(characterId, uci)
          .then(applyState)
          .catch(() => {
            /* next push reconciles */
          });
      }, REVEAL_ANIM_MS);
    },

    setUi: (characterId, patch) => {
      set((s) => ({
        ui: { ...s.ui, [characterId]: { ...(s.ui[characterId] ?? DEFAULT_UI), ...patch } },
      }));
    },
  };
});

// Dev-only (Vite HMR): drop the stale instance's push listeners before the
// re-executed module registers fresh ones (same hazard as useChatStore's).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offState?.();
    offState = null;
    offDownload?.();
    offDownload = null;
  });
}
