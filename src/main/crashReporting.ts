/**
 * Crash, hang and unclean-exit reporting (261031, T278, scale plan C4).
 *
 * No paid service and no minidump upload. Three layers:
 *
 *   1. The session marker (sessionMarker.ts). Written `open` at launch, kept
 *      current by a heartbeat and the surface in use, rewritten `closed` on a
 *      clean quit (`os_shutdown` on Windows log-off / OS shutdown). The NEXT
 *      launch reads it first: a marker still `open` means the previous session
 *      died without quitting (a main-process crash, a force quit of a hung
 *      app, a kill, a power loss), reported as `app_unclean_exit` with that
 *      session's version, uptime and last surface. `app_opened` carries
 *      `prev_exit` + `prev_version`, so crash-free sessions per version is one
 *      query (crashfree.mjs in the reports repo).
 *   2. Live handlers. Main `uncaughtException` (`app_crash`, kind
 *      `main_uncaught`) and `unhandledRejection` (`app_error`), a renderer that
 *      died (`render-process-gone`, `app_crash` kind `renderer_gone`), a GPU or
 *      utility process that died (`child-process-gone`, kind `child_gone`;
 *      companion bots are skipped there, `summon_failed` /
 *      `bot_session_failed` already cover them), and a window that stopped
 *      responding (`unresponsive` → `app_hang` once it recovers or closes).
 *      A hung MAIN process cannot report itself; it shows up next launch as
 *      an unclean exit.
 *   3. The crash log (crashLog.ts): `<userData>/logs/crash/crash.log`, every
 *      entry scrubbed through diagnostics.redact(), rotated at 256 KB.
 *
 * Events are shape only: kinds, Electron's reason enums, exit codes, the
 * error's class name, a 12-hex fingerprint and the top frame's file:line. No
 * message or stack text ever reaches PostHog; it stays in the local log.
 * Every capture goes through analytics.capture(), so the opt-out and the
 * dev/test-build send gate apply. Bounded per process (CRASH_EVENT_CAP).
 *
 * `createCrashReporter` is the core: no electron calls, injected capture and
 * clock (crashReporting.test.ts). `initCrashReporting` wires it to the app,
 * once, first thing in whenReady.
 */
import { app, powerMonitor } from 'electron';
import path from 'node:path';
import { bakedChannel, processSessionId, resolveChannel } from './analyticsContext';
import { loadAnalytics } from './lazyAnalytics';
import { paths } from './paths';
import {
  appendCrashLog,
  cleanErrorName,
  errorFingerprint,
  errorParts,
  topFrame,
  type CrashEntry,
} from './crashLog';
import {
  createSessionMarker,
  readPreviousSession,
  uncleanExitProps,
  SESSION_MARKER_FILE,
  type PrevExit,
  type PreviousSession,
} from './sessionMarker';

/** At most this many crash/error/hang events per process, whatever happens. */
export const CRASH_EVENT_CAP = 20;
/** Of those, at most this many `app_error` (unhandled rejections are the noisy kind). */
export const ERROR_EVENT_CAP = 5;
/** Repeats of one fingerprint written to the crash log before it goes quiet. */
export const CRASH_LOG_REPEATS = 5;
/** Heartbeat cadence: the resolution of a crashed session's uptime. */
export const HEARTBEAT_MS = 60_000;

export type CaptureFn = (event: string, props: Record<string, unknown>) => void;

export interface CrashReporterDeps {
  /** `<userData>/logs/crash`. */
  crashDir: string;
  /** `<userData>/session.json`. */
  markerFile: string;
  version: string;
  channel: string;
  packaged: boolean;
  sessionId: string;
  capture: CaptureFn;
  /** The surface in use right now (analytics.currentSurface). */
  surface?: () => string | null;
  now?: () => number;
  /** Console echo for developers; never throws. */
  log?: (line: string) => void;
}

export interface RendererGoneInfo {
  reason: string;
  exitCode: number;
  /** Which page died: the html file name ('index', 'overlay', ...). */
  page: string;
}

export interface ChildGoneInfo {
  type: string;
  reason: string;
  exitCode: number;
  serviceName?: string;
  name?: string;
}

