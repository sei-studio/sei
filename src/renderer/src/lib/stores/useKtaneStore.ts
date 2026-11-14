/**
 * useKtaneStore — KTANE expert mode (261115), renderer mirror.
 *
 * Main owns the session and the companion's bomb notes
 * (src/main/ktane/ktaneService.ts); this caches the last pushed KtaneState
 * per character, remembers whether the panel is open, and forwards intents.
 * Contract: src/shared/ktaneIpc.ts.
 */
import { create } from 'zustand';
import type { KtaneStartSource, KtaneState } from '@shared/ktaneIpc';

/** Narrow view of the ktane members on window.sei (an older preload lacks them). */
interface KtaneApi {
  ktaneOpen(characterId: string): Promise<KtaneState | null>;
  ktaneStart(characterId: string, source: KtaneStartSource, onCall: boolean): Promise<KtaneState>;
  ktaneNewBomb(characterId: string): Promise<KtaneState | null>;
  ktaneEnd(characterId: string): Promise<void>;
  onKtaneState(cb: (s: KtaneState) => void): () => void;
}

function ktaneApi(): Partial<KtaneApi> {
  return window.sei as unknown as Partial<KtaneApi>;
}

export interface KtaneStoreState {
  /** The panel is showing in the chat game area. */
  open: Record<string, boolean>;
  /** The live session (absent / inactive = none). */
  sessions: Record<string, KtaneState>;
  starting: Record<string, boolean>;
  error: Record<string, string | null>;

  openPanel: (characterId: string) => Promise<void>;
  start: (characterId: string, source: KtaneStartSource, onCall: boolean) => Promise<boolean>;
  newBomb: (characterId: string) => Promise<void>;
  /** End the session (if any) and close the panel. */
  end: (characterId: string) => Promise<void>;
  /** Account switch: forget everything; main already ended the sessions. */
  resetForScope: () => void;
}

export function isKtaneLive(s: Pick<KtaneStoreState, 'sessions'>, characterId: string): boolean {
  return s.sessions[characterId]?.active === true;
}

let offState: (() => void) | null = null;

export const useKtaneStore = create<KtaneStoreState>((set, get) => {
  const applyState = (state: KtaneState): void => {
    set((s) => {
      const sessions = { ...s.sessions };
      if (state.active) sessions[state.characterId] = state;
      else delete sessions[state.characterId];
      return { sessions };
    });
  };
  try {
    offState = ktaneApi().onKtaneState?.(applyState) ?? null;
  } catch {
    /* preload without the ktane bridge */
  }

  return {
    open: {},
    sessions: {},
    starting: {},
    error: {},

    openPanel: async (characterId) => {
      set((s) => ({ open: { ...s.open, [characterId]: true }, error: { ...s.error, [characterId]: null } }));
      try {
        const state = await ktaneApi().ktaneOpen?.(characterId);
        if (state) applyState(state);
      } catch {
        /* the panel still works; start reports its own error */
      }
    },

    start: async (characterId, source, onCall) => {
      const api = ktaneApi();
      if (!api.ktaneStart || get().starting[characterId]) return false;
      set((s) => ({ starting: { ...s.starting, [characterId]: true } }));
      try {
        applyState(await api.ktaneStart(characterId, source, onCall));
        set((s) => ({ error: { ...s.error, [characterId]: null } }));
        return true;
      } catch (err) {
        set((s) => ({ error: { ...s.error, [characterId]: (err as Error).message ?? 'error' } }));
        return false;
      } finally {
        set((s) => ({ starting: { ...s.starting, [characterId]: false } }));
      }
    },

    newBomb: async (characterId) => {
      try {
        const state = await ktaneApi().ktaneNewBomb?.(characterId);
        if (state) applyState(state);
      } catch {
        /* the next push corrects it */
      }
    },

    end: async (characterId) => {
      set((s) => ({ open: { ...s.open, [characterId]: false } }));
      try {
        if (isKtaneLive(get(), characterId)) await ktaneApi().ktaneEnd?.(characterId);
      } catch {
        /* already ended */
      }
      set((s) => {
        const sessions = { ...s.sessions };
        delete sessions[characterId];
        return { sessions };
      });
    },

    resetForScope: () => set({ open: {}, sessions: {}, starting: {}, error: {} }),
  };
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offState?.();
    offState = null;
  });
}
