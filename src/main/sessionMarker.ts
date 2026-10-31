/**
 * The "session open" marker (261031, T278, scale plan C4).
 *
 * A crash that kills the main process sends nothing: 37% of October's app
 * opens never sent an `app_quit`, and a crash could not be told from a force
 * quit or a Windows shutdown. So each launch writes `<userData>/session.json`
 * with `state: 'open'` and what it is (session id, version, channel, start
 * time), keeps a heartbeat and the surface in use current in it, and rewrites
 * it as `state: 'closed'` on a clean quit (`'os_shutdown'` when Windows logs
 * off or the OS shuts down). The NEXT launch reads it before writing its own:
 *
 *   state 'open'         the previous session died without quitting: a crash,
 *                        a hang the user force-quit, a kill, a power loss.
 *                        Reported as `app_unclean_exit` with the previous
 *                        session's version, uptime and last surface.
 *   state 'closed'       a clean quit.
 *   state 'os_shutdown'  the OS ended it; not counted as a crash.
 *   no / unreadable file the first launch with this code (or a wiped
 *                        userData): 'none'.
 *
 * Device-global (one per userData, not per profile): the process is what
 * crashes, whoever is signed in. Pure node fs, synchronous on purpose (the
 * clean-quit write must land before the process exits), atomic tmp+rename,
 * never throws. Unit-tested in sessionMarker.test.ts.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SESSION_MARKER_FILE = 'session.json';

export type MarkerState = 'open' | 'closed' | 'os_shutdown';
export type PrevExit = 'clean' | 'unclean' | 'os_shutdown' | 'none';

export interface SessionMarker {
  v: 1;
  state: MarkerState;
  session_id: string;
  version: string;
  channel: string;
  packaged: boolean;
  started_at: number;
  /** Last heartbeat (or any update). Uptime of a crashed session = last_beat_at - started_at. */
  last_beat_at: number;
  /** Product surface in use at the last update (analytics surfaceForEvent vocabulary). */
  surface: string | null;
  /** The main window's renderer was unresponsive at the last update (a hang). */
  renderer_unresponsive?: boolean;
  /** The last app_crash kind this session reported, if any. */
  crash_kind?: string | null;
  /** When the clean quit / shutdown was recorded. */
  ended_at?: number;
}

export interface PreviousSession {
  prevExit: PrevExit;
  marker: SessionMarker | null;
}

function isMarker(v: unknown): v is SessionMarker {
  if (!v || typeof v !== 'object') return false;
  const m = v as Partial<SessionMarker>;
  return (
    m.v === 1 &&
    (m.state === 'open' || m.state === 'closed' || m.state === 'os_shutdown') &&
    typeof m.session_id === 'string' &&
    typeof m.version === 'string' &&
    typeof m.started_at === 'number' &&
    typeof m.last_beat_at === 'number'
  );
}

/** Read the previous launch's marker and classify how that session ended. */
export function readPreviousSession(file: string): PreviousSession {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { prevExit: 'none', marker: null };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isMarker(parsed)) return { prevExit: 'none', marker: null };
    const prevExit: PrevExit = parsed.state === 'open' ? 'unclean' : parsed.state === 'closed' ? 'clean' : 'os_shutdown';
    return { prevExit, marker: parsed };
  } catch {
    // A torn write can only come from a process that died mid-write.
    return { prevExit: 'none', marker: null };
  }
}

export function writeMarker(file: string, marker: SessionMarker): boolean {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp.${process.pid}`);
  const body = JSON.stringify(marker);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    // On Windows a rename over a file an antivirus or indexer has open fails
    // with EPERM/EBUSY. A lost `closed` write would read as a crash next
    // launch, so write in place instead: a write torn by dying right here
    // parses as 'none', never as 'unclean'.
    try {
      writeFileSync(file, body, 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The live marker for this process. `open()` writes it; `update()` patches
 * and rewrites it (heartbeat, surface, hang flag); `close()` records a clean
 * quit or an OS shutdown, after which further updates are ignored so a late
 * heartbeat cannot reopen it.
 */
export interface SessionMarkerHandle {
  open(): void;
  update(patch: Partial<Pick<SessionMarker, 'surface' | 'renderer_unresponsive' | 'crash_kind'>>, now?: number): void;
  close(state: 'closed' | 'os_shutdown', now?: number): void;
  current(): SessionMarker;
}

export function createSessionMarker(
  file: string,
  init: { sessionId: string; version: string; channel: string; packaged: boolean; now?: number },
): SessionMarkerHandle {
  const startedAt = init.now ?? Date.now();
  let marker: SessionMarker = {
    v: 1,
    state: 'open',
    session_id: init.sessionId,
    version: init.version,
    channel: init.channel,
    packaged: init.packaged,
    started_at: startedAt,
    last_beat_at: startedAt,
    surface: null,
  };
  let ended = false;
  return {
    open() {
      writeMarker(file, marker);
    },
    update(patch, now = Date.now()) {
      if (ended) return;
      marker = { ...marker, ...patch, last_beat_at: Math.max(marker.last_beat_at, now) };
      writeMarker(file, marker);
    },
    close(state, now = Date.now()) {
      // An OS shutdown can be followed by the normal quit path; keep the first.
      if (ended) return;
      ended = true;
      marker = { ...marker, state, last_beat_at: Math.max(marker.last_beat_at, now), ended_at: now };
      writeMarker(file, marker);
    },
    current() {
      return { ...marker };
    },
  };
}

/** The `app_unclean_exit` props for a previous session that died open. Shape only. */
export function uncleanExitProps(marker: SessionMarker): Record<string, string | number | boolean | null> {
  return {
    prev_session_id: marker.session_id,
    prev_version: marker.version,
    prev_channel: typeof marker.channel === 'string' ? marker.channel : null,
    prev_packaged: marker.packaged === true,
    prev_uptime_ms: Math.max(0, Math.round(marker.last_beat_at - marker.started_at)),
    prev_surface: typeof marker.surface === 'string' ? marker.surface : 'none',
    prev_renderer_unresponsive: marker.renderer_unresponsive === true,
    prev_crash_kind: typeof marker.crash_kind === 'string' ? marker.crash_kind : null,
    prev_started_at: new Date(marker.started_at).toISOString(),
  };
}
