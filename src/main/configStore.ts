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
import { paths, profileRootFor } from './paths';

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
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });
}

/**
 * Atomic read-modify-write of the config under the file lock: `mutate`
 * receives the freshly-read config and returns the next one. Use this — not
 * loadConfig() → saveConfig() — for any update that must not clobber or be
 * clobbered by a concurrent writer (TOCTOU): a read taken before an await
 * elsewhere can be stale by the time it is written back. Missing config
 * seeds from DEFAULT_CONFIG.
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
    let raw: string | null = null;
    let cfg: UserConfig;
    try {
      raw = await readFile(target, 'utf8');
      cfg = UserConfigSchema.parse(JSON.parse(raw));
    } catch (err: unknown) {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') cfg = { ...DEFAULT_CONFIG };
      else throw err;
    }
    next = UserConfigSchema.parse(mutate(cfg));
    const text = JSON.stringify(next, null, 2) + '\n';
    if (text === raw) return;
    await atomicWrite(target, text);
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
  // 260909: Settings > Search (web search provider + optional key).
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
