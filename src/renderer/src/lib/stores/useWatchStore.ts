/**
 * useWatchStore — per-character screen-share ("watch") sessions (renderer
 * mirror). The authoritative session lives in main (src/main/watch/); this
 * store caches the last pushed WatchSessionState and the live preview
 * snapshot per character, plus the picker's source list + macOS permission
 * state for the consent flow.
 *
 * Consent flow (Discord-style, spec'd in src/shared/watchIpc.ts): the panel
 * lists capturable windows/screens with live thumbnails (windows first), the
 * player picks one and clicks Start; nothing ever auto-starts. While active a
 * "Watching: <source>" pill with a one-click Stop stays visible in the chat
 * screen. Main pushes `blank: true` when captures come back all-black (macOS
 * Screen Recording permission missing) so the panel reopens the walkthrough.
 *
 * Contract: src/shared/watchIpc.ts. The preload members may not exist yet in
 * this build, so all access goes through ONE narrow cast (watchApi below).
 */

import { create } from 'zustand';
import type {
  WatchPermissionStatus,
  WatchPreviewPush,
  WatchSessionState,
  WatchSource,
} from '@shared/watchIpc';

/** Narrow local view of the watch members on window.sei. Single cast point. */
interface WatchApi {
  watchListSources(): Promise<WatchSource[]>;
  watchStart(characterId: string, sourceId: string): Promise<WatchSessionState>;
  watchStop(characterId: string): Promise<void>;
  watchGetState(characterId: string): Promise<WatchSessionState | null>;
  watchPermissionStatus(): Promise<WatchPermissionStatus>;
  watchOpenPermissionSettings(): Promise<void>;
  onWatchState(cb: (state: WatchSessionState) => void): () => void;
  onWatchPreview(cb: (p: WatchPreviewPush) => void): () => void;
}

function watchApi(): Partial<WatchApi> {
  return window.sei as unknown as Partial<WatchApi>;
}

const NOT_AVAILABLE = 'Screen share is not available in this build yet.';

interface WatchStoreState {
  /** characterId → last authoritative snapshot from main. */
  sessions: Record<string, WatchSessionState | null>;
  /** Panel open intent BEFORE a session exists (the picker card). */
  panelIntent: Record<string, boolean>;
  /** characterId → latest preview snapshot (data URL + capture time). */
  previews: Record<string, { url: string; ts: number } | null>;
  /** Picker source list (shared across characters; refreshed on demand). */
  sources: WatchSource[] | null;
  sourcesLoading: boolean;
  /** macOS Screen Recording permission ('granted' off-macOS). */
  permission: WatchPermissionStatus | null;
  starting: Record<string, boolean>;
  hydrated: Record<string, boolean>;

  /** Open the panel for a character (picker card if no session yet). */
  openPanel: (characterId: string) => void;
  /** Close the panel. Does NOT stop an active session (the pill remains). */
  closePanel: (characterId: string) => void;
  /** Fetch any existing session once (resume after navigation / relaunch). */
  hydrate: (characterId: string) => Promise<void>;
  /**
   * Refresh the permission state + source list. On macOS the getSources call
   * inside also registers the app under Screen Recording in System Settings
   * when permission was never requested.
   */
  refreshSources: () => Promise<void>;
  /** Explicit per-session start of the picked source. Throws WATCH_ERR_*. */
  start: (characterId: string, sourceId: string) => Promise<void>;
  /** End the session (one-click Stop). The panel falls back to the picker. */
  stop: (characterId: string) => Promise<void>;
  openPermissionSettings: () => void;
}

/** Push unsubscribers, torn down on HMR dispose (useConnect4Store pattern). */
let offState: (() => void) | null = null;
let offPreview: (() => void) | null = null;

/** The chat screen's aside is open when there is intent OR a live session. */
export function isWatchOpen(s: WatchStoreState, characterId: string): boolean {
  return s.panelIntent[characterId] === true || isWatchActive(s, characterId);
}

/** True while the character is actively watching (drives the indicator pill). */
export function isWatchActive(s: WatchStoreState, characterId: string): boolean {
  const sess = s.sessions[characterId];
  return !!sess && sess.status === 'active';
}

export const useWatchStore = create<WatchStoreState>((set, get) => {
  const applyState = (state: WatchSessionState): void => {
    set((s) => ({
      sessions: { ...s.sessions, [state.characterId]: state },
      ...(state.status === 'ended'
        ? { previews: { ...s.previews, [state.characterId]: null } }
        : {}),
    }));
  };

  try {
    offState = watchApi().onWatchState?.(applyState) ?? null;
    offPreview =
      watchApi().onWatchPreview?.((p) => {
        set((s) => ({
          previews: { ...s.previews, [p.characterId]: { url: p.thumbnailDataUrl, ts: p.ts } },
        }));
      }) ?? null;
  } catch {
    /* preload without the watch bridge — pushes just won't stream */
  }

  return {
    sessions: {},
    panelIntent: {},
    previews: {},
    sources: null,
    sourcesLoading: false,
    permission: null,
    starting: {},
    hydrated: {},

    openPanel: (characterId) => {
      set((s) => ({ panelIntent: { ...s.panelIntent, [characterId]: true } }));
      void get().hydrate(characterId);
      void get().refreshSources();
    },

    closePanel: (characterId) => {
      set((s) => ({ panelIntent: { ...s.panelIntent, [characterId]: false } }));
    },

    hydrate: async (characterId) => {
      if (get().hydrated[characterId]) return;
      set((s) => ({ hydrated: { ...s.hydrated, [characterId]: true } }));
      const fn = watchApi().watchGetState;
      if (!fn) return;
      try {
        const state = await fn(characterId);
        if (state) applyState(state);
      } catch {
        set((s) => ({ hydrated: { ...s.hydrated, [characterId]: false } }));
      }
    },

    refreshSources: async () => {
      const api = watchApi();
      if (!api.watchListSources) return;
      set({ sourcesLoading: true });
      try {
        // Permission first: the sources call doubles as the macOS
        // registration nudge, so run both even when denied.
        const [permission, sources] = await Promise.all([
          api.watchPermissionStatus?.() ?? Promise.resolve('unknown' as const),
          api.watchListSources(),
        ]);
        set({ permission, sources, sourcesLoading: false });
      } catch {
        set({ sourcesLoading: false });
      }
    },

    start: async (characterId, sourceId) => {
      const fn = watchApi().watchStart;
      if (!fn) throw new Error(NOT_AVAILABLE);
      set((s) => ({ starting: { ...s.starting, [characterId]: true } }));
      try {
        const state = await fn(characterId, sourceId);
        applyState(state);
      } finally {
        set((s) => ({ starting: { ...s.starting, [characterId]: false } }));
      }
    },

    stop: async (characterId) => {
      const current = get().sessions[characterId];
      // Optimistic local end so the pill drops instantly.
      if (current && current.status === 'active') {
        applyState({ ...current, status: 'ended', endedReason: 'stopped' });
      }
      set((s) => ({ previews: { ...s.previews, [characterId]: null } }));
      const fn = watchApi().watchStop;
      if (!fn) return;
      try {
        await fn(characterId);
      } catch {
        /* already gone in main */
      }
    },

    openPermissionSettings: () => {
      void watchApi().watchOpenPermissionSettings?.();
    },
  };
});

// Dev-only (Vite HMR): drop the stale instance's push listeners before the
// re-executed module registers fresh ones.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offState?.();
    offState = null;
    offPreview?.();
    offPreview = null;
  });
}
