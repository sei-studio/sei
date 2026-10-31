/**
 * UserConfig persistence: <userData>/config.json.
 * Reads/writes are Zod-validated and atomic.
 *
 * Sources:
 *   - PATTERNS §src/main/configStore.ts
 *   - CONTEXT D-09 (path), D-12 (schema — no api_key)
 *   - fileLock.js for the per-path lock; durableWrite.ts (temp + fsync +
 *     rename) for every write (261031)
 *
 * Phase 13 13-02 (D-57): UserConfigSchema (in src/shared/characterSchema.ts)
 * now carries `ai_backend_kind: 'local' | 'cloud-proxy'` — the single source
 * of truth for whether the bot routes through BYOK (api-key.bin) or Sei's
 * cloud proxy. Read/write via `apiKeyStore.{getAiBackendKind,setAiBackendKind}`
 * — never read the raw field on UserConfig directly so the default
 * fall-through stays inside one helper.
 */
import { readFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { UserConfigSchema, type UserConfig } from '../shared/characterSchema';
// ESM imports of existing brain JS helpers (.js extension required under nodenext-style resolution).
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules at compile time.
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { writeFileDurable } from './durableWrite';
import { paths, profileRootFor } from './paths';

export const DEFAULT_CONFIG: UserConfig = UserConfigSchema.parse({});

/* -------------------------------------------------------------------------- */
/*  Resilience (261031, T277)                                                  */
/* -------------------------------------------------------------------------- */
//
// A broken config.json used to throw out of loadConfig ("Invalid JSON ...",
// with the parse error text) and out of updateConfig, so the renderer routed a
// signed-in user to onboarding and every later save failed. Now:
//
//   - Writes are durable (temp + fsync + rename, durableWrite.ts), and before
//     a valid file is replaced it is copied to `config.json.bak`, the
//     last-known-good copy.
//   - A file that is empty, truncated, not JSON or not an object is renamed
//     to `config.corrupt-<timestamp>.json` (the newest QUARANTINE_KEEP kept),
//     then restored from the backup when that parses, else rebuilt from the
//     identity keys that can still be read out of the damaged text (name,
//     backend, roster, analytics choices), else defaults. Nothing is deleted.
//   - T283: with the backup also unreadable, the newest quarantined copy that
//     parses comes before the identity keys, and those are read from the
//     damaged text, the backup and the quarantined copies. A config that is
//     MISSING while a backup or quarantined copy exists (a restore that never
//     landed) is recovered the same way instead of reading as defaults.
//   - T283: a recovery that cannot be written back (read-only folder, disk
//     full) is held in memory for the process: reads serve it (no second
//     quarantine, one report), saves update it and retry the disk.
//   - T283: "recovered to defaults" is not "new user". configShowsPriorSetup
//     tells the renderer a profile was set up before when its config has no
//     name, so it is not sent to onboarding.
//   - A file that parses but has invalid fields keeps every valid field; each
//     invalid one falls back to its default ("salvaged").
//   - Unknown keys (written by a newer Sei) are kept on every write, and so
//     are values this version cannot read when the file comes from a newer
//     schema, so running an older build never destroys a newer one's settings.
//   - `schema_version` is stamped on write; upgrade migrations run on read and
//     are idempotent.
//
// Logs and recovery events carry kinds and key names only, never values.

/** Current config schema version. Bump with a new entry in CONFIG_MIGRATIONS. */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * Upgrade steps, applied in order to a raw config whose schema_version is
 * below `version`. Each must be idempotent: a step can run again on a file a
 * crash left unstamped, or on one an older build rewrote.
 */
export const CONFIG_MIGRATIONS: ReadonlyArray<{
  version: number;
  up: (raw: Record<string, unknown>) => Record<string, unknown>;
}> = [
  // v1 (261031): introduces schema_version itself. No data change.
  { version: 1, up: (raw) => raw },
];

export const CONFIG_BACKUP_SUFFIX = '.bak';
export const QUARANTINE_PREFIX = 'config.corrupt-';
export const RESET_PREFIX = 'config.before-reset-';
export const QUARANTINE_KEEP = 3;

export type ConfigRecoveryKind = 'salvaged' | 'restored_backup' | 'restored_quarantine' | 'reset_defaults';

export interface ConfigRecoveryEvent {
  kind: ConfigRecoveryKind;
  /** Absolute path of the config that was recovered. */
  file: string;
  /** Key names that fell back to defaults ('salvaged'). Never values. */
  keys?: string[];
  /** 'reset_defaults': whether identity keys were read back out of the damaged file. */
  keptIdentity?: boolean;
  at: number;
}

const recoveryLog: ConfigRecoveryEvent[] = [];
const recoveryListeners = new Set<(e: ConfigRecoveryEvent) => void>();
/** Salvage is reported once per file per process (a newer-schema value would otherwise repeat on every read). */
const salvageReported = new Set<string>();
/**
 * Damaged files that could not be repaired on disk (read-only folder, a
 * locked file): neither moved aside nor rewritten, so every later read finds
 * the same damage and recovers it again in memory. Reported once per file per
 * process, not on every read.
 */
const stuckReported = new Set<string>();

/**
 * Settings this process holds in memory because they could not be written
 * (T283): a recovery whose restore write failed (read-only folder, disk
 * full), or a later save to such a target. Every read is served from here,
 * so the damaged file is not recovered (or quarantined) again, and every
 * write retries the disk and drops the entry once it lands.
 */
interface HeldConfig {
  parsed: ParsedConfig;
  /** The damaged file is still at the target (it could not be quarantined). */
  damagedInPlace: boolean;
}
const heldConfigs = new Map<string, HeldConfig>();
/** Targets this process recovered from damage or loss (not salvage). */
const recoveredTargets = new Set<string>();

function noteRecovery(e: ConfigRecoveryEvent): void {
  if (e.kind === 'salvaged') {
    const key = `${e.file}|${(e.keys ?? []).join(',')}`;
    if (salvageReported.has(key)) return;
    salvageReported.add(key);
  }
  recoveryLog.push(e);
  if (recoveryLog.length > 20) recoveryLog.shift();
  const detail =
    e.kind === 'salvaged'
      ? ` keys=${(e.keys ?? []).join(',')}`
      : e.kind === 'reset_defaults'
        ? ` kept_identity=${e.keptIdentity === true}`
        : '';
  console.warn(`[sei] config recovered (${e.kind}) ${path.basename(path.dirname(e.file))}/${path.basename(e.file)}${detail}`);
  for (const fn of recoveryListeners) {
    try { fn(e); } catch { /* a listener never breaks a config read */ }
  }
}

/** Subscribe to recoveries. Already-recorded ones are replayed first. Returns an unsubscribe. */
export function onConfigRecovered(fn: (e: ConfigRecoveryEvent) => void): () => void {
  for (const e of recoveryLog) {
    try { fn(e); } catch { /* ignore */ }
  }
  recoveryListeners.add(fn);
  return () => recoveryListeners.delete(fn);
}

/** Recoveries seen by this process (newest last). */
export function configRecoveries(): readonly ConfigRecoveryEvent[] {
  return recoveryLog;
}

/** TEST-ONLY. */
export function _resetConfigRecoveryForTests(): void {
  recoveryLog.length = 0;
  recoveryListeners.clear();
  salvageReported.clear();
  stuckReported.clear();
  heldConfigs.clear();
  recoveredTargets.clear();
}

/** TEST-ONLY: whether `target` is currently served from memory. */
export function _isConfigHeldForTests(target: string): boolean {
  return heldConfigs.has(target);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function rawSchemaVersion(raw: Record<string, unknown>): number {
  const v = raw.schema_version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** Run the upgrade steps a raw config still needs, then stamp it. Idempotent. */
export function migrateRawConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const from = rawSchemaVersion(raw);
  let out: Record<string, unknown> = { ...raw };
  for (const m of CONFIG_MIGRATIONS) {
    if (m.version > from) out = m.up(out);
  }
  out.schema_version = Math.max(from, CONFIG_SCHEMA_VERSION);
  return out;
}

const SHAPE = UserConfigSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>;
const KNOWN_KEYS = new Set(Object.keys(SHAPE));

/** A raw config read off disk, with the parsed config and what had to give. */
export interface ParsedConfig {
  config: UserConfig;
  /** The raw object after migrations (unknown keys included). */
  raw: Record<string, unknown>;
  /** Keys whose stored value was invalid and fell back to the default. */
  salvaged: string[];
}

/**
 * Parse a raw config object, keeping every valid field: an invalid field
 * falls back to its default instead of failing the whole file.
 */
export function parseConfigLenient(input: Record<string, unknown>): ParsedConfig {
  const raw = migrateRawConfig(input);
  const whole = UserConfigSchema.safeParse(raw);
  if (whole.success) return { config: whole.data, raw, salvaged: [] };
  const out: Record<string, unknown> = {};
  const salvaged: string[] = [];
  for (const key of Object.keys(SHAPE)) {
    const field = SHAPE[key];
    const r = field.safeParse(raw[key]);
    if (r.success) {
      if (r.data !== undefined) out[key] = r.data;
      continue;
    }
    salvaged.push(key);
    const d = field.safeParse(undefined);
    if (d.success && d.data !== undefined) out[key] = d.data;
  }
  const rebuilt = UserConfigSchema.safeParse(out);
  return { config: rebuilt.success ? rebuilt.data : { ...DEFAULT_CONFIG }, raw, salvaged };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The text to write for `next`, given what was read. Unknown keys from disk
 * are kept. A value this build could not read is kept too when the file
 * comes from a NEWER schema and the write did not touch that key (a
 * downgrade must not destroy the newer build's setting); from the same or an
 * older schema it is damage and the default is written instead.
 */
export function serializeConfig(next: UserConfig, base: ParsedConfig | null): string {
  const out: Record<string, unknown> = { ...next };
  let version = CONFIG_SCHEMA_VERSION;
  if (base) {
    version = Math.max(version, rawSchemaVersion(base.raw));
    const fromNewer = rawSchemaVersion(base.raw) > CONFIG_SCHEMA_VERSION;
    if (fromNewer) {
      for (const key of base.salvaged) {
        const nextVal = (next as Record<string, unknown>)[key];
        const readVal = (base.config as Record<string, unknown>)[key];
        if (sameValue(nextVal, readVal) && key in base.raw) out[key] = base.raw[key];
      }
    }
    for (const [key, value] of Object.entries(base.raw)) {
      if (!KNOWN_KEYS.has(key)) out[key] = value;
    }
  }
  out.schema_version = version;
  return JSON.stringify(out, null, 2) + '\n';
}

/** JSON.parse to a plain object, or null for empty / truncated / non-JSON / non-object text. */
function parseObjectText(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Keys worth reading back out of a damaged file: who the person is, which
 * backend they use, their roster, their analytics choice and update channel.
 * Losing these is what sends a signed-in user back to onboarding or changes
 * a privacy choice; the rest are preferences.
 */
const IDENTITY_STRING_KEYS = [
  'preferred_name',
  'mc_username',
  'ai_backend_kind',
  'ai_backend_kind_source',
  'ui_language',
  'analytics_install_id',
  'provider',
] as const;
const IDENTITY_BOOL_KEYS = [
  'analytics_opt_out',
  'advanced_updates',
  'has_been_welcomed',
  'added_defaults_backfilled',
  'defaults_to_world_migrated',
  'total_playtime_backfilled',
] as const;
const IDENTITY_NUMBER_KEYS = ['total_playtime_ms'] as const;
const IDENTITY_ARRAY_KEYS = ['added_world_ids', 'added_default_ids', 'removed_default_ids'] as const;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read the identity keys out of text that no longer parses (a truncated or
 * partly overwritten file usually still has its first keys intact). Each
 * value is a JSON literal parsed on its own and later validated by its
 * field's schema; anything doubtful is skipped.
 */
export function extractIdentityKeys(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of IDENTITY_STRING_KEYS) {
    const m = new RegExp(`"${escapeRe(key)}"\\s*:\\s*("(?:[^"\\\\\\n]|\\\\.)*")`).exec(text);
    if (m) {
      try { out[key] = JSON.parse(m[1]); } catch { /* skip */ }
    }
  }
  for (const key of IDENTITY_BOOL_KEYS) {
    const m = new RegExp(`"${escapeRe(key)}"\\s*:\\s*(true|false)\\b`).exec(text);
    if (m) out[key] = m[1] === 'true';
  }
  for (const key of IDENTITY_NUMBER_KEYS) {
    const m = new RegExp(`"${escapeRe(key)}"\\s*:\\s*(\\d{1,15})\\s*[,}\\n]`).exec(text);
    if (m) out[key] = Number(m[1]);
  }
  for (const key of IDENTITY_ARRAY_KEYS) {
    const m = new RegExp(`"${escapeRe(key)}"\\s*:\\s*(\\[[^\\]]*\\])`).exec(text);
    if (m) {
      try {
        const v: unknown = JSON.parse(m[1]);
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[key] = v;
      } catch { /* truncated inside the array: skip */ }
    }
  }
  return out;
}

function stampForFile(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/** Keep the newest `keep` files starting with `prefix` in `dir`. Best-effort. */
async function pruneByPrefix(dir: string, prefix: string, keep: number): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((n) => n.startsWith(prefix)).sort().reverse();
    for (const n of names.slice(keep)) {
      try { await unlink(path.join(dir, n)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** Move `target` aside as `<prefix><stamp>.json`. Returns the new path, or null when it could not move. */
async function moveAside(target: string, prefix: string, now: number): Promise<string | null> {
  const dir = path.dirname(target);
  const dest = path.join(dir, `${prefix}${stampForFile(now)}.json`);
  try {
    await rename(target, dest);
  } catch {
    return null;
  }
  await pruneByPrefix(dir, prefix, QUARANTINE_KEEP);
  return dest;
}

/** Write `text` beside `target` as `<prefix><stamp>.json` (durable), keeping the newest few. Throws when it cannot. */
async function copyAside(target: string, text: string, prefix: string, now: number): Promise<string> {
  const dir = path.dirname(target);
  const dest = path.join(dir, `${prefix}${stampForFile(now)}.json`);
  await writeFileDurable(dest, text);
  await pruneByPrefix(dir, prefix, QUARANTINE_KEEP);
  return dest;
}

function backupPath(target: string): string {
  return target + CONFIG_BACKUP_SUFFIX;
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Quarantined copies of `target`, newest first (the stamp sorts as text). */
async function quarantinedCopies(target: string): Promise<string[]> {
  const dir = path.dirname(target);
  try {
    return (await readdir(dir))
      .filter((n) => n.startsWith(QUARANTINE_PREFIX))
      .sort()
      .reverse()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * A missing config with a backup or a quarantined copy beside it was lost,
 * not never written: a damaged file was moved aside and the restore did not
 * land (disk full, a crash in between). Such a read recovers instead of
 * serving defaults (T283).
 */
async function hasRecoverySource(target: string): Promise<boolean> {
  const bakName = path.basename(backupPath(target));
  try {
    return (await readdir(path.dirname(target))).some((n) => n === bakName || n.startsWith(QUARANTINE_PREFIX));
  } catch {
    return false;
  }
}

/**
 * Recover a config whose text does not parse (`damagedText`), or that is
 * missing while a backup or quarantined copy exists (`damagedText` null).
 * MUST run under the file lock. Order (T283):
 *   1. quarantine the damaged file (nothing is deleted),
 *   2. the backup, when it parses,
 *   3. else the newest quarantined copy that parses,
 *   4. else the identity keys still readable in the damaged text, the backup
 *      and the quarantined copies (newest first, first value wins),
 *   5. else defaults.
 * The result is written back when there is something to write. When that
 * write fails, or there was nothing to write, the result is held in memory
 * for the rest of the process: reads are served from it and the next save
 * retries the disk, so the damage is recovered and reported once, not on
 * every read.
 */
async function recoverConfig(target: string, damagedText: string | null): Promise<ParsedConfig> {
  const now = Date.now();
  let movedTo: string | null = null;
  if (damagedText !== null) movedTo = await moveAside(target, QUARANTINE_PREFIX, now);
  const damagedInPlace = damagedText !== null && movedTo === null;

  let parsed: ParsedConfig | null = null;
  let toWrite: string | null = null;
  let event: ConfigRecoveryEvent | null = null;

  const bakText = await readTextOrNull(backupPath(target));
  const bakObj = bakText !== null ? parseObjectText(bakText) : null;
  if (bakObj && bakText !== null) {
    parsed = parseConfigLenient(bakObj);
    toWrite = bakText;
    event = { kind: 'restored_backup', file: target, at: now };
  }

  const quarantineTexts: string[] = [];
  if (!parsed) {
    for (const file of await quarantinedCopies(target)) {
      if (file === movedTo) continue; // the text we just found damaged
      const text = await readTextOrNull(file);
      if (text === null) continue;
      const obj = parseObjectText(text);
      if (obj) {
        parsed = parseConfigLenient(obj);
        toWrite = text;
        event = { kind: 'restored_quarantine', file: target, at: now };
        break;
      }
      quarantineTexts.push(text);
    }
  }

  if (!parsed) {
    const identity: Record<string, unknown> = {};
    for (const text of [damagedText, bakText, ...quarantineTexts]) {
      if (text === null) continue;
      for (const [key, value] of Object.entries(extractIdentityKeys(text))) {
        if (!(key in identity)) identity[key] = value;
      }
    }
    const keptIdentity = Object.keys(identity).length > 0;
    // Validated identity only: whatever failed its schema is dropped, not written.
    parsed = { config: parseConfigLenient(identity).config, raw: {}, salvaged: [] };
    toWrite = keptIdentity ? serializeConfig(parsed.config, null) : null;
    event = { kind: 'reset_defaults', file: target, keptIdentity, at: now };
  }

  const report: ConfigRecoveryEvent = event ?? { kind: 'reset_defaults', file: target, keptIdentity: false, at: now };
  let wrote = false;
  if (toWrite !== null) {
    try {
      await writeFileDurable(target, toWrite);
      wrote = true;
    } catch {
      /* held in memory below; the next save retries */
    }
  }
  recoveredTargets.add(target);
  if (wrote) {
    heldConfigs.delete(target);
    stuckReported.delete(target);
    noteRecovery(report);
    return parsed;
  }
  heldConfigs.set(target, { parsed, damagedInPlace });
  if (!stuckReported.has(target)) {
    stuckReported.add(target);
    if (toWrite !== null) {
      console.warn(`[sei] config recovery could not be saved (folder not writable or disk full?); serving it from memory`);
    }
    noteRecovery(report);
  }
  return parsed;
}

interface ConfigRead {
  /** Parsed config (defaults for a missing file). */
  parsed: ParsedConfig;
  /** The text on disk, null when missing or recovered. */
  text: string | null;
  /** The text on disk parsed as a JSON object (a valid file the backup may copy). */
  validText: boolean;
  /** Served from memory (heldConfigs): the disk does not have it yet. */
  held?: boolean;
}

/**
 * Read + parse the config at `target`. `locked` = the caller holds the file
 * lock, so damage can be recovered in place; unlocked callers get null back
 * for a damaged (or lost) file and retry under the lock.
 */
async function readConfigAt(target: string, locked: boolean): Promise<ConfigRead | null> {
  const held = heldConfigs.get(target);
  const heldRead = (h: HeldConfig): ConfigRead => ({ parsed: h.parsed, text: null, validText: false, held: true });
  let text: string;
  try {
    text = await readFile(target, 'utf8');
  } catch (err: unknown) {
    if (held) return heldRead(held);
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (await hasRecoverySource(target)) {
        if (!locked) return null;
        return { parsed: await recoverConfig(target, null), text: null, validText: false, held: heldConfigs.has(target) };
      }
      return { parsed: { config: { ...DEFAULT_CONFIG }, raw: {}, salvaged: [] }, text: null, validText: false };
    }
    throw err;
  }
  const obj = parseObjectText(text);
  if (held) {
    // A valid file showed up (written by hand, or by another process): the
    // disk wins over what this process held. Otherwise keep serving memory.
    if (!obj) return heldRead(held);
    heldConfigs.delete(target);
    stuckReported.delete(target);
  }
  if (!obj) {
    if (!locked) return null;
    return { parsed: await recoverConfig(target, text), text: null, validText: false, held: heldConfigs.has(target) };
  }
  const parsed = parseConfigLenient(obj);
  if (parsed.salvaged.length > 0) {
    noteRecovery({ kind: 'salvaged', file: target, keys: parsed.salvaged, at: Date.now() });
  }
  return { parsed, text, validText: true };
}

async function readConfigRecovering(target: string): Promise<ParsedConfig> {
  const first = await readConfigAt(target, false);
  if (first) return first.parsed;
  await mkdir(path.dirname(target), { recursive: true });
  return await withFileLock(target, async () => (await readConfigAt(target, true))!.parsed);
}

/**
 * Write `text` over `target` (under the lock). For a target held in memory
 * (T283) this is the retry: a damaged file still in place is quarantined
 * first (once; it was never moved), a landed write drops the hold, and a
 * failed one keeps `next` in memory instead of throwing, so the session goes
 * on with the setting and the next save tries again.
 */
async function writeTextLocked(target: string, text: string, next: ParsedConfig, read: ConfigRead): Promise<void> {
  const held = read.held ? heldConfigs.get(target) : undefined;
  if (held?.damagedInPlace) {
    if ((await moveAside(target, QUARANTINE_PREFIX, Date.now())) !== null) held.damagedInPlace = false;
  }
  try {
    await writeFileDurable(target, text);
  } catch (err) {
    if (!held) throw err;
    heldConfigs.set(target, { parsed: next, damagedInPlace: held.damagedInPlace });
    return;
  }
  if (held) {
    heldConfigs.delete(target);
    stuckReported.delete(target);
    console.warn(`[sei] config held in memory is saved again`);
  }
}

/**
 * Write `next` over `target` (under the lock): unknown keys kept, the
 * previous valid file copied to the backup first, durable. Skips the write
 * when nothing changed (never for a held config: the disk does not have it).
 */
async function writeConfigLocked(target: string, next: UserConfig, read: ConfigRead): Promise<void> {
  const text = serializeConfig(next, read.parsed);
  if (!read.held && text === read.text) return;
  if (read.validText && read.text !== null) {
    try { await writeFileDurable(backupPath(target), read.text); } catch { /* the main write still goes ahead */ }
  }
  await writeTextLocked(target, text, { config: next, raw: read.parsed.raw, salvaged: read.parsed.salvaged }, read);
}

/**
 * Load config. Missing file → DEFAULT_CONFIG. A damaged file is recovered
 * (see the resilience notes above) and never throws; only a file that cannot
 * be read at all (permissions) still does.
 * Legacy `persona` field (from CLI users) is silently stripped — migration
 * runFirstLaunchMigration handles transferring it to characters/sui.json.
 */
export async function loadConfig(): Promise<UserConfig> {
  return (await readConfigRecovering(paths.configPath())).config;
}

function hasName(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Whether this profile was set up before, judged WITHOUT the name in its
 * config (T283). Onboarding is keyed on `preferred_name`, and a config
 * recovered to defaults has none, so the renderer asks this before it sends a
 * profile with no name to onboarding. True when any of:
 *   - this process recovered the profile's config from damage or loss,
 *   - a quarantined (`config.corrupt-*`) or pre-reset copy is on disk,
 *   - the backup (`config.json.bak`) names the player,
 *   - a companion has a chat transcript or memories (`memory/<id>/chat.jsonl`
 *     or `MEMORY.md`): those are only written after onboarding.
 * A fresh install (and an onboarding left half way, which writes a config
 * and its backup but no name) has none of these. Never throws.
 */
export async function configShowsPriorSetup(opts?: { scope?: string }): Promise<boolean> {
  const target =
    opts?.scope !== undefined ? path.join(profileRootFor(opts.scope), 'config.json') : paths.configPath();
  if (recoveredTargets.has(target)) return true;
  const dir = path.dirname(target);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  if (names.some((n) => n.startsWith(QUARANTINE_PREFIX) || n.startsWith(RESET_PREFIX))) return true;
  if (names.includes(path.basename(backupPath(target)))) {
    const bakText = await readTextOrNull(backupPath(target));
    if (bakText !== null) {
      const obj = parseObjectText(bakText);
      if (hasName(obj ? obj.preferred_name : extractIdentityKeys(bakText).preferred_name)) return true;
    }
  }
  if (names.includes('memory')) {
    let ids: string[] = [];
    try { ids = await readdir(path.join(dir, 'memory')); } catch { /* none */ }
    for (const id of ids) {
      let files: string[] = [];
      try { files = await readdir(path.join(dir, 'memory', id)); } catch { continue; }
      if (files.includes('chat.jsonl') || files.includes('MEMORY.md')) return true;
    }
  }
  return false;
}

/**
 * Write a whole config. Seeding and tests only: a main-process writer uses
 * updateConfig (and sets only the keys it owns), a renderer save goes through
 * saveConfigFromRenderer. A load → await → saveConfig round trip reverts
 * whatever another writer changed in between (260929).
 */
export async function saveConfig(config: UserConfig): Promise<void> {
  const validated = UserConfigSchema.parse(config);
  const target = paths.configPath();
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    const read = (await readConfigAt(target, true))!;
    await writeConfigLocked(target, validated, read);
  });
}

/**
 * Atomic read-modify-write of the config under the file lock: `mutate`
 * receives the freshly-read config and returns the next one. Use this — not
 * loadConfig() → saveConfig() — for any update that must not clobber or be
 * clobbered by a concurrent writer (TOCTOU): a read taken before an await
 * elsewhere can be stale by the time it is written back. Missing config
 * seeds from DEFAULT_CONFIG; a damaged one is recovered first.
 *
 * Every main-process config write goes through here. The target path is
 * resolved when the call starts, so a write in flight across an account
 * switch lands in the profile it began in, never the next one. A caller that
 * awaits (network, disk) between deciding to write and calling this passes
 * `opts.scope`, the profile it read, so the write cannot follow the switch.
 *
 * A mutate that changes nothing (same serialized config) skips the write.
 */
export async function updateConfig(
  mutate: (current: UserConfig) => UserConfig,
  opts?: { scope?: string },
): Promise<UserConfig> {
  const target =
    opts?.scope !== undefined ? path.join(profileRootFor(opts.scope), 'config.json') : paths.configPath();
  await mkdir(path.dirname(target), { recursive: true });
  let next: UserConfig | undefined;
  await withFileLock(target, async () => {
    const read = (await readConfigAt(target, true))!;
    next = UserConfigSchema.parse(mutate(read.parsed.config));
    await writeConfigLocked(target, next, read);
  });
  return next!;
}

/**
 * Keys "Reset settings" (the safe-mode screen) keeps: identity, account,
 * roster, analytics choices, the update channel, the AI provider, the app
 * language, one-shot migration flags and playtime. Everything else (theme,
 * overlays, voice, vision, game options...) goes back to its default.
 */
export const RESET_KEEP_KEYS: readonly (keyof UserConfig)[] = [
  'mc_username',
  'preferred_name',
  'profile_picture',
  'creation_times',
  'provider',
  'provider_config',
  'ui_language',
  'ai_backend_kind',
  'ai_backend_kind_source',
  'advanced_updates',
  'tutorial_state',
  'skin_setup_pending',
  'removed_default_ids',
  'added_default_ids',
  'added_defaults_backfilled',
  'defaults_to_world_migrated',
  'added_world_ids',
  'has_been_welcomed',
  'feedback_reward_claimed',
  'draw_intro_done',
  'total_playtime_ms',
  'total_playtime_backfilled',
  'user_profile',
  'dynamics_granted',
  'analytics_opt_out',
  'analytics_install_id',
];

/**
 * Safe-mode "Reset settings": keep RESET_KEEP_KEYS, default everything else.
 * The current file is moved aside as `config.before-reset-<stamp>.json`
 * (newest QUARANTINE_KEEP kept), never deleted. Unknown keys are dropped:
 * a reset is meant to clear whatever is breaking the start.
 */
export async function resetConfigKeepingIdentity(opts?: { scope?: string }): Promise<void> {
  const target =
    opts?.scope !== undefined ? path.join(profileRootFor(opts.scope), 'config.json') : paths.configPath();
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    const read = (await readConfigAt(target, true))!;
    const kept: Record<string, unknown> = {};
    for (const key of RESET_KEEP_KEYS) {
      const v = (read.parsed.config as Record<string, unknown>)[key];
      if (v !== undefined) kept[key] = v;
    }
    const next = UserConfigSchema.parse(kept);
    // T283: COPY the old file aside, then replace it, so config.json is never
    // missing in between (a move followed by a failed write left no file, and
    // the next start read defaults). A copy that fails stops the reset: the
    // old file is never replaced without its copy.
    if (read.text !== null) await copyAside(target, read.text, RESET_PREFIX, Date.now());
    await writeFileDurable(target, serializeConfig(next, null));
    heldConfigs.delete(target);
    stuckReported.delete(target);
  });
}

/**
 * The ONLY UserConfig keys a renderer save (config:save IPC) may write.
 *
 * 260725: the renderer's settings surfaces hold a whole-config copy taken at
 * mount and save it back wholesale on every toggle, so anything main wrote in
 * between was silently reverted — the recurring "switched back to local" bug
 * (ai_backend_kind), a mid-call language auto-switch (chat_language), and,
 * with a longer fuse, every other main-owned field: a 2h Minecraft session
 * folds into total_playtime_ms under the lock and the next toggle from a
 * still-mounted Settings screen writes the pre-session value back, losing the
 * playtime for good.
 *
 * Shielding fields one at a time never converges, so the direction is
 * inverted: this allowlist enumerates the settings the RENDERER owns (the
 * onboarding submit, the Settings rows, the sticky UI preferences), and every
 * other field is taken from the on-disk config inside updateConfig's lock. A
 * key the renderer omits keeps its on-disk value, so optional fields are never
 * dropped by a save that predates them.
 *
 * Every other key is main-owned: see MAIN_OWNED_KEYS below.
 * Onboarding still sends several of those (it builds a whole fresh config);
 * dropping its values is safe because a fresh profile's on-disk value is
 * already the schema default, and the one-shot migrations it pre-marks are
 * no-ops on a fresh install.
 */
export const RENDERER_SETTABLE_KEYS: readonly (keyof UserConfig)[] = [
  'mc_username',
  'preferred_name',
  'provider',
  'provider_config',
  'theme_mode',
  'background_opacity',
  'background_brightness',
  'linuxBasicTextWarnDismissed',
  'hide_vanilla_host_warning',
  'hide_modded_host_warning',
  'dev_console_visible',
  'advanced_updates',
  'realistic_typing',
  'call_captions',
  'call_overlay_enabled',
  'avatar_mode',
  'avatar_prefs',
  'avatar_in_captures',
  'call_convo_starters',
  'call_backdrop',
  'chat_panel_hidden',
  'skin_setup_pending',
  'tutorial_state',
  'has_been_welcomed',
  'feedback_reward_claimed',
  // 260926: the free-play-is-back banner's memory of the last wall.
  'free_play_wall',
  'vision_mode',
  'stt_engine',
  'stt_local_fallback',
  'tts_engine',
  'ui_language',
  // 260909: Settings > Games & search > Web search (provider + optional key).
  'web_search_provider',
  'web_search_api_key',
  // 260909: "don't show again" on the Minecraft setup step (useMcSetupStore).
  'mc_setup_dismissed',
];

/**
 * The keys only main writes (each through updateConfig, setting just its own
 * key), with the writer. A renderer save never touches them. Every
 * UserConfig key is in exactly one of the two lists (configStore.test.ts), so
 * a new key has to be classified.
 */
export const MAIN_OWNED_KEYS: readonly (keyof UserConfig)[] = [
  'ai_backend_kind', // apiKeyStore
  'ai_backend_kind_source', // apiKeyStore
  'chat_language', // voice/languageAutoSwitch.ts
  'profile_picture', // userProfile.ts
  'background_image', // backgroundStore.ts
  'creation_times', // characterStore quota
  'added_default_ids', // library IPC handlers, migration.ts
  'added_world_ids', // library IPC handlers, reconcileLocalOwnership, migration.ts
  'removed_default_ids', // legacy, no longer written
  'user_profile', // prefs:save
  'dynamics_granted', // uniqueGeneration.ts
  'analytics_opt_out', // analytics.ts (own IPC)
  'analytics_install_id', // analytics.ts
  'total_playtime_ms', // addPlaytimeMs at session end
  'total_playtime_backfilled', // backfillTotalPlaytimeOnce
  'added_defaults_backfilled', // migration.ts
  'defaults_to_world_migrated', // migration.ts
  'avatar_overlay', // callOverlay.ts
  'avatar_captions', // captionOverlay.ts
  'stardew_appearance', // games/stardew/appearance.ts
  'dst_survivor', // games/dontstarve/survivorPick.ts
  'dst_port', // hand-edited only
  'chess_elo_offsets', // chess/chessDifficulty.ts
  'draw_intro_done', // draw/drawService.ts
  'schema_version', // configStore itself, on every write
];

/**
 * Save a config object that came from the RENDERER (the config:save IPC):
 * renderer-owned settings are taken from the payload, everything else from
 * the freshly-read on-disk config, under the file lock. See
 * RENDERER_SETTABLE_KEYS above for why.
 */
export async function saveConfigFromRenderer(config: UserConfig): Promise<void> {
  const incoming = config as Record<string, unknown>;
  await updateConfig((current) => {
    const next = { ...current } as Record<string, unknown>;
    for (const key of RENDERER_SETTABLE_KEYS) {
      // Absent (an optional field the renderer's copy never carried) → keep disk.
      if (key in incoming) next[key] = incoming[key];
    }
    return next as UserConfig;
  });
}

/**
 * Fold a finished session's duration into the profile's cumulative
 * `total_playtime_ms`. Atomic read-modify-write (updateConfig) so a
 * concurrent settings write can't clobber the increment. Called at session-end so the running total is independent of any single
 * character (it survives a character being deleted). No-op for non-positive
 * deltas. Missing config → seeds from DEFAULT_CONFIG.
 */
export async function addPlaytimeMs(deltaMs: number): Promise<void> {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
  await updateConfig((cfg) => ({
    ...cfg,
    total_playtime_ms: (cfg.total_playtime_ms ?? 0) + Math.round(deltaMs),
  }));
}

/**
 * One-time seed of `total_playtime_ms` from the sum of the profile's existing
 * characters' `playtime_ms`, so historical playtime (which predates the
 * cumulative total) is counted. Guarded by `total_playtime_backfilled` so it
 * runs exactly once per profile. Run at startup AFTER characters are seeded and
 * BEFORE any session can fire. If listing characters fails, the flag is left
 * unset so the next launch retries (no partial backfill committed).
 */
export async function backfillTotalPlaytimeOnce(): Promise<void> {
  const cfg = await loadConfig();
  if (cfg.total_playtime_backfilled) return;
  let sum = 0;
  try {
    const { listCharacters } = await import('./characterStore');
    for (const c of await listCharacters()) sum += Math.max(0, c.playtime_ms ?? 0);
  } catch {
    // Leave the flag unset so the next launch retries rather than committing a
    // zero/partial backfill.
    return;
  }
  await updateConfig((cur) =>
    cur.total_playtime_backfilled
      ? cur
      : {
          ...cur,
          // max() guards the unlikely case where a session already advanced the total
          // before the first backfill ran — never shrink an existing total.
          total_playtime_ms: Math.max(cur.total_playtime_ms ?? 0, sum),
          total_playtime_backfilled: true,
        },
  );
}
