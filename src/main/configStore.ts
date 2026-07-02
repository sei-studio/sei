/**
 * UserConfig persistence: <userData>/config.json.
 * Reads/writes are Zod-validated and atomic.
 *
 * Sources:
 *   - PATTERNS §src/main/configStore.ts
 *   - CONTEXT D-09 (path), D-12 (schema — no api_key)
 *   - Reuse: src/bot/brain/storage/atomicWrite.js + fileLock.js
 *
 * Phase 13 13-02 (D-57): UserConfigSchema (in src/shared/characterSchema.ts)
 * now carries `ai_backend_kind: 'local' | 'cloud-proxy'` — the single source
 * of truth for whether the bot routes through BYOK (api-key.bin) or Sei's
 * cloud proxy. Read/write via `apiKeyStore.{getAiBackendKind,setAiBackendKind}`
 * — never read the raw field on UserConfig directly so the default
 * fall-through stays inside one helper.
 */
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { UserConfigSchema, type UserConfig } from '../shared/characterSchema';
// ESM imports of existing brain JS helpers (.js extension required under nodenext-style resolution).
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules at compile time.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';

export const DEFAULT_CONFIG: UserConfig = UserConfigSchema.parse({});

/**
 * Load config. Missing file → return DEFAULT_CONFIG.
 * Legacy `persona` field (from CLI users) is silently stripped — migration
 * runFirstLaunchMigration handles transferring it to characters/sui.json.
 */
export async function loadConfig(): Promise<UserConfig> {
  let raw: string;
  try {
    raw = await readFile(paths.configPath(), 'utf8');
  } catch (err: unknown) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new Error(`Invalid JSON in ${paths.configPath()}: ${(err as Error).message}`);
  }

  // Strip legacy fields the schema doesn't know about (persona, anthropic.api_key, etc.)
  // UserConfigSchema only knows mc_username/preferred_name/provider/theme_mode.
  return UserConfigSchema.parse(parsed);
}

export async function saveConfig(config: UserConfig): Promise<void> {
  const validated = UserConfigSchema.parse(config);
  const target = paths.configPath();
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });
}

/**
 * Fold a finished session's duration into the profile's cumulative
 * `total_playtime_ms`. Atomic read-modify-write under the same file lock as
 * saveConfig so a concurrent settings write can't clobber the increment.
 * Called at session-end so the running total is independent of any single
 * character (it survives a character being deleted). No-op for non-positive
 * deltas. Missing config → seeds from DEFAULT_CONFIG.
 */
export async function addPlaytimeMs(deltaMs: number): Promise<void> {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
  const target = paths.configPath();
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    let cfg: UserConfig;
    try {
      cfg = UserConfigSchema.parse(JSON.parse(await readFile(target, 'utf8')));
    } catch (err: unknown) {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') cfg = { ...DEFAULT_CONFIG };
      else throw err;
    }
    const next = UserConfigSchema.parse({
      ...cfg,
      total_playtime_ms: (cfg.total_playtime_ms ?? 0) + Math.round(deltaMs),
    });
    await atomicWrite(target, JSON.stringify(next, null, 2) + '\n');
  });
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
  await saveConfig({
    ...cfg,
    // max() guards the unlikely case where a session already advanced the total
    // before the first backfill ran — never shrink an existing total.
    total_playtime_ms: Math.max(cfg.total_playtime_ms ?? 0, sum),
    total_playtime_backfilled: true,
  });
}
