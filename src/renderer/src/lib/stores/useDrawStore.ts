/**
 * useDrawStore — the Draw! game (renderer mirror).
 *
 * Thin by design: the authoritative game lives in main (src/main/draw/), so
 * this caches the last pushed DrawGameState per character and forwards player
 * intents. It deliberately does NOT handle the two pixel-side channels
 * (draw:ai-stroke and draw:snapshot-request) — those are consumed by the
 * canvas component, which is the only thing that owns a rendering context.
 *
 * Contract: src/shared/drawIpc.ts. The preload members may not exist yet in an
 * older build, so all access goes through ONE narrow cast (drawApi below),
 * matching useChessStore.
 */

import { create } from 'zustand';
import type {
  DrawAiStroke,
  DrawGameState,
  DrawSnapshotRequest,
  DrawStroke,
} from '@shared/drawIpc';

/** Narrow local view of the draw members on window.sei. Single cast point. */
interface DrawApi {
  drawOpen(characterId: string): Promise<DrawGameState>;
  drawStart(characterId: string, rounds: number): Promise<DrawGameState>;
  drawNewGame(characterId: string): Promise<DrawGameState>;
  drawPickWord(characterId: string, word: string): Promise<DrawGameState>;
  drawGetState(characterId: string): Promise<DrawGameState | null>;
  drawStroke(characterId: string, stroke: DrawStroke): Promise<void>;
  drawErase(characterId: string, strokeId: string): Promise<void>;
  drawChat(characterId: string, text: string): Promise<void>;
  drawSnapshot(requestId: string, dataUrl: string): Promise<void>;
  drawSaveGallery(characterId: string, pngDataUrl: string): Promise<string>;
  drawEnd(characterId: string): Promise<void>;
  drawResume(characterId: string): Promise<void>;
  onDrawState(cb: (s: DrawGameState) => void): () => void;
  onDrawAiStroke(cb: (s: DrawAiStroke) => void): () => void;
  onDrawSnapshotRequest(cb: (r: DrawSnapshotRequest) => void): () => void;
}

export function drawApi(): Partial<DrawApi> {
  return window.sei as unknown as Partial<DrawApi>;
}

const NOT_AVAILABLE = 'Draw! is not available in this build yet.';

export interface DrawStoreState {
  games: Record<string, DrawGameState>;
  /** Set while a start request is in flight, so the button can't double-fire. */
  starting: Record<string, boolean>;
  /** Last error surfaced by an intent (shown on the setup screen). */
  error: Record<string, string | null>;
  /** Where the last gallery PNG was written, for the confirmation line. */
  savedTo: Record<string, string>;

  open: (characterId: string) => Promise<void>;
  start: (characterId: string, rounds: number) => Promise<void>;
  /** Back to the setup screen after a game, round count preselected. */
  newGame: (characterId: string) => Promise<void>;
  /** Choose one of the offered words and begin the drawing turn. */
  pickWord: (characterId: string, word: string) => void;
  sendStroke: (characterId: string, stroke: DrawStroke) => void;
  erase: (characterId: string, strokeId: string) => void;
  sendChat: (characterId: string, text: string) => void;
  /** Resolves with the written file path, or null when the save failed. */
  saveGallery: (characterId: string, pngDataUrl: string) => Promise<string | null>;
  /** Resume a game paused by the usage limit; state comes back on the push. */
  resume: (characterId: string) => void;
  end: (characterId: string) => Promise<void>;
}

/** Push unsubscriber, torn down on HMR dispose (see useChessStore). */
let offState: (() => void) | null = null;

export const useDrawStore = create<DrawStoreState>((set, get) => {
  const applyState = (state: DrawGameState): void => {
    set((s) => ({ games: { ...s.games, [state.characterId]: state } }));
  };

  try {
    offState = drawApi().onDrawState?.(applyState) ?? null;
  } catch {
    /* preload without the draw bridge — pushes just won't stream */
  }

  return {
    games: {},
    starting: {},
    error: {},
    savedTo: {},

    open: async (characterId) => {
      const api = drawApi();
      if (!api.drawOpen) {
        set((s) => ({ error: { ...s.error, [characterId]: NOT_AVAILABLE } }));
        return;
      }
      try {
        const state = await api.drawOpen(characterId);
        applyState(state);
        set((s) => ({ error: { ...s.error, [characterId]: null } }));
      } catch (err) {
        set((s) => ({ error: { ...s.error, [characterId]: (err as Error).message } }));
      }
    },

    start: async (characterId, rounds) => {
      const api = drawApi();
      if (!api.drawStart) return;
      if (get().starting[characterId]) return;
      set((s) => ({ starting: { ...s.starting, [characterId]: true } }));
      try {
        const state = await api.drawStart(characterId, rounds);
        applyState(state);
        set((s) => ({ error: { ...s.error, [characterId]: null } }));
      } catch (err) {
        set((s) => ({ error: { ...s.error, [characterId]: (err as Error).message } }));
      } finally {
        set((s) => ({ starting: { ...s.starting, [characterId]: false } }));
      }
    },

    newGame: async (characterId) => {
      const api = drawApi();
      if (!api.drawNewGame) return;
      try {
        applyState(await api.drawNewGame(characterId));
        set((s) => ({
          error: { ...s.error, [characterId]: null },
          // The path to the last game's PNG belongs to that game.
          savedTo: { ...s.savedTo, [characterId]: '' },
        }));
      } catch (err) {
        set((s) => ({ error: { ...s.error, [characterId]: (err as Error).message } }));
      }
    },

    // Fire-and-forget like the other in-turn intents: main answers with a
    // pushed state either way, and a swallowed click is better than a button
    // that can hang on a slow round trip.
    pickWord: (characterId, word) => {
      void drawApi().drawPickWord?.(characterId, word)?.catch(() => {});
    },

    // Fire-and-forget: main pushes the resulting state, so there is nothing to
    // await and a dropped stroke must never block the pen.
    sendStroke: (characterId, stroke) => {
      void drawApi().drawStroke?.(characterId, stroke)?.catch(() => {});
    },
    erase: (characterId, strokeId) => {
      void drawApi().drawErase?.(characterId, strokeId)?.catch(() => {});
    },
    sendChat: (characterId, text) => {
      void drawApi().drawChat?.(characterId, text)?.catch(() => {});
    },

    saveGallery: async (characterId, pngDataUrl) => {
      const api = drawApi();
      if (!api.drawSaveGallery) return null;
      try {
        const file = await api.drawSaveGallery(characterId, pngDataUrl);
        set((s) => ({ savedTo: { ...s.savedTo, [characterId]: file } }));
        return file;
      } catch (err) {
        set((s) => ({ error: { ...s.error, [characterId]: (err as Error).message } }));
        return null;
      }
    },

    resume: (characterId) => {
      void drawApi().drawResume?.(characterId)?.catch?.(() => {});
    },

    end: async (characterId) => {
      set((s) => {
        const games = { ...s.games };
        delete games[characterId];
        return { games, savedTo: { ...s.savedTo, [characterId]: '' } };
      });
      try {
        await drawApi().drawEnd?.(characterId);
      } catch {
        /* already gone */
      }
    },
  };
});

/** A Draw! game is live for this character (drives the cross-launch gate). */
export function isDrawActive(s: DrawStoreState, characterId: string): boolean {
  const g = s.games[characterId];
  return !!g && g.phase !== 'gallery';
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offState?.();
    offState = null;
  });
}
