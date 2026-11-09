/**
 * SeiLink main <-> room host wire protocol (261104): newline-delimited JSON
 * over a named pipe (Windows) or a unix socket (macOS). Same shape as the
 * spike's (exp/seilink-spike spikes/seilink/app/supervisor.js).
 *
 * The host speaks first (`hello` with its pid and the token main put in its
 * environment); main ignores every connection until a hello matches the
 * child it spawned, so a straggler from a replaced host, or another local
 * process, is never listened to.
 */
import type { AvatarEmotion, AvatarManifest } from '../../../shared/ipc';
import type { SeilinkDockAction, SeilinkDockOffer, SeilinkHostAvatarMethod, SeilinkHostFailure, SeilinkHostRoom } from '../../../shared/seilinkHost';

/** Main -> host. */
export type ToHost =
  /**
   * Her room, and the files the host may serve: pack files (pack-relative path -> realpath),
   * and her portrait's realpath when payload.portrait is a sei-room://_portrait URL.
   */
  | { type: 'room'; payload: SeilinkHostRoom; files: Array<[string, string]>; portraitFile?: string | null }
  /** The player is chatting with her, or just clicked her. */
  | { type: 'busy'; busy: boolean }
  /**
   * Answer to a `call`. A value that carries file bytes names the files instead
   * (`{file}` for facepackFile, `[{path, file}]` for avatarModelFiles); the host reads them.
   */
  | { type: 'call-result'; id: number; ok: boolean; value?: unknown; error?: string }
  /** Her imported avatar changed (an accessory toggle, an import, a removal). */
  | { type: 'avatar-manifest'; characterId: string; manifest: AvatarManifest | null }
  /** Frame cap while visible. */
  | { type: 'set-fps'; fps: number }
  /** M4: the dock's state (her idle lines muted; 261106 the decorate-together offer). */
  | { type: 'dock-state'; deafened: boolean; offer?: SeilinkDockOffer }
  /** M4: a line she says on the desktop (a bubble near her). */
  | { type: 'line'; text: string; kind: 'idle' | 'poke'; emotion?: AvatarEmotion | null; face?: string | null }
  /**
   * 261110: her voice (TTS in the main window, a chat reply or a call) started or stopped, so
   * her mouth moves on the desktop too. Only for the companion on the desktop.
   */
  | { type: 'voice'; speaking: boolean }
  /** 261110: her voice's level now (0..1, about 25 a second while it plays). */
  | { type: 'level'; level: number }
  /** Hold the room still (a future dock "pause"). */
  | { type: 'set-paused'; paused: boolean }
  | { type: 'quit' }
  /**
   * Liveness probe, every second. The host answers `pong` from its main process as soon as the
   * line arrives: an incoming pipe read wakes a host that App Nap throttles, where its own 1 s
   * heartbeat timer may be stretched to many seconds while it is covered.
   */
  | { type: 'ping'; seq: number }
  /** CI self-test hosts only (--seilink-test): wedge the main thread for `ms`. */
  | { type: 'test-hang'; ms: number };

/**
 * 261110: counts the host adds to the session (taps on her, how presses went, GPU process
 * losses). A closed set: main ignores any other key.
 */
export const SEILINK_HOST_COUNT_KEYS = [
  // A press that started on her: a tap, a drag (moved past the slop), a long press (> 1.5 s).
  'press_tap',
  'press_drag',
  'press_long',
  // A press just outside her box (within 48 px): a tap that missed her.
  'press_near_miss',
  // The GPU process went away (Chromium falls back to software after a few).
  'gpu_process_gone',
  // Her voice from the main window reached the desktop (a line with a level, or speaking only).
  'voice_lines',
  'voice_levels',
] as const;
export type SeilinkHostCountKey = (typeof SEILINK_HOST_COUNT_KEYS)[number];

export function isSeilinkHostCountKey(v: unknown): v is SeilinkHostCountKey {
  return typeof v === 'string' && (SEILINK_HOST_COUNT_KEYS as readonly string[]).includes(v);
}

