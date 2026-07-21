/**
 * Failed-summon diagnostics (260720, P0).
 *
 * ~50% of production summon attempts fail, and the thin `summon_failed`
 * analytics event (character_id + reason enum) gives nothing to diagnose
 * BOT_CRASH / BOT_START_TIMEOUT from. This module assembles a REDACTED
 * diagnostic payload from the supervisor's failure callback so a failure on a
 * user machine reaches PostHog with enough context to debug:
 *
 *   botSupervisor.onSummonFailure(info)   raw tails, phase, exit code
 *     → buildSummonDiagnostic(info, ctx)  redaction + MC/world context (here)
 *     → captureDiagnostic('summon_failed', diag)  allowlisted long-text capture
 *
 * Privacy: `redact()` is the load-bearing gate. Everything that leaves the
 * machine through this path is scrubbed of home-directory paths, API keys,
 * JWT-shaped tokens, and chat/prompt log content BEFORE capture. The analytics
 * side (`captureDiagnostic`) only enforces length caps — redaction happens
 * here, once, and is unit-tested (diagnostics.test.ts).
 *
 * Also owns `pruneLogsDir` — startup pruning of the previously-unbounded
 * `<userData>/logs` directory (log-hygiene quick win, same 260720 work).
 *
 * Deliberately imports NO electron API so the whole module is unit-testable
 * under plain vitest/node: `packaged` and `signedIn` are caller-supplied.
 */
import os from 'node:os';
import path from 'node:path';
import { readdir, stat, unlink } from 'node:fs/promises';
import type { LanState } from '../shared/ipc';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Where in the summon lifecycle the attempt died:
 *   - 'pre_gate'      → refused before fork (credit gate, daily limit, missing
 *                       key/name, LAN closed, username conflict, store errors).
 *   - 'fork'          → the child process failed at the process level (spawn
 *                       error, or exited before signaling summon-ready).
 *   - 'connect'       → the bot ran and reported a structured lifecycle error
 *                       before summon-ready (MC connect refused, bad version...).
 *   - 'ready_timeout' → 30s summon watchdog fired with no terminal signal.
 *   - 'mid_session'   → the bot WAS live and crashed (nonzero exit, no stop
 *                       requested). Not a failed summon per se — filter on
 *                       summon_phase in dashboards that count summon failures.
 */
export type SummonPhase = 'pre_gate' | 'fork' | 'connect' | 'ready_timeout' | 'mid_session';

/**
 * Raw failure info handed up by botSupervisor's onSummonFailure callback.
 * Tails and message are UNREDACTED here — buildSummonDiagnostic scrubs them.
 */
export interface SummonFailureInfo {
  characterId: string;
  phase: SummonPhase;
  /** ErrorClass enum value, or an UPPER_SNAKE refusal token (e.g. CLOUD_CREDITS_DEPLETED). */
  errorClass: string;
  errorMessage: string;
  exitCode?: number | null;
  stderrTail?: string;
  stdoutTail?: string;
  /** Wall-clock ms since the summon attempt started. For phase 'mid_session'
   *  this spans the whole live session (connect time included) — it doubles as
   *  a crude time-to-crash signal. */
  durationMs: number;
  backend?: 'local' | 'cloud-proxy' | null;
}

/** Main-process context stamped onto the diagnostic at capture time. */
export interface SummonDiagnosticContext {
  /** Latest LAN watcher state — carries MC version/protocol/host when open. */
  lan: LanState | null;
  signedIn: boolean;
  packaged: boolean;
}

// ── Redaction ───────────────────────────────────────────────────────────────

/** Post-redaction cap for error_message (PostHog prop budget). */
const ERROR_MESSAGE_CAP = 2048;
/** Post-redaction cap per tail — keeps the END (most recent output). Must not
 *  exceed the analytics-side DIAG_LONG_TEXT_CAP (8KB). */
const TAIL_CAP = 8192;

