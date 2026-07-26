/**
 * useMcDashboardStore — per-character Minecraft dashboard telemetry (renderer
 * mirror). The producer is the live bot process (via main's
 * mcDashboardService); this store caches the last pushed snapshot per
 * character plus the panel view mode.
 *
 * Lifecycle (260721): the surface is either open or closed, nothing in
 * between. While the bot is online the dashboard shows in the chat's game
 * area; there is no hide/minimize. Before the bot is online the launch
 * panel shows when `launch` is set (the games picker's Minecraft tile).
 * When the bot leaves, ChatScreen resets the snapshot.
 *
 * Contract: src/shared/mcDashboardIpc.ts. The preload members may not exist
 * yet in this build, so all access goes through ONE narrow cast (dashApi).
 */

import { create } from 'zustand';
import type { McDashboardSnapshot } from '@shared/mcDashboardIpc';
import type { McGameMode } from '@shared/ipc';

/** Narrow local view of the dashboard members on window.sei. Single cast. */
interface McDashApi {
  mcDashboardGet(characterId: string): Promise<McDashboardSnapshot | null>;
  mcDashboardSetWatching(characterId: string, watching: boolean): Promise<void>;
  onMcDashboardSnapshot(cb: (s: McDashboardSnapshot) => void): () => void;
  mcSetPaused(characterId: string, paused: boolean): Promise<boolean>;
  mcSetMode(characterId: string, mode: McGameMode): Promise<boolean>;
}

function dashApi(): Partial<McDashApi> {
  return window.sei as unknown as Partial<McDashApi>;
}

interface McDashboardStoreState {
  /** characterId → last pushed telemetry snapshot. */
  snapshots: Record<string, McDashboardSnapshot | null>;
  /**
   * characterId → the Minecraft LAUNCH panel is open in the chat game aside
   * (260721). Set by the games picker's Minecraft tile while the bot is not
   * online; ChatScreen clears it (handing off to the live dashboard) once
   * the bot comes online, and the unified end "x" clears it directly.
   */
  launch: Record<string, boolean>;
  hydrated: Record<string, boolean>;
  /**
   * 260725 runtime controls, per character. NEVER persisted — reset() (bot
   * left / session ended) drops the entry, so every summon starts unpaused
   * and proactive. Absent entry == the default { paused: false, mode:
   * 'proactive' }.
   */
  controls: Record<string, { paused: boolean; mode: McGameMode } | undefined>;

  /** Open/close the pre-summon launch panel for a character. */
  setLaunch: (characterId: string, open: boolean) => void;
  /** Pull the latest snapshot once (entering ChatScreen mid-session). */
  hydrate: (characterId: string) => Promise<void>;
  /** Visibility hint → the bot only samples the minimap while true. */
  setWatching: (characterId: string, watching: boolean) => void;
  /** 260725: play/pause toggle — optimistic local state + bot forward. */
  setPaused: (characterId: string, paused: boolean) => void;
  /** 260725: reactive/proactive mode — optimistic local state + bot forward. */
  setMode: (characterId: string, mode: McGameMode) => void;
  /** Session ended: drop the snapshot + runtime controls. */
  reset: (characterId: string) => void;
}

/** Push unsubscriber, torn down on HMR dispose (useChessStore pattern). */
let offSnapshot: (() => void) | null = null;

export const useMcDashboardStore = create<McDashboardStoreState>((set, get) => {
  try {
    offSnapshot =
      dashApi().onMcDashboardSnapshot?.((s) => {
        set((st) => ({ snapshots: { ...st.snapshots, [s.characterId]: s } }));
      }) ?? null;
  } catch {
    /* preload without the dashboard bridge — pushes just won't stream */
  }

  return {
    snapshots: {},
    launch: {},
    hydrated: {},
    controls: {},

    setLaunch: (characterId, open) => {
      set((s) => ({ launch: { ...s.launch, [characterId]: open } }));
    },

    hydrate: async (characterId) => {
      if (get().hydrated[characterId]) return;
      set((s) => ({ hydrated: { ...s.hydrated, [characterId]: true } }));
      const fn = dashApi().mcDashboardGet;
      if (!fn) return;
      try {
        const snap = await fn(characterId);
        if (snap) {
          set((s) => ({ snapshots: { ...s.snapshots, [characterId]: snap } }));
        }
      } catch {
        set((s) => ({ hydrated: { ...s.hydrated, [characterId]: false } }));
      }
    },

    setWatching: (characterId, watching) => {
      void dashApi()
        .mcDashboardSetWatching?.(characterId, watching)
        .catch(() => {
          /* session already gone — nothing to throttle */
        });
    },

    setPaused: (characterId, paused) => {
      const cur = get().controls[characterId] ?? { paused: false, mode: 'proactive' as McGameMode };
      set((s) => ({ controls: { ...s.controls, [characterId]: { ...cur, paused } } }));
      void dashApi()
        .mcSetPaused?.(characterId, paused)
        .catch(() => {
          /* session already gone — reset() clears the local state anyway */
        });
    },

    setMode: (characterId, mode) => {
      const cur = get().controls[characterId] ?? { paused: false, mode: 'proactive' as McGameMode };
      set((s) => ({ controls: { ...s.controls, [characterId]: { ...cur, mode } } }));
      void dashApi()
        .mcSetMode?.(characterId, mode)
        .catch(() => {
          /* session already gone */
        });
    },

    reset: (characterId) => {
      set((s) => ({
        snapshots: { ...s.snapshots, [characterId]: null },
        hydrated: { ...s.hydrated, [characterId]: false },
        // Runtime-only by design: the next summon starts unpaused + proactive.
        controls: { ...s.controls, [characterId]: undefined },
      }));
    },
  };
});

// Dev-only (Vite HMR): drop the stale instance's push listener before the
// re-executed module registers a fresh one (same hazard as useChatStore's).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offSnapshot?.();
    offSnapshot = null;
  });
}
