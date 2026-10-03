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
 *
 * 260803: the PENDING SHARE. The chat header's Backseat button opens the same
 * picker with no call running, so "Share" has to start a call AND a share. It
 * cannot do both inline: dialing needs the ~40 MB voice module, whose
 * install/consent gate lives on VoiceCallScreen, so the call is seconds to
 * minutes away and may never happen at all if the player declines. So the
 * picker only ARMS the share here and routes to the call; whoever sees the call
 * reach 'live' consumes it (CallMiniBar, the app-level call watchdog: it is
 * mounted on every view, so a player who navigates away mid-dial still gets the
 * share they asked for). The arm carries a deadline and self-clears, because
 * the common ending for this state is a call that never happens.
 *
 * 261004: the AUTO-SHARE WATCH. A backseat game with `autoShare` (Roblox)
 * skips the share picker: opening it means "I am about to play this, watch
 * it". So instead of a picked source the store holds a watch, which looks for
 * the game's window every few seconds and shares it as soon as it is up. While
 * nothing is found the call shows a waiting card. When the shared window goes
 * away (the player quit, or Roblox restarted to switch servers) the OS ends
 * the track, the session ends as it always did, and the watch goes back to
 * waiting instead of leaving a dead share. A cold start arms a pending share
 * with no source, which starts the watch once the call is live. The watch
 * ends with the share toggle, the call, or "share something else".
 */

import { create } from 'zustand';
import type { BackseatSource, BackseatState } from '../../../../shared/backseatIpc';
import {
  backseatGame,
  pickHintedSource,
  type BackseatGameSelection,
} from '../../../../shared/backseatGames';
import { startCapture, stopCapture, type CaptureHandle } from '../backseat/captureController';
import { sei } from '../ipcClient';
import { t } from '../i18n';
import { visionGateReason } from '../visionGate';
import { useUiStore } from './useUiStore';

/**
 * How long an armed share waits for its call. The voice-module download alone
 * is capped at 180s (voice/modelPrefetch), so a shorter window would drop the
 * share of anyone installing on a slow connection. It is not longer because the
 * cost of a stale arm is a surprise share on some LATER call with the same
 * companion, and that window should stay small. Missing the deadline is cheap:
 * the share button is right there in the call controls.
 */
export const PENDING_SHARE_TTL_MS = 180_000;

/** How often the auto-share watch looks for the game's window. */
export const WATCH_POLL_MS = 2_500;
/** A window has to still be there on the next look before it is shared, so a
 *  launcher or splash window that flashes up and closes is not grabbed. */
export const WATCH_SETTLE_MS = 1_500;
/** After this many failed starts in a row the watch stops retrying and leaves
 *  the reason on the waiting card. */
export const WATCH_MAX_FAILURES = 3;

/** A share the player asked for before there was a call to put it on. */
export interface PendingShare {
  characterId: string;
  /** null (261004): no source yet, start the auto-share watch for `game`. */
  source: BackseatSource | null;
  /** Set when the share came from a backseat game tile (260929). */
  game?: BackseatGameSelection;
  /** Epoch ms after which this must not fire. */
  expiresAt: number;
}

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
  /** A share waiting for its call to go live; null when nothing is armed. */
  pendingShare: PendingShare | null;
  /**
   * The auto-share watch (261004), set while a game's window is being waited
   * for or shared on its own. `resumed` once its window has closed at least
   * once (the waiting card says "hop back in"). `stalled` means it gave up
   * retrying after failed starts; `error` says why.
   */
  watch: {
    characterId: string;
    game: BackseatGameSelection;
    resumed: boolean;
    stalled: boolean;
  } | null;

  /** Start sharing `source` with `characterId`. Throws nothing: failures land
   *  in `error` so the picker can stay open and let them try another window. */
  share: (
    characterId: string,
    source: BackseatSource,
    game?: BackseatGameSelection,
  ) => Promise<boolean>;
  /** Remember a share to start once a call with `characterId` goes live.
   *  A null source arms the auto-share watch for `game` instead. */
  armPendingShare: (
    characterId: string,
    source: BackseatSource | null,
    game?: BackseatGameSelection,
  ) => void;
  /** Wait for `game`'s window and share it whenever it is open (261004). */
  startWatch: (characterId: string, game: BackseatGameSelection) => void;
  /** Stop waiting for the window. A share already running keeps going. */
  stopWatch: () => void;
  /** Drop the armed share (call failed, deadline passed, or it just fired). */
  clearPendingShare: () => void;
  /** Start the armed share if it is still valid. Returns whether it started. */
  consumePendingShare: (characterId: string) => Promise<boolean>;
  /** Stop sharing, tearing down capture and the session in main. */
  stopSharing: () => Promise<void>;
  /** Mark a session started (used by the cross-launch gate's launch thunk). */
  markStarted: (characterId: string) => void;
  /** End a live session (the cross-launch gate's end path). */
  end: (characterId: string) => Promise<void>;
  /** Reconcile against main, e.g. after a reload. */
  refresh: (characterId: string) => Promise<void>;
  /**
   * Account switch (260926): stop capture and forget every session and any
   * armed share, WITHOUT backseat:end. Main already ended the sessions (and
   * wrote their rows) for the outgoing account; a share still starting is
   * abandoned when it resolves.
   */
  resetForScope: () => void;
}