/**
 * Log tags whose lines/blocks carry conversation or prompt content
 * (src/bot/brain/log.js emitBlock vocabulary): player/bot chat in+out, the
 * LLM request/response/error blocks, and say/think output. These are stripped
 * wholesale — a crash diagnostic never needs what anyone SAID.
 * [act!]/[heal]/[log] blocks (tool args, coords, plumbing) are kept.
 */
const CONTENT_TAG_RE = /\[(?:chat<-|chat->|haiku\?|haiku!|haiku✗|say|think|sei-chat)\]/;
/** `[HH:MM:SS.mmm] [tag] begin|end` block sentinels (mirrors logRouter). */
const BLOCK_SENTINEL_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])\s+(begin|end)\s*$/;

const STRIPPED_MARKER = '[chat/prompt content stripped]';

/**
 * Drop every line that belongs to a chat/prompt content block or carries a
 * content tag. Handles three shapes:
 *   - a complete `begin ... end` block → replaced by one marker line;
 *   - a block truncated at the END of the tail (begin, no end) → stripped to EOF;
 *   - a block truncated at the START of the tail (orphan end): everything
 *     before the orphan end is suspect continuation content → stripped.
 */
function stripContentLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inContentBlock = false;
  let inBlockTag: string | null = null;
  for (const line of lines) {
    const m = line.match(BLOCK_SENTINEL_RE);
    if (m) {
      const tag = m[1];
      const isContent = CONTENT_TAG_RE.test(tag);
      if (m[2] === 'begin') {
        inBlockTag = tag;
        inContentBlock = isContent;
        if (isContent) out.push(STRIPPED_MARKER);
        else out.push(line);
        continue;
      }
      // end sentinel
      if (inBlockTag === tag) {
        if (!inContentBlock) out.push(line);
        inBlockTag = null;
        inContentBlock = false;
        continue;
      }
      // Orphan end with no seen begin: the tail started mid-block. For a
      // content tag every preceding kept line may be its continuation — drop
      // them all. For a non-content tag keep everything as-is.
      if (isContent) {
        out.length = 0;
        out.push(STRIPPED_MARKER);
      } else {
        out.push(line);
      }
      inBlockTag = null;
      inContentBlock = false;
      continue;
    }
    if (inContentBlock) continue; // continuation line inside a content block
    if (CONTENT_TAG_RE.test(line)) {
      // Single content-tagged line outside a block (e.g. a [say] echo).
      out.push(STRIPPED_MARKER);
      continue;
    }
    out.push(line);
  }
  if (inContentBlock) {
    // begin with no end before the tail was cut — already emitted the marker.
    inContentBlock = false;
  }
  return out.join('\n');
}

/**
 * Scrub a text blob of everything person- or secret-shaped before it can leave
 * the machine:
 *   1. chat/prompt log content (see stripContentLines);
 *   2. Anthropic API keys (`sk-ant-...`) and JWT-shaped tokens (`eyJx.y.z`);
 *   3. home-directory paths → `~` (the actual homedir string plus generic
 *      /Users/<name>, /home/<name>, C:\Users\<name> patterns, so stack traces
 *      recorded on OTHER machines redact too).
 * Idempotent and never throws. Exported for tests and any future diagnostic
 * surface (crash reporter, Sentry P1).
 */
