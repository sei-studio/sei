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
 * tokens, emails, IP addresses, Minecraft player names and chat/prompt log
 * content BEFORE capture. The analytics side (`captureDiagnostic`) runs it
 * again as a backstop and enforces length caps; unit-tested in
 * diagnostics.test.ts.
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
 *   - 'boot_timeout'  → the bot never finished booting (no init-ack) within
 *                       the cold-boot budget (260926; 90s since 261007).
 *   - 'ready_timeout' → the bot booted but did not reach summon-ready within
 *                       the 30s ready budget, which starts at init-ack.
 *   - 'mid_session'   → the bot WAS live and crashed (nonzero exit, no stop
 *                       requested). Not a failed summon per se — filter on
 *                       summon_phase in dashboards that count summon failures.
 */
export type SummonPhase = 'pre_gate' | 'fork' | 'connect' | 'boot_timeout' | 'ready_timeout' | 'mid_session';

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
  /** 260926: boot-phase stamps for the attempt (see bootPhaseProps). */
  boot?: BootTimingInfo;
  /**
   * 260929: set when the supervisor reported this failure under a different
   * class than the raw one, e.g. BOT_START_TIMEOUT on a modded host shipped
   * as MODDED_HOST_REJECTED. Becomes `reclassified_from`.
   */
  reclassifiedFrom?: string;
  /**
   * 261031: the bot's in-game name for this attempt, when known. redact()
   * turns it into `[bot]` so the tails still say which lines were ours.
   */
  botName?: string;
}

/**
 * 260926: the raw boot timeline of one summon attempt. All values are epoch
 * ms. `marks` comes from the bot child (src/bot/bootTiming.js) and holds only
 * the phases it reached, so a stalled boot shows where it stopped.
 */
export interface BootTimingInfo {
  /** When the summon attempt started (after pre-gate and pack install). */
  attemptStartMs: number;
  /** When main called utilityProcess.fork. */
  forkAtMs: number;
  marks: Record<string, number>;
}

/**
 * Bot boot phases in the order they happen. Anything the bot stamps that is
 * not listed still gets a prop; this list only picks `boot_last_phase`.
 */
export const BOOT_PHASE_ORDER = [
  'process_start',
  'modules_loaded',
  'init_received',
  'pack_loader_ready',
  'runtime_loaded',
  'booted',
  'version_resolved',
  'create_bot',
  'bot_created',
  'login',
  'spawn',
] as const;

const BOOT_MARK_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Flatten a boot timeline into PostHog props: `boot_<phase>_ms` is the time
 * from fork to that phase, `boot_fork_ms` is attempt start to fork (log
 * router setup etc.), and `boot_last_phase` is the furthest phase reached
 * (null when the bot never reported one). Flat numbers so dashboards can
 * break BOT_START_TIMEOUT down by phase without parsing.
 */
export function bootPhaseProps(info: BootTimingInfo): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {
    boot_fork_ms: Math.max(0, Math.round(info.forkAtMs - info.attemptStartMs)),
  };
  let last: string | null = null;
  let lastRank = -1;
  for (const [name, at] of Object.entries(info.marks ?? {})) {
    if (!BOOT_MARK_NAME_RE.test(name) || typeof at !== 'number' || !Number.isFinite(at)) continue;
    // process_start can land a hair before fork on coarse clocks; clamp at 0.
    out[`boot_${name}_ms`] = Math.max(0, Math.round(at - info.forkAtMs));
    const rank = (BOOT_PHASE_ORDER as readonly string[]).indexOf(name);
    if (rank > lastRank) {
      lastRank = rank;
      last = name;
    }
  }
  out.boot_last_phase = last;
  return out;
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
/** Post-redaction cap per tail — keeps the END (most recent output, where the
 *  crash is). 261031: 8KB → 2KB per the PostHog audit; the crash trace fits,
 *  the older log lines that mostly carried names and addresses do not. Must
 *  not exceed the analytics-side DIAG_LONG_TEXT_CAP. */
const TAIL_CAP = 2048;

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

/** Minecraft username charset (1-16 chars). */
const MC_NAME = '[A-Za-z0-9_]{1,16}';
const UUID_RE_SRC = '[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}';

/**
 * Provider API keys by prefix: OpenAI (sk-, sk-proj-, sk-svcacct-), Anthropic
 * (sk-ant-), DeepSeek (sk-), OpenRouter (sk-or-v1-), ElevenLabs (sk_), Groq
 * (gsk_), xAI (xai-), Google (AIza), plus Perplexity/Replicate/HF/GitHub
 * lookalikes. The 16+ char body keeps short words like "sk-1" out.
 */
const PROVIDER_KEY_RE =
  /(?<![A-Za-z0-9])(?:sk-ant-|sk-proj-|sk-svcacct-|sk-admin-|sk-or-(?:v1-)?|sk-|sk_|gsk_|xai-|pplx-|r8_|hf_|gh[pousr]_|AIza)[A-Za-z0-9_-]{16,}/g;
