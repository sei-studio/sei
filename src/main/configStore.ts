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
 * Atomic read-modify-write of the config under the file lock: `mutate`
 * receives the freshly-read config and returns the next one. Use this — not
 * loadConfig() → saveConfig() — for any update that must not clobber or be
 * clobbered by a concurrent writer (TOCTOU): a read taken before an await
 * elsewhere can be stale by the time it is written back. Same pattern as
 * addPlaytimeMs below. Missing config seeds from DEFAULT_CONFIG.
 */
export async function updateConfig(
  mutate: (current: UserConfig) => UserConfig,
): Promise<UserConfig> {
  const target = paths.configPath();
  await mkdir(path.dirname(target), { recursive: true });
  let next: UserConfig | undefined;
  await withFileLock(target, async () => {
    let cfg: UserConfig;
    try {
      cfg = UserConfigSchema.parse(JSON.parse(await readFile(target, 'utf8')));
    } catch (err: unknown) {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') cfg = { ...DEFAULT_CONFIG };
      else throw err;
    }
    next = UserConfigSchema.parse(mutate(cfg));
    await atomicWrite(target, JSON.stringify(next, null, 2) + '\n');
  });
  return next!;
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
 * Deliberately NOT here (main is the only legitimate writer):
 *   ai_backend_kind / ai_backend_kind_source  apiKeyStore.setAiBackendKind
 *   chat_language                             voice/languageAutoSwitch.ts
 *   profile_picture / background_image        userProfile.ts / backgroundStore.ts
 *   creation_times                            characterStore quota
 *   removed_/added_default_ids, added_world_ids   library IPC handlers
 *   user_profile, dynamics_granted            prefs:save / uniqueGeneration.ts
 *   analytics_opt_out, analytics_install_id   analytics.ts (own IPC)
 *   total_playtime_ms + the one-shot migration markers   session end / migration.ts
 * Onboarding still sends several of those (it builds a whole fresh config);
 * dropping its values is safe because a fresh profile's on-disk value is
 * already the schema default, and the one-shot migrations it pre-marks are
 * no-ops on a fresh install.
 */
const RENDERER_SETTABLE_KEYS: readonly (keyof UserConfig)[] = [
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
  'call_convo_starters',
  'chat_panel_hidden',
  'skin_setup_pending',
  'has_been_welcomed',
  'feedback_reward_claimed',
  'vision_mode',
  'stt_engine',
  'stt_local_fallback',
  'ui_language',
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
