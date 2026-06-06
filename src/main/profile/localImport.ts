/**
 * One-time anonymous(local) → signed-in-account on-device profile import
 * (260603 per-profile partitioning).
 *
 * With per-profile partitioning, signing into a brand-new account yields an
 * EMPTY profile — the companion the user built before creating an account stays
 * behind in the `local` profile. On the FIRST sign-in (local → a fresh account)
 * we offer to bring that companion across: user-created characters + their
 * (local-only) memory, skins, and portraits, plus the mc_username /
 * preferred_name onboarding answers.
 *
 * This is OFFERED only on the local→account transition, never account→account —
 * switching between accounts always starts fresh (that's both the product
 * intent and the trial-abuse deterrent: the companion you're attached to does
 * not follow you to a freshly-farmed account).
 *
 * MOVE semantics (atomic per-item rename): once imported, the data lives under
 * the account profile and the `local` profile is left clean, so a later
 * sign-out lands on a genuinely fresh local state.
 *
 * Precondition for the import: the ACTIVE scope is already the target account
 * (set by profileScope.switchScopeForAuth before this runs), so target writes
 * go through the normal Zod-validated, index-managed stores; only the `local`
 * SOURCE is read via scope-independent paths.
 */
import { access, mkdir, rename, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { paths, profileRootFor, getActiveScope, SCOPE_LOCAL } from '../paths';
import { CharacterSchema, UserConfigSchema, type Character } from '../../shared/characterSchema';
import { DEFAULT_CHARACTER_UUIDS } from '../defaultCharacters';
import { atomicWrite } from '../../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../../bot/brain/storage/fileLock.js';

const DEFAULT_IDS = new Set<string>(Object.values(DEFAULT_CHARACTER_UUIDS));

const logger = {
  info: (m: string) => console.log(`[sei] local-import: ${m}`),
  warn: (m: string) => console.warn(`[sei] local-import: ${m}`),
};

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// ── local (source) profile readers — scope-independent, never the active scope.
function localRoot(): string { return profileRootFor(SCOPE_LOCAL); }
function localCharsDir(): string { return path.join(localRoot(), 'characters'); }
function localCharPath(id: string): string { return path.join(localCharsDir(), `${id}.json`); }
function localIndexPath(): string { return path.join(localCharsDir(), 'index.json'); }
function localConfigPath(): string { return path.join(localRoot(), 'config.json'); }
function localMemoryDir(id: string): string { return path.join(localRoot(), 'memory', id); }
function localSkinPath(id: string): string { return path.join(localRoot(), 'skins', `${id}.png`); }
function localPortraitPath(id: string): string { return path.join(localRoot(), 'portraits', `${id}.png`); }

async function readLocalIndexOrder(): Promise<string[]> {
  try {
    const raw = await readFile(localIndexPath(), 'utf8');
    const parsed = JSON.parse(raw) as { order?: unknown };
    return Array.isArray(parsed.order) ? parsed.order.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

async function writeLocalIndexOrder(order: string[]): Promise<void> {
  await mkdir(localCharsDir(), { recursive: true });
  await withFileLock(localIndexPath(), async () => {
    await atomicWrite(localIndexPath(), JSON.stringify({ version: 1, order }, null, 2) + '\n');
  });
}

async function readLocalCharacter(id: string): Promise<Character | null> {
  try {
    const parsed = CharacterSchema.safeParse(JSON.parse(await readFile(localCharPath(id), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

async function readLocalConfig(): Promise<{ mc_username: string; preferred_name: string } | null> {
  try {
    const cfg = UserConfigSchema.parse(JSON.parse(await readFile(localConfigPath(), 'utf8')));
    return { mc_username: cfg.mc_username ?? '', preferred_name: cfg.preferred_name ?? '' };
  } catch { return null; }
}

export interface PeekLocalResult {
  /** Non-default, user-created character ids present in the local profile. */
  migratableCharacterIds: string[];
  mcUsername: string | null;
  preferredName: string | null;
  /** True when there is anything worth offering to import. */
  hasData: boolean;
}

/** Inspect the `local` profile for importable data (characters / onboarding answers). */
export async function peekLocalProfile(): Promise<PeekLocalResult> {
  const order = await readLocalIndexOrder();
  const migratable: string[] = [];
  for (const id of order) {
    if (DEFAULT_IDS.has(id)) continue;
    const char = await readLocalCharacter(id);
    if (char && !char.is_default) migratable.push(id);
  }
  const cfg = await readLocalConfig();
  const mcUsername = cfg?.mc_username ? cfg.mc_username : null;
  const preferredName = cfg?.preferred_name ? cfg.preferred_name : null;
  return {
    migratableCharacterIds: migratable,
    mcUsername,
    preferredName,
    hasData: migratable.length > 0 || mcUsername != null,
  };
}

/** Move a single file local→target if the source exists and the target doesn't. */
async function moveFileIfPresent(src: string, dest: string): Promise<void> {
  if (!(await exists(src)) || (await exists(dest))) return;
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(src, dest);
}

export interface ImportLocalResult {
  imported: string[];
  failed: string[];
  /** Whether mc_username / preferred_name were copied into the account profile. */
  copiedOnboarding: boolean;
}

/**
 * Import the `local` profile's user-created characters (+ memory/skins/portraits)
 * and onboarding answers into `targetScope` (the freshly signed-in account).
 * Defaults are never moved (the account has its own seeded set). Onboarding
 * answers are copied only when the account profile doesn't already have them.
 *
 * @param targetScope must equal the active scope (the signed-in account).
 * @param opts.characterIds optional subset to import (defaults to all migratable).
 */
export async function importLocalProfileInto(
  targetScope: string,
  opts?: { characterIds?: string[] },
): Promise<ImportLocalResult> {
  if (targetScope === SCOPE_LOCAL) {
    throw new Error('local-import: refusing to import the local profile into itself');
  }
  if (getActiveScope() !== targetScope) {
    // Target writes go through the active-scope stores; the caller must have
    // switched scope first. Fail loudly rather than write into the wrong bucket.
    throw new Error(`local-import: active scope ${getActiveScope()} !== target ${targetScope}`);
  }

  const { saveCharacterRaw } = await import('../characterStore');
  const { loadConfig, saveConfig } = await import('../configStore');

  const peek = await peekLocalProfile();
  const requested = opts?.characterIds ?? peek.migratableCharacterIds;
  const ids = requested.filter((id) => peek.migratableCharacterIds.includes(id));

  const imported: string[] = [];
  const failed: string[] = [];

  for (const id of ids) {
    try {
      const char = await readLocalCharacter(id);
      if (!char || char.is_default) { failed.push(id); continue; }
      // Move local-only assets across FIRST — saveCharacterRaw pre-creates the
      // target memory dir, which would otherwise make the dir move a no-op.
      await moveFileIfPresent(localMemoryDir(id), paths.memoryDir(id));
      await moveFileIfPresent(localSkinPath(id), paths.skinPngPath(id));
      await moveFileIfPresent(localPortraitPath(id), paths.portraitPath(id));
      // Then write the character into the account (stamp ownership so the
      // renderer/cloud ownership checks treat it as the account's own).
      await saveCharacterRaw({ ...char, owner: targetScope });
      // Remove the source character JSON now that it lives in the account.
      try { await rm(localCharPath(id), { force: true }); } catch { /* best-effort */ }
      imported.push(id);
    } catch (err) {
      logger.warn(`failed to import ${id}: ${(err as Error).message}`);
      failed.push(id);
    }
  }

  // Drop imported ids from the local index so the local profile is left clean.
  if (imported.length > 0) {
    const nextLocalOrder = (await readLocalIndexOrder()).filter((x) => !imported.includes(x));
    await writeLocalIndexOrder(nextLocalOrder);
  }

  // Copy onboarding answers into the account profile only if it lacks them.
  let copiedOnboarding = false;
  const localCfg = await readLocalConfig();
  if (localCfg && (localCfg.mc_username || localCfg.preferred_name)) {
    const targetCfg = await loadConfig();
    const patch: Partial<typeof targetCfg> = {};
    if (!(targetCfg.mc_username ?? '').trim() && localCfg.mc_username) patch.mc_username = localCfg.mc_username;
    if (!(targetCfg.preferred_name ?? '').trim() && localCfg.preferred_name) patch.preferred_name = localCfg.preferred_name;
    if (Object.keys(patch).length > 0) {
      await saveConfig({ ...targetCfg, ...patch });
      copiedOnboarding = true;
    }
  }

  logger.info(`imported ${imported.length} character(s) into ${targetScope}; onboarding copied: ${copiedOnboarding}`);
  return { imported, failed, copiedOnboarding };
}
