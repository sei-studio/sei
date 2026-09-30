/**
 * useGamePackStore (260908, game-adapters M0b) — the renderer's mirror of
 * main's game pack store (src/main/games/packs.ts): one GamePackState per
 * game, fed by the game:pack-progress push, with `ensure(game)` to start or
 * join the download from a card.
 *
 * Main owns the truth (disk + the live job); this store is a thin mirror so
 * the launch panel's download card and the summon path see the same state.
 * `init()` subscribes once (App.tsx) and pulls the current state of every
 * known game; a card that mounts before init has run can call `refresh`.
 */
import { create } from 'zustand';
import type { GameId, GamePackState } from '@shared/gamePacks';
import { GAME_IDS } from '@shared/gamePacks';
import { sei } from '../ipcClient';

interface GamePackStore {
  /** Per game; absent until the first pull/push lands. */
  packs: Partial<Record<GameId, GamePackState>>;
  /** Subscribe to main's pushes and pull every game's state. Returns unsubscribe. */
  init: () => () => void;
  /** Pull one game's state (no network on main's side). */
  refresh: (game: GameId) => Promise<GamePackState>;
  /**
   * Start or join the download. Resolves with the settled state; the
   * in-between `downloading` ticks arrive on the push. Never rejects on a
   * download failure (the state carries the error for the card's retry).
   */
  ensure: (game: GameId) => Promise<GamePackState>;
}

export const useGamePackStore = create<GamePackStore>((set, get) => ({
  packs: {},

  init: () => {
    const off = sei.onGamePackProgress(({ game, state }) => {
      set({ packs: { ...get().packs, [game]: state } });
    });
    for (const game of GAME_IDS) void get().refresh(game);
    return off;
  },

  refresh: async (game) => {
    const state = await sei.gamePackState(game);
    set({ packs: { ...get().packs, [game]: state } });
    return state;
  },

  ensure: async (game) => {
    const cur = get().packs[game];
    if (cur?.kind === 'ready') return cur;
    if (cur?.kind !== 'downloading') {
      // Optimistic: the card flips to the bar immediately instead of waiting
      // for main's first push (the manifest fetch can take a second).
      set({ packs: { ...get().packs, [game]: { kind: 'downloading', received: 0, total: 0 } } });
    }
    const state = await sei.gamePackEnsure(game);
    set({ packs: { ...get().packs, [game]: state } });
    return state;
  },
}));