/** `Bearer <token>` in headers, curl dumps and error bodies. */
const BEARER_RE = /\b(Bearer)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{6,}/gi;
/**
 * `key=v`, `api_key: v`, `"token":"v"`, `?key=v&...`, `xi-api-key: v`,
 * `OPENAI_API_KEY=v`. The name must stand alone (not after `_`, so `API_KEY`
 * never matches as plain `key`) and end right before the separator, so
 * `max_tokens: 5` and `tokens=5` do not match. A quoted value is taken whole.
 * Our `LOCAL_NO_API_KEY: <why>` sentinel is therefore left readable.
 */
const SECRET_KV_RE =
  /(?<![A-Za-z0-9_])(["']?)((?:x-|xi-)?api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|key)\1(\s*[:=]\s*)(?!\[redacted\])(?:"[^"\n]*"|'[^'\n]*'|[^\s"'&,;}\])]+)/gi;
/** Env-style `OPENAI_API_KEY=v`, `GROQ_API_KEY="v"`, `HF_TOKEN=v` (`=` only). */
const ENV_SECRET_RE = /\b([A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD))=(?!\[redacted\])(?:"[^"\n]*"|'[^'\n]*'|[^\s"'&,;}\])]+)/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
/**
 * Dotted quads. Not preceded by a digit, dot or `v` and not followed by
 * `[.]digit`, so 3-part versions (1.21.1) never match and a 4-part one only
 * when it reads like an address. Loopback/unspecified stay (not personal, and
 * "ECONNREFUSED 127.0.0.1:25565" is the diagnosis).
 */
const IPV4_RE = new RegExp(`(?<![\\d.vV])${OCTET}(?:\\.${OCTET}){3}(?!\\.?\\d)`, 'g');
const H16 = '[0-9A-Fa-f]{1,4}';
/**
 * IPv6: the full 8-group form, or a compressed form with groups on both sides
 * of `::` (fe80::1c2b:3d4e, 2001:db8::1), optional %zone. Clock times
 * (12:34:56) never have 8 groups or `::`.
 */
const IPV6_RE = new RegExp(
  `(?<![0-9A-Za-z:])(?:${H16}(?::${H16}){7}|(?:${H16}:){1,6}(?::${H16}){1,6})(?:%[0-9A-Za-z]+)?(?![0-9A-Za-z])`,
  'g',
);
const KEEP_IPS = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255']);

