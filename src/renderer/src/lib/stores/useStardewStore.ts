/**
 * useStardewStore (game adapters M1, 260908): the renderer's view of the
 * Stardew Valley install (src/main/games/stardew): the detection state, the
 * running install's progress (stardew:install-progress push), and the
 * launch/install actions. Main owns the truth; this is a thin mirror the
 * launch panel, the setup modal and the settings section all read.
 */
import { create } from 'zustand';
import type { StardewInstallProgressEvent, StardewInstallState, StardewLaunchResult } from '@shared/stardewIpc';
import { sei } from '../ipcClient';

interface StardewStore {
  /** null until the first detection lands. */
  state: StardewInstallState | null;
  /** The latest progress event of a running install (null when idle). */
  progress: StardewInstallProgressEvent | null;
  installing: boolean;
  /** The ErrorClass-prefixed message of the last failed install, or null. */
  installError: string | null;
  launching: boolean;
  lastLaunch: StardewLaunchResult | null;
  /** Subscribe to the progress push once. Returns the unsubscriber. */
  init: () => () => void;
  refresh: () => Promise<StardewInstallState | null>;
  /** Run the install; resolves once it settles (never rejects; read installError). */
  install: () => Promise<StardewInstallState | null>;
  launchGame: () => Promise<StardewLaunchResult | null>;
}

// Reference-counted: several surfaces (launch panel, setup modal, settings)
// call init() while mounted; the push subscription lives while any of them is.
let subscribers = 0;
let offPush: (() => void) | null = null;

export const useStardewStore = create<StardewStore>((set, get) => ({
  state: null,
  progress: null,
  installing: false,
  installError: null,
  launching: false,
  lastLaunch: null,

  init: () => {
    subscribers += 1;
    if (subscribers === 1) {
      offPush = sei.onStardewInstallProgress?.((ev) => {
        set({ progress: ev });
        if (ev.stage === 'done') set({ state: ev.state, installing: false, installError: null });
        if (ev.stage === 'failed') set({ installing: false, installError: `${ev.error}: ${ev.message}` });
      }) ?? null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscribers = Math.max(0, subscribers - 1);
      if (subscribers === 0) {
        offPush?.();
        offPush = null;
      }
    };
  },

  refresh: async () => {
    try {
      const state = await sei.stardewInstallState();
      set({ state });
      return state;
    } catch {
      return get().state;
    }
  },

  install: async () => {
    if (get().installing) return get().state;
    set({ installing: true, installError: null, progress: { stage: 'queued' } });
    try {
      const state = await sei.stardewInstall();
      set({ state, installing: false, progress: { stage: 'done', state } });
      return state;
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      // Electron wraps handler errors as "Error invoking remote method '...': Error: <msg>".
      const clean = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      set({ installing: false, installError: clean });
      void get().refresh();
      return get().state;
    }
  },

  launchGame: async () => {
    if (get().launching) return get().lastLaunch;
    set({ launching: true });
    try {
      const r = await sei.stardewLaunch();
      set({ lastLaunch: r, launching: false });
      return r;
    } catch (err) {
      const r: StardewLaunchResult = { launched: false, via: 'none', message: String((err as Error)?.message ?? err) };
      set({ lastLaunch: r, launching: false });
      return r;
    }
  },
}));
