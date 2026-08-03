/**
 * Updater log sink — `<userData>/logs/updater.log`.
 *
 * WHY THIS EXISTS (260803). A Windows user's update from 0.4.3 to 0.5.2 failed
 * for eight days with no diagnosable trace anywhere on the machine. The
 * installer downloaded byte-perfectly, electron-updater rejected it in
 * `verifySignature`, logged
 *
 *   Sign verification failed, installer signed with incorrect certificate: ...
 *
 * deleted the download, and emitted `error`. That one warning was the entire
 * explanation, and it went to `console.warn` — electron-updater's DEFAULT
 * logger is bare `console`, and this app never overrode it. In a packaged
 * Windows build there is no console attached, so the line evaporated. The
 * app's own `logs/` directory had not been written to in three weeks, because
 * `logRouter` is per-BOT-SESSION and the updater never opens one.
 *
 * The cause was only ever recovered by putting a filesystem monitor on the
 * updater cache directory and catching the delete in the act. That is not a
 * support path. Anything the updater knows now lands on disk, synchronously,
 * before the process can quit or restart out from under it.
 *
 * Deliberately standalone rather than reusing `logRouter`: that router is
 * keyed on a character session and batches over IPC to the in-app LogsBar,
 * neither of which the updater has or wants. The volume here is a handful of
 * lines per launch.
 */
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { paths } from './paths';

/** Truncate the file once it passes this, so it can never grow unbounded. */
const MAX_BYTES = 512 * 1024;

let filePath: string | null = null;
/** Set once the sink has failed, so a broken disk cannot spam the console. */
let disabled = false;

function ensureFile(): string | null {
  if (disabled) return null;
  if (filePath) return filePath;
  try {
    const dir = paths.logsDir();
    mkdirSync(dir, { recursive: true });
    const full = path.join(dir, 'updater.log');
    try {
      if (statSync(full).size > MAX_BYTES) truncateSync(full, 0);
    } catch {
      /* absent or unreadable — appendFileSync will create it */
    }
    filePath = full;
    return filePath;
  } catch {
    // No writable log dir. Console-only is still better than throwing out of
    // an updater callback, which would surface as an unhandled rejection.
    disabled = true;
    return null;
  }
}

/**
 * Format whatever electron-updater passes. It calls its logger with strings,
 * Errors and plain objects interchangeably, so this must never throw on an
 * odd shape or on a circular structure.
 */
function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function write(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', value: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${format(value)}\n`;
  const full = ensureFile();
  if (!full) return;
  try {
    // Synchronous on purpose: `quitAndInstall` and the forced-restart path can
    // end the process immediately after a log call, and a queued async write
    // would be lost exactly when the reason for the restart matters most.
    appendFileSync(full, line);
  } catch {
    disabled = true;
  }
}

/**
 * Matches electron-updater's `Logger` interface, and tees to the console so
 * `npm run dev` behaves as before. Assigned to `autoUpdater.logger` in
 * `ensureAutoUpdater()`, and used for this module's own lines too.
 */
export const updaterLog = {
  info: (m: unknown): void => {
    console.log(`[sei] ${format(m)}`);
    write('INFO', m);
  },
  warn: (m: unknown): void => {
    console.warn(`[sei] ${format(m)}`);
    write('WARN', m);
  },
  error: (m: unknown): void => {
    console.error(`[sei] ${format(m)}`);
    write('ERROR', m);
  },
  debug: (m: unknown): void => {
    // electron-updater is chatty at debug (per-chunk progress). File only.
    write('DEBUG', m);
  },
};

/** Absolute path of the log, for the diagnostics bundle. Null if unwritable. */
export function updaterLogPath(): string | null {
  return ensureFile();
}