/** The live capture, held outside the store: it is a handle with methods, not
 *  state to render, and putting it in the store would make every consumer
 *  re-render on a reference that never means anything to them. */
let capture: CaptureHandle | null = null;

/** Push unsubscribers, torn down on HMR dispose (see useChessStore). */
let offState: (() => void) | null = null;
let offLine: (() => void) | null = null;

/** Deadline timer for the armed share. Held outside the store for the same
 *  reason `capture` is: it is a handle, not something anyone renders. */
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/** Bumped by resetForScope: a share() begun under the previous account sees
 *  it changed across its awaits and unwinds instead of landing. */
let scopeEpoch = 0;

/** The watch's next look, and what it saw last time (for the settle check). */
let watchTimer: ReturnType<typeof setTimeout> | null = null;
let watchSeen: string | null = null;
let watchFailures = 0;
/** Bumped by every startWatch/stopWatch, so a look still in flight can tell
 *  its watch was replaced or stopped while it awaited. */
let watchGen = 0;

function clearWatchTimer(): void {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
}

/** The armed-grid + send path, for whoever is showing the share UI. */
export function backseatCapture(): CaptureHandle | null {
  return capture;
}

export const useBackseatStore = create<BackseatStore>((set, get) => {
  const scheduleWatch = (delay: number = WATCH_POLL_MS): void => {
    clearWatchTimer();
    watchTimer = setTimeout(() => void watchTick(), delay);
  };

  /** One look for the watched game's window; shares it once it has settled. */
  const watchTick = async (): Promise<void> => {
    watchTimer = null;
    const w = get().watch;
    const gen = watchGen;
    if (!w || w.stalled) return;
    // A capture is running (or coming up): its end puts the watch back on.
    if (get().sharingFor || get().starting) return;
    const def = backseatGame(w.game.gameId);
    if (!def) {
      get().stopWatch();
      return;
    }
    let list: BackseatSource[] = [];
    try {
      list = await sei.backseatSources({ thumbnails: false });
    } catch {
      /* the next look tries again */
    }
    if (watchGen !== gen) return;
    // Windows come front to back, so with several game windows open the
    // frontmost one, the one being played, wins.
    const hit = pickHintedSource(list, def.windowNames);
    if (!hit) {
      watchSeen = null;
      scheduleWatch();
      return;
    }
    if (watchSeen !== hit.id) {
      watchSeen = hit.id;
      scheduleWatch(WATCH_SETTLE_MS);
      return;
    }
    watchSeen = null;
    const ok = await get().share(w.characterId, hit, w.game);
    if (watchGen !== gen) {
      // Stopped (or replaced) while the capture was coming up: a share that
      // landed anyway belongs to a watch nobody wants any more.
      if (ok && get().watch === null) void get().stopSharing();
      return;
    }
    if (ok) {
      watchFailures = 0;
      return;
    }
    watchFailures += 1;
    if (watchFailures >= WATCH_MAX_FAILURES) {
      const cur = get().watch;
      if (cur) set({ watch: { ...cur, stalled: true } });
      return;
    }
    scheduleWatch(WATCH_POLL_MS * 2);
  };

  /** The OS ended the shared track: the window closed. Main's session was
   *  already ended by the capture controller. */
  const onCaptureEnded = (characterId: string, handle: () => CaptureHandle | null): void => {
    if (capture !== handle()) return;
    capture = null;
    set((s) => {
      const next = { ...s.active };
      delete next[characterId];
      return { sharingFor: null, stream: null, sourceName: null, active: next };
    });
    // Paused, not over: wait for the game to come back.
    const w = get().watch;
    if (w?.characterId === characterId) {
      set({ watch: { ...w, resumed: true } });
      scheduleWatch();
    }
  };

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
    pendingShare: null,
    watch: null,

    share: async (characterId, source, game) => {
      if (get().starting) return false;
      const epoch = scopeEpoch;
      set({ starting: true, error: null });
      // Order matters: main registers the session first, so a start it refuses
      // (a live Minecraft summon) never leaves a capture running with nothing
      // to send ticks to.
      try {
        await sei.backseatStart(characterId, source.id, source.name, 'voice', game);
      } catch (err) {
        // Refused because the account is changing (ACCOUNT_SWITCHING), or it
        // changed while main answered: resetForScope already reset the store.
        if (epoch !== scopeEpoch) return false;
        const msg = (err as Error).message ?? '';
        set({
          starting: false,
          error: msg.includes('BACKSEAT_MC_SESSION_ACTIVE')
            ? t('They are in your Minecraft world right now. End that first.')
            : // Main's authoritative vision backstop (china-compat W9). The
              // entry points are gated in the renderer too, but a pending
              // share armed before a model switch can still land here.
              msg.includes('LLM_NO_VISION')
              ? visionGateReason(t, 'backseat', useUiStore.getState().llmModel)
              : t('Could not start sharing. Try picking a different window.'),
        });
        return false;
      }
      if (epoch !== scopeEpoch) {
        // The account changed after main accepted the session. Main's switch
        // ends its sessions itself; ending it here too covers a session that
        // registered after that sweep. A no-op when it is already gone.
        void sei.backseatEnd(characterId).catch(() => {});
        return false;
      }
      try {
        let mine: CaptureHandle | null = null;
        const started = await startCapture(characterId, source.id, source.name, {
          onEnded: () => onCaptureEnded(characterId, () => mine),
        });
        mine = started;
        if (epoch !== scopeEpoch) {
          // The account changed while capture was coming up.
          stopCapture();
          void sei.backseatEnd(characterId).catch(() => {});
          return false;
        }
        capture = started;
      } catch (err) {
        // Capture failed after main accepted the session, so unwind it rather
        // than leaving a session with no pictures.
        void sei.backseatEnd(characterId).catch(() => {});
        set({
          starting: false,
          error: (err as Error).message || t('Could not read that window.'),
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

    armPendingShare: (characterId, source, game) => {
      get().clearPendingShare();
      const expiresAt = Date.now() + PENDING_SHARE_TTL_MS;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        // The call never came (declined install, backed out, dial failed).
        set({ pendingShare: null });
      }, PENDING_SHARE_TTL_MS);
      set({ pendingShare: { characterId, source, expiresAt, ...(game ? { game } : {}) } });
    },

    clearPendingShare: () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      if (get().pendingShare) set({ pendingShare: null });
    },

    consumePendingShare: async (characterId) => {
      const pending = get().pendingShare;
      if (!pending || pending.characterId !== characterId) return false;
      // The timer normally clears a stale arm, but timers lag across a machine
      // sleep, so the deadline is re-checked against the clock before firing.
      const expired = Date.now() >= pending.expiresAt;
      // Clear FIRST either way: the consumer runs off a store subscription, and
      // an arm still readable while share() awaits would fire a second time.
      get().clearPendingShare();
      if (expired) return false;
      if (!pending.source) {
        if (!pending.game) return false;
        get().startWatch(pending.characterId, pending.game);
        return true;
      }
      return get().share(pending.characterId, pending.source, pending.game);
    },

    startWatch: (characterId, game) => {
      watchGen += 1;
      clearWatchTimer();
      watchSeen = null;
      watchFailures = 0;
      set({ watch: { characterId, game, resumed: false, stalled: false }, error: null });
      void watchTick();
    },

    stopWatch: () => {
      watchGen += 1;
      clearWatchTimer();
      watchSeen = null;
      watchFailures = 0;
      if (get().watch) set({ watch: null });
    },

    stopSharing: async () => {
      // The share toggle means "stop showing them my screen", which includes
      // waiting to show it.
      get().stopWatch();
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

    resetForScope: () => {
      scopeEpoch += 1;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      watchGen += 1;
      clearWatchTimer();
      watchSeen = null;
      watchFailures = 0;
      stopCapture();
      capture = null;
      set({
        watch: null,
        active: {},
        sharingFor: null,
        stream: null,
        sourceName: null,
        starting: false,
        error: null,
        pendingShare: null,
      });
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
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    clearWatchTimer();
  });
}
