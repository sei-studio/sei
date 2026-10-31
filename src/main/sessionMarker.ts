/**
 * The "session open" marker (261031, T278, scale plan C4).
 *
 * A crash that kills the main process sends nothing: 37% of October's app
 * opens never sent an `app_quit`, and a crash could not be told from a force
 * quit or a Windows shutdown. So each launch writes `<userData>/session.json`
 * with `state: 'open'` and what it is (session id, version, channel, start
 * time), keeps a heartbeat and the surface in use current in it, rewrites it
 * as `state: 'closing'` when a quit starts (before-quit) and `'closed'` once
 * the process actually exits ('quit', after the teardown). `'os_shutdown'`
 * when Windows logs off or the OS shuts down, `'start_failed'` when bootstrap
 * failed and the app exited with an error. The NEXT launch reads it before
 * writing its own (prev_exit in brackets):
 *
 *   state 'open'         [unclean] the previous session died without
 *                        quitting: a crash, a hang the user force-quit, a
 *                        kill, a power loss.
 *   state 'closing'      [quit_hang] a quit started and never finished: the
 *                        teardown hung and the process was killed.
 *   state 'start_failed' [start_failed] bootstrap threw; the app exited 1.
 *                        These three are reported as `app_unclean_exit` with
 *                        the previous session's version, uptime and surface.
 *   state 'closed'       [clean] a clean quit.
 *   state 'os_shutdown'  [os_shutdown] the OS ended it; not counted as a crash.
 *   no / unreadable file [none] the first launch with this code (or a wiped
 *                        userData).
 *
 * Device-global (one per userData, not per profile): the process is what
 * crashes, whoever is signed in. Pure node fs, synchronous on purpose (the
 * clean-quit write must land before the process exits), atomic tmp+rename,
 * never throws. Unit-tested in sessionMarker.test.ts.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SESSION_MARKER_FILE = 'session.json';

export type MarkerState = 'open' | 'closing' | 'closed' | 'os_shutdown' | 'start_failed';
/** A terminal state close() can record. */
export type EndState = 'closed' | 'os_shutdown' | 'start_failed';
export type PrevExit = 'clean' | 'unclean' | 'quit_hang' | 'start_failed' | 'os_shutdown' | 'none';

const PREV_EXIT: Record<MarkerState, PrevExit> = {
  open: 'unclean',
  closing: 'quit_hang',
  start_failed: 'start_failed',
  closed: 'clean',
  os_shutdown: 'os_shutdown',
};

/** The previous session ended badly: reported as app_unclean_exit, not crash-free. */
export function isBadExit(prevExit: PrevExit): boolean {
  return prevExit === 'unclean' || prevExit === 'quit_hang' || prevExit === 'start_failed';
}

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
  /** When the quit started (before-quit). */
  closing_at?: number;
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
    typeof m.state === 'string' &&
    Object.prototype.hasOwnProperty.call(PREV_EXIT, m.state) &&
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
    return { prevExit: PREV_EXIT[parsed.state], marker: parsed };
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
 * and rewrites it (heartbeat, surface, hang flag); `closing()` marks a quit
 * that has started (updates still land, so a hung teardown keeps its
 * heartbeat); `close()` records the end (a clean exit, an OS shutdown, a
 * failed start), after which further updates are ignored so a late heartbeat
 * cannot reopen it.
 */
export interface SessionMarkerHandle {
  open(): void;
  update(patch: Partial<Pick<SessionMarker, 'surface' | 'renderer_unresponsive' | 'crash_kind'>>, now?: number): void;
  closing(now?: number): void;
  close(state: EndState, now?: number): void;
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
    closing(now = Date.now()) {
      if (ended || marker.state !== 'open') return;
      marker = { ...marker, state: 'closing', closing_at: now, last_beat_at: Math.max(marker.last_beat_at, now) };
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

/** The `app_unclean_exit` props for a previous session that ended badly (isBadExit). Shape only. */
export function uncleanExitProps(marker: SessionMarker): Record<string, string | number | boolean | null> {
  return {
    prev_exit: PREV_EXIT[marker.state],
    prev_session_id: marker.session_id,
    prev_version: marker.version,
    prev_channel: typeof marker.channel === 'string' ? marker.channel : null,
    prev_packaged: marker.packaged === true,
    prev_uptime_ms: Math.max(0, Math.round(marker.last_beat_at - marker.started_at)),
    prev_surface: typeof marker.surface === 'string' ? marker.surface : 'none',
    prev_renderer_unresponsive: marker.renderer_unresponsive === true,
    prev_crash_kind: typeof marker.crash_kind === 'string' ? marker.crash_kind : null,
    prev_started_at: new Date(marker.started_at).toISOString(),
    // A hung quit: how long the teardown had been running at the last
    // heartbeat (HEARTBEAT_MS resolution).
    ...(marker.state === 'closing' && typeof marker.closing_at === 'number'
      ? { prev_quit_wait_ms: Math.max(0, Math.round(marker.last_beat_at - marker.closing_at)) }
      : {}),
  };
}