export interface CrashReporter {
  readonly previous: PreviousSession;
  /** `{prev_exit, prev_version}` for app_opened. */
  appOpenedProps(): { prev_exit: PrevExit; prev_version: string | null };
  onUncaught(err: unknown): void;
  onRejection(reason: unknown): void;
  onRendererGone(info: RendererGoneInfo): void;
  onChildGone(info: ChildGoneInfo): void;
  onUnresponsive(windowKey: number, page: string): void;
  onResponsive(windowKey: number): void;
  /** A window closed; a hang still open on it ends unrecovered. */
  onWindowClosed(windowKey: number): void;
  noteSurface(surface: string): void;
  heartbeat(): void;
  close(state: 'closed' | 'os_shutdown'): void;
}

/** Electron reason enums ('crashed', 'oom', 'abnormal-exit', ...) as a safe token. */
export function cleanToken(raw: unknown, max = 32): string {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  return /^[a-z0-9_.]{1,64}$/.test(s) ? s.slice(0, max) : 'unknown';
}

/** A page's html file name from its URL: `.../overlay.html#x` → 'overlay'; dev server root → 'index'. */
export function pageName(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').pop() ?? '';
    const name = base.replace(/\.html?$/i, '');
    if (!name) return u.protocol === 'about:' ? 'blank' : 'index';
    return /^[A-Za-z0-9_-]{1,32}$/.test(name) ? name.toLowerCase() : 'other';
  } catch {
    return 'unknown';
  }
}

/**
 * The child process's service as a closed-ish token. Our bots are
 * `sei-bot-<characterId>`: the id is stripped. Chromium's own services
 * (`network.mojom.NetworkService`, `audio.mojom.AudioService`) pass as is.
 */
export function serviceToken(serviceName: string | undefined, name: string | undefined): string | null {
  const raw = (serviceName || name || '').trim();
  if (!raw) return null;
  if (raw.startsWith('sei-bot')) return 'sei_bot';
  return /^[A-Za-z0-9 ._-]{1,64}$/.test(raw) && !/\d{3,}|[0-9a-f]{8,}/i.test(raw) ? raw.slice(0, 64) : 'other';
}

export function isCompanionBot(info: ChildGoneInfo): boolean {
  return serviceToken(info.serviceName, info.name) === 'sei_bot';
}