export function redact(text: string): string {
  if (!text) return '';
  let s = stripContentLines(text);
  // Secrets before paths — a key inside a path segment must not survive.
  s = s.replace(/sk-ant-\S+/g, '[redacted]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  // The real home directory of THIS machine (covers unusual homes like /var/x).
  const home = os.homedir();
  if (home && home.length > 1) s = s.split(home).join('~');
  // Generic per-user roots (any machine's traces, e.g. paths baked into a
  // dependency's sourcemap). Replaces `/Users/<name>` → `~`, keeping the rest.
  s = s.replace(/\/(?:Users|home)\/[^/\\\s:'"]+/g, '~');
  s = s.replace(/[A-Za-z]:\\Users\\[^\\/\s:'"]+/g, '~');
  return s;
}

// ── Assembly ────────────────────────────────────────────────────────────────

/**
 * User-environment failure classes (founder decision, 260720): these are the
 * user's world setup, not Sei crashes — LAN_NOT_OPEN means no world was open
 * to LAN, UNSUPPORTED_MC_VERSION means the world runs a version outside our
 * networking stack. The summon_failed event still fires for funnel counting,
 * but WITHOUT the heavy text payload (error_message + stderr/stdout tails):
 * the tails carry nothing diagnosable for these classes, and the cheap enum
 * context (class, phase, MC version/protocol, backend, duration) is all a
 * dashboard needs.
 */
export const USER_ENV_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'LAN_NOT_OPEN',
  'UNSUPPORTED_MC_VERSION',
]);

/**
 * Assemble the redacted PostHog property payload for a failed summon. Pure
 * given its inputs; the caller (index.ts onSummonFailure wiring) supplies the
 * live LAN state, signed-in flag, and app.isPackaged.
 *
 * For USER_ENV_ERROR_CLASSES the heavy text fields (error_message,
 * stderr_tail, stdout_tail) are omitted entirely — cheap enum context only.
 *
 * Ship with `captureDiagnostic('summon_failed', ...)` — plain capture() would
 * truncate the tails to 200 chars.
 */
export function buildSummonDiagnostic(
  info: SummonFailureInfo,
  ctx: SummonDiagnosticContext,
): Record<string, unknown> {
  const lanOpen = ctx.lan?.kind === 'open' ? ctx.lan : null;
  const diag: Record<string, unknown> = {
    error_class: info.errorClass,
    summon_phase: info.phase,
    exit_code: info.exitCode ?? null,
    duration_ms: info.durationMs,
    backend: info.backend ?? null,
    signed_in: ctx.signedIn,
    // MC/world context from the LAN watcher's status ping (null when no world
    // was detected at failure time — itself a diagnostic signal).
    mc_version: lanOpen?.versionName ?? null,
    mc_protocol: lanOpen?.protocol ?? null,
    host_client: lanOpen?.host?.client ?? null,
    forge_mod_count: lanOpen?.host?.forgeModCount ?? null,
    packaged: ctx.packaged,
    electron_version: process.versions.electron ?? null,
    node_version: process.versions.node ?? null,
  };
  if (!USER_ENV_ERROR_CLASSES.has(info.errorClass)) {
    diag.error_message = redact(info.errorMessage ?? '').slice(0, ERROR_MESSAGE_CAP);
    // Keep the END of each tail — the crash is at the bottom.
    diag.stderr_tail = redact(info.stderrTail ?? '').slice(-TAIL_CAP);
    diag.stdout_tail = redact(info.stdoutTail ?? '').slice(-TAIL_CAP);
  }
  return diag;
}

// ── Log pruning (startup hygiene) ───────────────────────────────────────────

export const LOG_PRUNE_MAX_FILES = 20;
export const LOG_PRUNE_MAX_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * Prune `<userData>/logs` to the most recent `maxFiles` files AND `maxBytes`
 * cumulative bytes (whichever bound bites first), newest-by-mtime kept. The
 * newest file always survives even if it alone exceeds the byte budget. Only
 * `.log` files are considered. Best-effort throughout: a missing dir, a
 * racing unlink, or a stat error never throws.
 */
export async function pruneLogsDir(
  dir: string,
  opts?: { maxFiles?: number; maxBytes?: number },
): Promise<{ deleted: number }> {
  const maxFiles = opts?.maxFiles ?? LOG_PRUNE_MAX_FILES;
  const maxBytes = opts?.maxBytes ?? LOG_PRUNE_MAX_BYTES;
  let deleted = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { deleted };
  }
  const files: Array<{ full: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      if (st.isFile()) files.push({ full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* raced away — skip */
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    total += files[i].size;
    const overCount = i >= maxFiles;
    const overBytes = i > 0 && total > maxBytes; // index 0 (newest) always kept
    if (overCount || overBytes) {
      try {
        await unlink(files[i].full);
        deleted += 1;
      } catch {
        /* best-effort */
      }
    }
  }
  return { deleted };
}
