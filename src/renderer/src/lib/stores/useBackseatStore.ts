/**
 * Backseat store (260728, rebuilt 260803).
 *
 * It used to be deliberately thin, because backseat's real UI was a separate
 * always-on-top window that owned its own state and its own capture. That
 * window is gone (260803) and screen sharing is now a call feature, opened from
 * the call controls the way Discord does it, so this store is what took its
 * place: it OWNS the capture session for the whole app.
 *
 * Why the overlay could go. The reason capture lived in its own window was that
 * Chromium clamps timers in a hidden or fully occluded renderer, and the main
 * window is exactly that while the player is in a fullscreen game. That is
 * already solved elsewhere: the main window runs with backgroundThrottling
 * false (windowChrome.ts), and the frame pump itself is a
 * MediaStreamTrackProcessor in a worker, which is throttle-immune either way.
 * With no separate window there is no second renderer, no duplicated state, and
 * no push routing that has to fan out to two places.
 *
 * Sharing requires a call and ends with it. That is the whole shape of the
 * feature: you are on a call, you show them your screen, they talk about it.
 * There is no text mode any more because there is no window to type in, and no
 * pause button because the share toggle is the pause button.
 *
 * `active` survives all of that unchanged: it answers "does this character have
 * a live session" for the IconRail activity badge and the cross-launch gate
 * (lib/gameLaunch), which still holds, because a companion cannot be watching
 * your screen and standing in your Minecraft world at the same time.
 */

import { create } from 'zustand';
import type { BackseatSource, BackseatState } from '../../../../shared/backseatIpc';
import { startCapture, stopCapture, type CaptureHandle } from '../backseat/captureController';
import { sei } from '../ipcClient';

interface BackseatStore {
  /** characterId -> true while a session is live. */
  active: Record<string, boolean>;
  /** Who we are sharing a screen with right now, if anyone. */
  sharingFor: string | null;
  /** The shared stream, for the preview in the call window. */
  stream: MediaStream | null;
  /** What is being shared, for the label under the preview. */
  sourceName: string | null;
  /** True between picking a source and capture actually running. */
  starting: boolean;
  /** Why the last share attempt failed, for the picker to show. */
  error: string | null;

  /** Start sharing `source` with `characterId`. Throws nothing: failures land
   *  in `error` so the picker can stay open and let them try another window. */
  share: (characterId: string, source: BackseatSource) => Promise<boolean>;
  /** Stop sharing, tearing down capture and the session in main. */
  stopSharing: () => Promise<void>;
  /** Mark a session started (used by the cross-launch gate's launch thunk). */
  markStarted: (characterId: string) => void;
  /** End a live session (the cross-launch gate's end path). */
  end: (characterId: string) => Promise<void>;
  /** Reconcile against main, e.g. after a reload. */
  refresh: (characterId: string) => Promise<void>;
}

/** The live capture, held outside the store: it is a handle with methods, not
 *  state to render, and putting it in the store would make every consumer
 *  re-render on a reference that never means anything to them. */
let capture: CaptureHandle | null = null;

/** Push unsubscribers, torn down on HMR dispose (see useChessStore). */
let offState: (() => void) | null = null;
let offLine: (() => void) | null = null;

/** The armed-grid + send path, for whoever is showing the share UI. */
export function backseatCapture(): CaptureHandle | null {
  return capture;
}

export const useBackseatStore = create<BackseatStore>((set, get) => {
  try {
    offState =
      sei.onBackseatState?.((s: BackseatState) => {
        set((st) => {
          const next = { ...st.active };
          if (s.phase === 'ended') delete next[s.characterId];
          else next[s.characterId] = true;
          return { active: next };
        });
      }) ?? null;
    // The companion just spoke, so push the scheduled look back a full fresh
    // interval. Main enforces MIN_SPEAK_GAP_MS regardless, but without this the
    // very next idle tick is composed, sent and dropped for nothing. (The
    // player's own echoed line is a real turn boundary too: it means a reply is
    // imminent.)
    offLine = sei.onBackseatLine?.(() => capture?.noteSpoke()) ?? null;
  } catch {
    /* preload without the backseat bridge — refresh() still reconciles */
  }

  return {
    active: {},
    sharingFor: null,
    stream: null,
    sourceName: null,
    starting: false,
    error: null,

    share: async (characterId, source) => {
      if (get().starting) return false;
      set({ starting: true, error: null });
      // Order matters: main registers the session first, so a start it refuses
      // (a live Minecraft summon) never leaves a capture running with nothing
      // to send ticks to.
      try {
        await sei.backseatStart(characterId, source.id, source.name, 'voice');
      } catch (err) {
        const msg = (err as Error).message ?? '';
        set({
          starting: false,
          error: msg.includes('BACKSEAT_MC_SESSION_ACTIVE')
            ? 'They are in your Minecraft world right now. End that first.'
            : 'Could not start sharing. Try picking a different window.',
        });
        return false;
      }
      try {
        capture = await startCapture(characterId, source.id);
      } catch (err) {
        // Capture failed after main accepted the session, so unwind it rather
        // than leaving a session with no pictures.
        void sei.backseatEnd(characterId).catch(() => {});
        set({
          starting: false,
          error: (err as Error).message || 'Could not read that window.',
        });
        return false;
      }
      set({
        sharingFor: characterId,
        stream: capture.stream,
        sourceName: source.name,
        starting: false,
        error: null,
        active: { ...get().active, [characterId]: true },
      });
      return true;
    },

    stopSharing: async () => {
      const characterId = get().sharingFor;
      capture = null;
      stopCapture();
      set({ sharingFor: null, stream: null, sourceName: null, starting: false, error: null });
      if (!characterId) return;
      set((s) => {
        const next = { ...s.active };
        delete next[characterId];
        return { active: next };
      });
      try {
        await sei.backseatEnd(characterId);
      } catch {
        /* already ended */
      }
    },

    markStarted: (characterId) =>
      set((s) => ({ active: { ...s.active, [characterId]: true } })),

    end: async (characterId) => {
      if (get().sharingFor === characterId) {
        await get().stopSharing();
        return;
      }
      set((s) => {
        const next = { ...s.active };
        delete next[characterId];
        return { active: next };
      });
      try {
        await sei.backseatEnd(characterId);
      } catch {
        /* already ended */
      }
    },

    refresh: async (characterId) => {
      let live = false;
      try {
        const state = await sei.backseatGetState(characterId);
        live = !!state && state.phase !== 'ended';
      } catch {
        live = false;
      }
      set((s) => {
        const next = { ...s.active };
        if (live) next[characterId] = true;
        else delete next[characterId];
        return { active: next };
      });
    },
  };
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offState?.();
    offLine?.();
    offState = null;
    offLine = null;
  });
}
