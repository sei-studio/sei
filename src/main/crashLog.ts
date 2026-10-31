/**
 * Local crash / error log (261031, T278, scale plan C4).
 *
 * `<userData>/logs/crash/crash.log`, one block per crash or error: time,
 * version, kind, process, and the scrubbed message + stack. Bounded: when the
 * file passes CRASH_LOG_MAX_BYTES it rotates to crash.1.log (the previous
 * crash.1.log is dropped), so the two files never hold more than about
 * 2 x 256 KB. It lives in a SUBdirectory on purpose: pruneLogsDir only prunes
 * the top level of logs/, so bot session logs can never rotate it away.
 *
 * Everything written goes through diagnostics.redact() first (keys, tokens,
 * emails, IPs, home paths, chat content, player names), plus the player's own
 * Minecraft username and preferred name (setCrashRedactNames). The log never
 * leaves the machine by itself; a user can attach it to a bug report.
 *
 * Also owns the pure helpers the PostHog side uses: errorFingerprint (a short
 * stable hash of the error's shape) and topFrame (`file.js:line:col` of the
 * first stack frame, path stripped). No electron import: unit-tested in
 * crashLog.test.ts.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { redact } from './diagnostics';

export const CRASH_LOG_MAX_BYTES = 256 * 1024;
export const CRASH_LOG_FILE = 'crash.log';
export const CRASH_LOG_ROTATED = 'crash.1.log';
/** Per-entry cap after scrubbing, so one huge stack cannot fill the file. */
export const CRASH_ENTRY_MAX_CHARS = 8 * 1024;

let extraNames: string[] = [];

/** The player's own names (mc_username, preferred_name), scrubbed to [player] everywhere. */
export function setCrashRedactNames(names: ReadonlyArray<string | null | undefined>): void {
  extraNames = names.filter((n): n is string => typeof n === 'string' && n.trim().length >= 3).map((n) => n.trim());
}

export function crashRedactNames(): readonly string[] {
  return extraNames;
}

/** redact() plus the player's own names. */
export function scrubCrashText(text: string): string {
  return redact(text ?? '', { playerNames: extraNames });
}

export interface CrashEntry {
  kind: string;
  process: string;
  version: string;
  /** Free text: already-scrubbed or not, it is scrubbed again here. */
  message?: string;
  stack?: string;
  /** Small scalar context (reason, exit code, ...). */
  details?: Record<string, string | number | boolean | null | undefined>;
  at?: number;
}

/** One log block. Pure; exported for tests. */
export function formatCrashEntry(e: CrashEntry): string {
  const at = new Date(e.at ?? Date.now()).toISOString();
  const details = Object.entries(e.details ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  const head = `[${at}] ${e.kind} process=${e.process} version=${e.version}${details ? ` ${details}` : ''}`;
  const body = [e.message, e.stack && e.stack !== e.message ? e.stack : '']
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join('\n');
  const text = scrubCrashText(body ? `${head}\n${body}` : head);
  const capped = text.length > CRASH_ENTRY_MAX_CHARS ? `${text.slice(0, CRASH_ENTRY_MAX_CHARS)}\n[truncated]` : text;
  return `${capped}\n\n`;
}

/**
 * Append one entry, rotating first when the file is over the cap.
 * Synchronous (a crash handler may be the last code that runs) and never
 * throws.
 */
export function appendCrashLog(dir: string, entry: CrashEntry, maxBytes: number = CRASH_LOG_MAX_BYTES): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, CRASH_LOG_FILE);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      /* no file yet */
    }
    if (size >= maxBytes) {
      const rotated = path.join(dir, CRASH_LOG_ROTATED);
      try {
        rmSync(rotated, { force: true });
        renameSync(file, rotated);
      } catch {
        /* rotation is best effort; worst case the file grows by one entry */
      }
    }
    appendFileSync(file, formatCrashEntry(entry), 'utf8');
  } catch {
    /* a log that cannot be written must never take the app down with it */
  }
}

/** Normalize an error into name / message / stack strings. */
export function errorParts(err: unknown): { name: string; message: string; stack: string } {
  if (err instanceof Error) {
    return { name: err.name || 'Error', message: String(err.message ?? ''), stack: String(err.stack ?? '') };
  }
  if (err && typeof err === 'object') {
    const o = err as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof o.name === 'string' ? o.name : 'NonError',
      message: typeof o.message === 'string' ? o.message : safeString(err),
      stack: typeof o.stack === 'string' ? o.stack : '',
    };
  }
  return { name: typeof err === 'string' ? 'StringError' : 'NonError', message: safeString(err), stack: '' };
}

function safeString(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Error names are identifiers; anything else ships as 'Error'. */
export function cleanErrorName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) ? name : 'Error';
}

const FRAME_RE = /\(?((?:[A-Za-z]:)?[^\s()]*?)([^\\/\s()]+\.(?:[cm]?js|tsx?|jsx?|node))(?::(\d+))?(?::(\d+))?\)?\s*$/;

/**
 * `file.js:line:col` of the first stack frame that names a file, with the
 * directory stripped (so no install path or user name), or null.
 */
export function topFrame(stack: string): string | null {
  for (const line of (stack ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('at ')) continue;
    const m = t.match(FRAME_RE);
    if (!m) continue;
    const file = m[2];
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(file)) continue;
    return [file, m[3], m[4]].filter(Boolean).join(':');
  }
  return null;
}

/**
 * Short stable hash of an error's SHAPE: its name, its message with numbers,
 * hex ids and quoted values flattened, and its top three frames without
 * line/column. The same bug on two machines (different paths, ids, ports)
 * hashes the same; the text itself is never shipped.
 */
export function errorFingerprint(name: string, message: string, stack: string): string {
  const msg = scrubCrashText(message)
    .replace(/(["'`]).*?\1/g, '"_"')
    .replace(/\b[0-9a-f]{8,}\b/gi, '_')
    .replace(/\d+/g, '0')
    .slice(0, 200);
  const frames: string[] = [];
  for (const line of (stack ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('at ')) continue;
    const fn = t.slice(3).split(' (')[0];
    const file = topFrame(t)?.split(':')[0] ?? '';
    frames.push(`${fn.includes('/') || fn.includes('\\') ? '' : fn}@${file}`);
    if (frames.length >= 3) break;
  }
  return createHash('sha256').update(`${name}|${msg}|${frames.join('>')}`).digest('hex').slice(0, 12);
}