/** Escape a literal for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace whole-word (MC-name boundary) occurrences of `word`, case-insensitive. */
function replaceWord(s: string, word: string, to: string): string {
  if (!word || word.length < 3) return s;
  return s.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRe(word)}(?![A-Za-z0-9_])`, 'gi'), to);
}

function localUsername(): string {
  try {
    return os.userInfo().username ?? '';
  } catch {
    return '';
  }
}

export interface RedactOptions {
  /**
   * Our bot's in-game name for this session. Its occurrences become `[bot]`
   * (not `[player]`) so a trace still says which lines were ours, without
   * shipping the name itself.
   */
  botName?: string;
}

/**
 * Minecraft player names where the line format reveals them (vanilla server
 * log, chat, our bot's own key=value logs). Every match becomes `[player]`.
 */
function redactPlayerNames(s: string): string {
  // Chat prefix: "<Steve> hi", "[CHAT] <Steve> hi". Not "at Object.<anonymous> (".
  s = s.replace(new RegExp(`(^|[\\s\\]:])<(?!anonymous>)${MC_NAME}>(?= )`, 'gm'), '$1<[player]>');
  // "UUID of player Steve is 069a79f4-..."
  s = s.replace(new RegExp(`UUID of player ${MC_NAME}( is ${UUID_RE_SRC})?`, 'g'), (_m, id?: string) =>
    id ? 'UUID of player [player] is [uuid]' : 'UUID of player [player]',
  );
  // "Steve joined the game", "Steve[/192.168.1.5:5123] logged in", "Steve lost connection"...
  s = s.replace(
    new RegExp(
      `(?<![A-Za-z0-9_])${MC_NAME}(?= (?:joined the game|left the game|lost connection|logged in with entity id|has made the advancement|has completed the challenge|has reached the goal)|\\[/)`,
      'g',
    ),
    '[player]',
  );
  // Our logs: "username=Steve", "player: Steve", "uuid=069a...".
  s = s.replace(
    new RegExp(`\\b(username|user_name|mc_username|player_?name|playerName|player|sender)(\\s*[=:]\\s*["']?)${MC_NAME}(?![A-Za-z0-9_])`, 'g'),
    '$1$2[player]',
  );
  s = s.replace(new RegExp(`\\b(uuid)(\\s*[=:]\\s*["']?)${UUID_RE_SRC}`, 'gi'), '$1$2[uuid]');
  return s;
}

/**
 * Scrub a text blob of everything person- or secret-shaped before it can leave
 * the machine. THE redaction function for every analytics payload that carries
 * free text (logs, error messages, stack traces); captureDiagnostic runs it
 * again as a backstop. Removes:
 *   1. chat/prompt log content (see stripContentLines);
 *   2. API keys for every provider we support, `Bearer`/`Basic` tokens,
 *      `key=`/`api_key=`/`token=`-style query and JSON values, JWTs;
 *   3. emails;
 *   4. home-directory paths → `~` (this machine's homedir plus generic
 *      /Users/<name>, /home/<name>, C:\Users\<name> on any machine) and this
 *      machine's account name anywhere else;
 *   5. IPv4/IPv6 addresses, LAN included (loopback kept), versions untouched;
 *   6. Minecraft player names where the line format reveals them; our bot's
 *      own name becomes `[bot]`.
 * Idempotent and never throws.
 */
export function redact(text: string, opts: RedactOptions = {}): string {
  if (!text) return '';
  let s = stripContentLines(text);
  // Secrets before paths: a key inside a path segment must not survive.
  s = s.replace(/sk-ant-\S+/g, '[redacted]'); // any length: Anthropic is the BYOK default
  s = s.replace(JWT_RE, '[redacted]');
  s = s.replace(PROVIDER_KEY_RE, '[redacted]');
  s = s.replace(BEARER_RE, '$1 [redacted]');
  s = s.replace(SECRET_KV_RE, '$1$2$1$3[redacted]');
  s = s.replace(ENV_SECRET_RE, '$1=[redacted]');
  s = s.replace(EMAIL_RE, '[email]');
  // The real home directory of THIS machine (covers unusual homes like /var/x).
  const home = os.homedir();
  if (home && home.length > 1) s = s.split(home).join('~');
  // Generic per-user roots (any machine's traces, e.g. paths baked into a
  // dependency's sourcemap). Replaces `/Users/<name>` → `~`, keeping the rest.
  // Windows first (C:\Users\x, JSON-escaped C:\\Users\\x, C:/Users/x); its
  // account names may contain spaces ("Jane Doe").
  s = s.replace(/[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/:'"\n]+/gi, '~');
  s = s.replace(/\/(?:Users|home)\/[^/\\\s:'"]+/g, '~');
  // This machine's account name outside a path (e.g. "user=alice", "DESKTOP-1\alice").
  s = replaceWord(s, localUsername(), '[user]');
  s = s.replace(IPV4_RE, (ip) => (KEEP_IPS.has(ip) || ip.startsWith('127.') ? ip : '[ip]'));
  s = s.replace(IPV6_RE, '[ip]');
  if (opts.botName) s = replaceWord(s, opts.botName.trim(), '[bot]');
  s = redactPlayerNames(s);
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
 *
 * Phase refinement (260720): the slim treatment for LAN_NOT_OPEN applies ONLY
 * at phase 'pre_gate' — the supervisor refused before forking because no world
 * was detected, which really is just the user's environment. When a summon got
 * PAST the gate (a world WAS detected) and then died with LAN_NOT_OPEN at
 * 'fork' / 'connect' / 'ready_timeout' / 'mid_session', the world was
 * announced but unjoinable — the suspected-Windows-firewall pattern we most
 * need tails for — so the full payload ships. UNSUPPORTED_MC_VERSION stays
 * slim at every phase: the version mismatch is fully described by the cheap
 * enum context regardless of where it surfaced.
 */
export const USER_ENV_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'LAN_NOT_OPEN',
  'UNSUPPORTED_MC_VERSION',
]);

/**
 * Should the heavy text payload (error_message + tails) be omitted for this
 * failure? See USER_ENV_ERROR_CLASSES for the rationale table.
 */
export function omitsHeavyText(errorClass: string, phase: SummonPhase): boolean {
  if (errorClass === 'UNSUPPORTED_MC_VERSION') return true;
  if (errorClass === 'LAN_NOT_OPEN') return phase === 'pre_gate';
  return false;
}

/**
 * Assemble the redacted PostHog property payload for a failed summon. Pure
 * given its inputs; the caller (index.ts onSummonFailure wiring) supplies the
 * live LAN state, signed-in flag, and app.isPackaged.
 *
 * When omitsHeavyText(errorClass, phase) holds, the heavy text fields
 * (error_message, stderr_tail, stdout_tail) are omitted entirely — cheap enum
 * context only.
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
  if (info.reclassifiedFrom) diag.reclassified_from = info.reclassifiedFrom;
  if (info.boot) Object.assign(diag, bootPhaseProps(info.boot));
  if (!omitsHeavyText(info.errorClass, info.phase)) {
    const r = { botName: info.botName };
    diag.error_message = redact(info.errorMessage ?? '', r).slice(0, ERROR_MESSAGE_CAP);
    // Keep the END of each tail — the crash is at the bottom. Redact first so
    // the cut can never split a secret into an unrecognizable fragment.
    diag.stderr_tail = redact(info.stderrTail ?? '', r).slice(-TAIL_CAP);
    diag.stdout_tail = redact(info.stdoutTail ?? '', r).slice(-TAIL_CAP);
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