/** Host -> main. */
export type FromHost =
  | { type: 'hello'; pid: number; token: string }
  | { type: 'attached'; reattach: boolean; reason: string; layout: string; method?: string; attachMs: number }
  | { type: 'attach-failed'; failure: SeilinkHostFailure; detail: string }
  /**
   * The page drew its first frame after an attach. 261105: with what the host verified right
   * then (Windows: validate() says the window is still the child we chose, and visible; mac:
   * still at the desktop level and visible) and the coverage at that moment (analytics).
   */
  | {
      type: 'first-frame';
      sinceStartMs: number;
      verified?: boolean;
      hidden?: boolean;
      covered?: boolean;
      paused?: boolean;
      /** validate() reasons, closed set (hostTelemetry verifyReasonList). */
      reasons?: string[];
    }
  /** 261105: display and GPU facts for analytics (at start and on a display change). */
  | {
      type: 'facts';
      displays: number;
      scale: number;
      widthPx: number;
      heightPx: number;
      gpu: string;
      hwAccel: boolean;
      /** 261110: the primary display's refresh rate (Hz), 0 when unknown. */
      refreshHz?: number;
      /** 261110: when it was read (at start the GPU process may not be up yet). */
      when?: 'start' | 'first_frame' | 'gpu_update' | 'display';
    }
  /** 261110: one of the host's shape-only counts (SEILINK_HOST_COUNT_KEYS), for seilink_ended. */
  | { type: 'count'; key: SeilinkHostCountKey }
  /**
   * 261105: a post-attach check found something wrong that a re-attach does not report (the
   * room window hidden while still parented, mac window not visible). Once per distinct set.
   */
  | { type: 'verify-failed'; reasons: string[]; trigger: string }
  | { type: 'activity'; covered: boolean; paused: boolean; fps: number; reason: string }
  | { type: 'click'; kind: 'click' | 'dblclick' }
  /** Her box and (M4) the dock buttons, in screen coordinates (top-left points). */
  | {
      type: 'box';
      screen: { x: number; y: number; w: number; h: number } | null;
      dock?: Array<{ id: SeilinkDockAction; x: number; y: number; w: number; h: number }>;
    }
  /** M4: a dock action the user pressed (and confirmed, for move out). */
  | { type: 'dock'; action: SeilinkDockAction }
  | {
      type: 'heartbeat';
      fps: number;
      frames: number;
      effectiveFps: number;
      covered: boolean;
      paused: boolean;
      attached: boolean;
      cpu: number;
      ramMB: number;
    }
  /** Answer to `ping`. */
  | { type: 'pong'; seq: number }
  | { type: 'log'; level: 'info' | 'warn'; msg: string }
  /** An avatar bridge call from the page (see SEILINK_HOST_AVATAR_METHODS). */
  | { type: 'call'; id: number; method: SeilinkHostAvatarMethod; args: unknown[] };

export function encodeLine(msg: ToHost | FromHost): string {
  return JSON.stringify(msg) + '\n';
}

/** A reader for one connection: feed it chunks, get whole parsed objects. Bad lines are skipped. */
export function createLineReader(onMessage: (msg: Record<string, unknown>) => void, maxLine = 4 * 1024 * 1024): (chunk: string) => void {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    if (buf.length > maxLine && buf.indexOf('\n') < 0) {
      // A runaway line: drop it rather than grow forever.
      buf = '';
      return;
    }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m: unknown;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string') onMessage(m as Record<string, unknown>);
    }
  };
}

/**
 * Pipe / socket path for one host session of this main process. `session` makes it unique per
 * session, so a session never deletes (mac) or collides with (Windows EADDRINUSE) the path of
 * the one before it while that one is still closing.
 */
export function hostPipePath(
  platform: NodeJS.Platform,
  pid: number,
  tmpdir: string,
  joinPath: (...p: string[]) => string,
  session = 0,
): string {
  const name = `sei-seilink-${pid}-${session}`;
  return platform === 'win32' ? `\\\\.\\pipe\\${name}` : joinPath(tmpdir, `${name}.sock`);
}
