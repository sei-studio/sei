/**
 * useDstStore — renderer mirror of the Don't Starve Together install state
 * and per-character survivor picks (game adapters M2, 260908). Main owns the
 * truth (src/main/games/dontstarve); this store caches what the launch panel,
 * the setup modal body and the settings section show, and forwards the
 * install / launch / pick actions over the dst:* channels.
 */
import { create } from 'zustand';
import type { DstInstallState, DstSurvivorPick } from '@shared/dstIpc';
import { sei } from '../../lib/ipcClient';

interface DstApi {
  dstInstallState(): Promise<DstInstallState>;
  dstInstall(): Promise<DstInstallState>;
  dstLaunch(): Promise<void>;
  dstSurvivorGet(characterId: string): Promise<DstSurvivorPick>;
  dstSurvivorSet(characterId: string, prefab: string | null): Promise<DstSurvivorPick>;
  dstSetPort(port: number): Promise<void>;
  onDstInstallProgress(cb: (s: DstInstallState) => void): () => void;
}

/** The preload members may not exist in an older build; one narrow cast. */
function api(): Partial<DstApi> {
  return sei as unknown as Partial<DstApi>;
}

interface DstStoreState {
  install: DstInstallState | null;
  installBusy: boolean;
  launching: boolean;
  /** characterId -> pick (absent = not asked yet). */
  survivors: Record<string, DstSurvivorPick | undefined>;
  survivorBusy: Record<string, boolean | undefined>;
  refreshInstall: () => Promise<DstInstallState | null>;
  runInstall: () => Promise<DstInstallState | null>;
  launchGame: () => Promise<void>;
  loadSurvivor: (characterId: string) => Promise<DstSurvivorPick | null>;
  setSurvivor: (characterId: string, prefab: string | null) => Promise<void>;
  setPort: (port: number) => Promise<void>;
}

let offProgress: (() => void) | null = null;

export const useDstStore = create<DstStoreState>((set, get) => {
  try {
    offProgress = api().onDstInstallProgress?.((s) => set({ install: s })) ?? null;
  } catch {
    /* preload without the bridge */
  }
  return {
    install: null,
    installBusy: false,
    launching: false,
    survivors: {},
    survivorBusy: {},

    refreshInstall: async () => {
      const fn = api().dstInstallState;
      if (!fn) return null;
      try {
        const s = await fn();
        set({ install: s });
        return s;
      } catch {
        return null;
      }
    },

    runInstall: async () => {
      const fn = api().dstInstall;
      if (!fn || get().installBusy) return null;
      set({ installBusy: true, install: { kind: 'installing', step: 'copying' } });
      try {
        const s = await fn();
        set({ install: s });
        return s;
      } catch (err) {
        const s: DstInstallState = { kind: 'error', error: 'GAME_INSTALL_FAILED', message: (err as Error).message };
        set({ install: s });
        return s;
      } finally {
        set({ installBusy: false });
      }
    },

    launchGame: async () => {
      const fn = api().dstLaunch;
      if (!fn || get().launching) return;
      set({ launching: true });
      try {
        await fn();
      } catch {
        /* Steam is not installed or refused the URL; the panel copy covers it */
      } finally {
        setTimeout(() => set({ launching: false }), 1500);
      }
    },

    loadSurvivor: async (characterId) => {
      const fn = api().dstSurvivorGet;
      if (!fn) return null;
      if (get().survivorBusy[characterId]) return get().survivors[characterId] ?? null;
      set((s) => ({ survivorBusy: { ...s.survivorBusy, [characterId]: true } }));
      try {
        const pick = await fn(characterId);
        set((s) => ({ survivors: { ...s.survivors, [characterId]: pick } }));
        return pick;
      } catch {
        return null;
      } finally {
        set((s) => ({ survivorBusy: { ...s.survivorBusy, [characterId]: false } }));
      }
    },

    setSurvivor: async (characterId, prefab) => {
      const fn = api().dstSurvivorSet;
      if (!fn) return;
      set((s) => ({ survivorBusy: { ...s.survivorBusy, [characterId]: true } }));
      try {
        const pick = await fn(characterId, prefab);
        set((s) => ({ survivors: { ...s.survivors, [characterId]: pick } }));
      } catch {
        /* keep the previous pick */
      } finally {
        set((s) => ({ survivorBusy: { ...s.survivorBusy, [characterId]: false } }));
      }
    },

    setPort: async (port) => {
      const fn = api().dstSetPort;
      if (!fn) return;
      try {
        await fn(port);
      } catch {
        /* the settings row shows the world state, which reflects the bind */
      }
    },
  };
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offProgress?.();
    offProgress = null;
  });
}