export function createCrashReporter(deps: CrashReporterDeps): CrashReporter {
  const now = deps.now ?? Date.now;
  const log = (line: string): void => {
    try {
      deps.log?.(line);
    } catch {
      /* ignore */
    }
  };
  const startedAt = now();
  const previous = readPreviousSession(deps.markerFile);
  const marker = createSessionMarker(deps.markerFile, {
    sessionId: deps.sessionId,
    version: deps.version,
    channel: deps.channel,
    packaged: deps.packaged,
    now: startedAt,
  });
  marker.open();

  let events = 0;
  let errorEvents = 0;
  const seen = new Set<string>();
  const logRepeats = new Map<string, number>();
  const hangs = new Map<number, { since: number; page: string }>();
  let closed = false;

  const surface = (): string => {
    try {
      return deps.surface?.() ?? 'none';
    } catch {
      return 'none';
    }
  };

  function writeLog(key: string, entry: Omit<CrashEntry, 'version'>): void {
    const n = (logRepeats.get(key) ?? 0) + 1;
    logRepeats.set(key, n);
    if (n > CRASH_LOG_REPEATS) return;
    const details = n === CRASH_LOG_REPEATS ? { ...entry.details, further_repeats: 'not_logged' } : entry.details;
    appendCrashLog(deps.crashDir, { ...entry, details, version: deps.version, at: now() });
  }

  /** Capture once per dedupe key, within the per-process cap. */
  function emit(event: string, key: string, props: Record<string, unknown>): void {
    if (seen.has(key) || events >= CRASH_EVENT_CAP) return;
    if (event === 'app_error' && errorEvents >= ERROR_EVENT_CAP) return;
    seen.add(key);
    events++;
    if (event === 'app_error') errorEvents++;
    try {
      deps.capture(event, { ...props, surface: surface(), uptime_ms: Math.max(0, now() - startedAt) });
    } catch {
      /* analytics is never load-bearing */
    }
  }

  function noteCrashKind(kind: string): void {
    marker.update({ crash_kind: kind }, now());
  }

  // The previous session died open: say so now, from this launch.
  if (previous.prevExit === 'unclean' && previous.marker) {
    const props = uncleanExitProps(previous.marker);
    appendCrashLog(deps.crashDir, {
      kind: 'unclean_exit',
      process: 'main',
      version: deps.version,
      at: startedAt,
      details: {
        prev_version: props.prev_version as string,
        prev_uptime_ms: props.prev_uptime_ms as number,
        prev_surface: props.prev_surface as string,
        prev_renderer_unresponsive: props.prev_renderer_unresponsive as boolean,
        prev_crash_kind: (props.prev_crash_kind as string | null) ?? undefined,
      },
    });
    try {
      deps.capture('app_unclean_exit', props);
    } catch {
      /* never load-bearing */
    }
  }

  function errorEvent(event: 'app_crash' | 'app_error', kind: string, err: unknown): void {
    const { name, message, stack } = errorParts(err);
    const errorName = cleanErrorName(name);
    const fingerprint = errorFingerprint(errorName, message, stack);
    const frame = topFrame(stack);
    log(`[sei] ${kind}: ${errorName}: ${message.split('\n')[0].slice(0, 300)}`);
    writeLog(`${kind}:${fingerprint}`, {
      kind,
      process: 'main',
      message: `${errorName}: ${message}`,
      stack,
      details: { fingerprint },
    });
    emit(event, `${kind}:${fingerprint}`, {
      kind,
      process_type: 'main',
      error_name: errorName,
      fingerprint,
      top_frame: frame,
    });
  }

  return {
    previous,
    appOpenedProps() {
      return { prev_exit: previous.prevExit, prev_version: previous.marker?.version ?? null };
    },
    onUncaught(err) {
      errorEvent('app_crash', 'main_uncaught', err);
      noteCrashKind('main_uncaught');
    },
    onRejection(reason) {
      errorEvent('app_error', 'main_unhandled_rejection', reason);
    },
    onRendererGone(info) {
      const reason = cleanToken(info.reason);
      if (reason === 'clean_exit') return;
      const page = /^[a-z0-9_-]{1,32}$/.test(info.page) ? info.page : 'other';
      const exitCode = Number.isFinite(info.exitCode) ? Math.trunc(info.exitCode) : null;
      log(`[sei] renderer gone: page=${page} reason=${reason} exit_code=${exitCode}`);
      writeLog(`renderer_gone:${page}:${reason}`, {
        kind: 'renderer_gone',
        process: 'renderer',
        details: { page, reason, exit_code: exitCode },
      });
      emit('app_crash', `renderer_gone:${page}:${reason}:${exitCode}`, {
        kind: 'renderer_gone',
        process_type: 'renderer',
        page,
        reason,
        exit_code: exitCode,
      });
      noteCrashKind('renderer_gone');
    },
    onChildGone(info) {
      const reason = cleanToken(info.reason);
      if (reason === 'clean_exit') return;
      const processType = cleanToken(info.type);
      const service = serviceToken(info.serviceName, info.name);
      const exitCode = Number.isFinite(info.exitCode) ? Math.trunc(info.exitCode) : null;
      // A companion bot's exit is the supervisor's to report (and a stop that
      // timed out is a deliberate kill). Local log only, and only real crashes.
      if (service === 'sei_bot') {
        if (reason !== 'killed') {
          writeLog(`bot_gone:${reason}:${exitCode}`, {
            kind: 'bot_gone',
            process: 'utility',
            details: { reason, exit_code: exitCode },
          });
        }
        return;
      }
      log(`[sei] child process gone: type=${processType} service=${service} reason=${reason} exit_code=${exitCode}`);
      writeLog(`child_gone:${processType}:${service}:${reason}`, {
        kind: 'child_gone',
        process: processType,
        details: { service: service ?? undefined, reason, exit_code: exitCode },
      });
      emit('app_crash', `child_gone:${processType}:${service}:${reason}:${exitCode}`, {
        kind: 'child_gone',
        process_type: processType,
        service,
        reason,
        exit_code: exitCode,
      });
      noteCrashKind('child_gone');
    },
    onUnresponsive(windowKey, page) {
      if (hangs.has(windowKey)) return;
      const safePage = /^[a-z0-9_-]{1,32}$/.test(page) ? page : 'other';
      hangs.set(windowKey, { since: now(), page: safePage });
      log(`[sei] window unresponsive: page=${safePage}`);
      writeLog(`unresponsive:${safePage}`, { kind: 'renderer_unresponsive', process: 'renderer', details: { page: safePage } });
      marker.update({ renderer_unresponsive: true }, now());
    },
    onResponsive(windowKey) {
      endHang(windowKey, true);
    },
    onWindowClosed(windowKey) {
      endHang(windowKey, false);
    },
    noteSurface(s) {
      marker.update({ surface: s }, now());
    },
    heartbeat() {
      marker.update({}, now());
    },
    close(state) {
      if (closed) return;
      closed = true;
      marker.close(state, now());
    },
  };

  function endHang(windowKey: number, recovered: boolean): void {
    const hang = hangs.get(windowKey);
    if (!hang) return;
    hangs.delete(windowKey);
    const durationMs = Math.max(0, now() - hang.since);
    // One app_hang per page and outcome; the duration of the first is the signal.
    emit('app_hang', `hang:${hang.page}:${recovered}`, {
      page: hang.page,
      duration_ms: durationMs,
      recovered,
    });
    if (hangs.size === 0) marker.update({ renderer_unresponsive: false }, now());
  }
}

