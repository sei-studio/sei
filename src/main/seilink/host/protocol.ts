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
import type { AvatarManifest } from '../../../shared/ipc';
import type { SeilinkDockAction, SeilinkHostAvatarMethod, SeilinkHostFailure, SeilinkHostRoom } from '../../../shared/seilinkHost';

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
  /** M4: the dock's state (her idle lines muted). */
  | { type: 'dock-state'; deafened: boolean }
  /** M4: a line she says on the desktop (a bubble near her). */
  | { type: 'line'; text: string; kind: 'idle' | 'poke' }
  /** Hold the room still (a future dock "pause"). */
  | { type: 'set-paused'; paused: boolean }
  | { type: 'quit' }
  /** CI self-test hosts only (--seilink-test): wedge the main thread for `ms`. */
  | { type: 'test-hang'; ms: number };

/** Host -> main. */
export type FromHost =
  | { type: 'hello'; pid: number; token: string }
  | { type: 'attached'; reattach: boolean; reason: string; layout: string; method?: string; attachMs: number }
  | { type: 'attach-failed'; failure: SeilinkHostFailure; detail: string }
  | { type: 'first-frame'; sinceStartMs: number }
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

/** Pipe / socket path for this main process. */
export function hostPipePath(platform: NodeJS.Platform, pid: number, tmpdir: string, joinPath: (...p: string[]) => string): string {
  return platform === 'win32' ? `\\\\.\\pipe\\sei-seilink-${pid}` : joinPath(tmpdir, `sei-seilink-${pid}.sock`);
}