// ── Electron wiring ──────────────────────────────────────────────────────────

let reporter: CrashReporter | null = null;

/** The live reporter, null before initCrashReporting (or when it failed). */
export function crashReporter(): CrashReporter | null {
  return reporter;
}

/** `{prev_exit, prev_version}` for app_opened; `prev_exit: 'none'` when reporting never started. */
export function appOpenedCrashProps(): { prev_exit: PrevExit | 'unknown'; prev_version: string | null } {
  return reporter ? reporter.appOpenedProps() : { prev_exit: 'unknown', prev_version: null };
}

/**
 * Wire crash reporting to the app. Call once, first thing in whenReady
 * (userData is final by then). Synchronous and never throws: a failure here
 * leaves the app exactly as it was without it.
 */
export function initCrashReporting(): void {
  if (reporter) return;
  try {
    initInner();
  } catch (err) {
    console.warn(`[sei] crash reporting init failed: ${(err as Error).message}`);
  }
}

function initInner(): void {
  const version = safe(() => app.getVersion(), '0.0.0');
  const packaged = safe(() => app.isPackaged === true, false);
  const channel = resolveChannel({ packaged, baked: bakedChannel(), version });
  const userData = paths.userData();
  const r = createCrashReporter({
    crashDir: path.join(paths.logsDir(), 'crash'),
    markerFile: path.join(userData, SESSION_MARKER_FILE),
    version,
    channel,
    packaged,
    sessionId: processSessionId(),
    capture: (event, props) => {
      void loadAnalytics()
        .then((a) => a.capture(event, props))
        .catch(() => {});
    },
    surface: () => currentSurfaceSync,
    log: (line) => console.warn(line),
  });
  reporter = r;

  // The surface in use, mirrored into the marker so an unclean exit says
  // what the player was doing. analytics owns the vocabulary.
  void loadAnalytics()
    .then((a) => {
      currentSurfaceSync = a.currentSurface();
      a.onSurfaceChange((s) => {
        currentSurfaceSync = s;
        r.noteSurface(s);
      });
    })
    .catch(() => {});

  const beat = setInterval(() => r.heartbeat(), HEARTBEAT_MS);
  beat.unref?.();

  // Installing these replaces Electron's default (an error dialog, after
  // which the app keeps running anyway): the app keeps running, quietly, and
  // the error is logged and counted instead of lost.
  process.on('uncaughtException', (err) => guard(() => r.onUncaught(err)));
  process.on('unhandledRejection', (reason) => guard(() => r.onRejection(reason)));

  app.on('render-process-gone', (_e, webContents, details) => {
    r.onRendererGone({
      reason: details.reason,
      exitCode: details.exitCode,
      page: safe(() => pageName(webContents.getURL()), 'unknown'),
    });
  });
  app.on('child-process-gone', (_e, details) => {
    r.onChildGone({
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name,
    });
  });

  app.on('browser-window-created', (_e, win) => {
    const key = win.id;
    win.on('unresponsive', () => r.onUnresponsive(key, safe(() => pageName(win.webContents.getURL()), 'unknown')));
    win.on('responsive', () => r.onResponsive(key));
    win.on('closed', () => r.onWindowClosed(key));
    // Windows log-off / shutdown reaches every top-level window.
    win.on('session-end', () => r.close('os_shutdown'));
  });
  try {
    powerMonitor.on('shutdown', () => r.close('os_shutdown'));
  } catch {
    /* not available on this platform */
  }

  // A clean quit. before-quit for the ordinary paths (Cmd+Q, the tray, an
  // update's quitAndInstall); 'quit' as the fallback, because the teardown
  // chain ends in app.exit(0), which still emits it.
  app.on('before-quit', () => r.close('closed'));
  app.on('quit', () => r.close('closed'));
}

let currentSurfaceSync: string | null = null;

function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    /* a crash handler must never throw */
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
