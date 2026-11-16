/**
 * Anonymous(local / own key) → signed-in-account on-device profile import
 * (260603 per-profile partitioning; 261023 existing accounts + merge).
 *
 * With per-profile partitioning, everything a player builds while signed out
 * (own API key, no Sei account) lives in the `local` profile, and signing in
 * re-points the app at the account's profile. On a local→account sign-in we
 * offer to bring that across: their companions, the companions' memories,
 * skins and portraits, plus the mc_username / preferred_name answers.
 *
 * Offered on every local→account sign-in that finds something to bring, for a
 * new account AND an existing one (261023: an existing account used to get no
 * offer, which stranded the local companions). Never offered account→account:
 * switching between accounts always starts fresh (the trial-abuse deterrent:
 * a companion does not follow you to a freshly farmed account).
 *
 * What comes across:
 *   - own companions (made without an account, owner null): stamped with the
 *     account as owner;
 *   - World companions and the former defaults (Sui, Lyra, Marv) that were in
 *     the local roster: copied with their real owner, and added to the
 *     account's roster (added_world_ids). 261023: these used to be either
 *     skipped (defaults) or stamped as the player's own (World companions),
 *     which made the next sign-in sweep delete them as leaked copies;
 *   - memories of companions no longer in the local roster (removed from the
 *     library, memories kept): merged, not re-added to the roster.
 *
 * Merge, never replace: when the account already has the companion (same id),
 * its character JSON, skin, portrait and avatar are kept and the local
 * memories are merged into its memory (memoryMerge.ts). Idempotent: a second
 * run finds nothing left, and a re-run over leftovers adds no duplicates.
 *
 * MOVE semantics: what was imported is removed from the `local` profile, so a
 * later sign-out lands on a clean local state and the offer is not repeated.
 *
 * Precondition for the import: the ACTIVE scope is already the target account
 * (set by profileScope.switchScopeForAuth before this runs), so the character
 * write goes through the normal Zod-validated, index-managed store (re-checked
 * against the scope right before it). File moves and memory merges use paths
 * pinned to the target profile, and the `local` SOURCE is read via
 * scope-independent paths.
 */
import { access, mkdir, rename, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { profileRootFor, getActiveScope, SCOPE_LOCAL } from '../paths';
import {
  CharacterSchema,
  MAX_COMPANION_SLOTS,
  UserConfigSchema,
  countsAsHomeSlot,
  type Character,
} from '../../shared/characterSchema';
import type { LocalImportPartyFit } from '../../shared/ipc';
import { mergeKnowledgeDir, mergeMemoryDir, dirHasFiles } from './memoryMerge';
import { DEFAULT_CHARACTER_UUIDS } from '../defaultCharacters';
import { atomicWrite } from '../../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../../bot/brain/storage/fileLock.js';

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
function localKnowledgeDir(id: string): string { return path.join(localRoot(), 'knowledge', id); }
function localAvatarsDir(id: string): string { return path.join(localRoot(), 'avatars', id); }
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

interface LocalConfigSnapshot {
  mc_username: string;
  preferred_name: string;
  added_world_ids: string[];
  added_default_ids: string[];
}

async function readLocalConfig(): Promise<LocalConfigSnapshot | null> {
  try {
    const cfg = UserConfigSchema.parse(JSON.parse(await readFile(localConfigPath(), 'utf8')));
    return {
      mc_username: cfg.mc_username ?? '',
      preferred_name: cfg.preferred_name ?? '',
      added_world_ids: cfg.added_world_ids ?? [],
      added_default_ids: cfg.added_default_ids ?? [],
    };
  } catch { return null; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function uuidDirNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && UUID_RE.test(e.name))
      .map((e) => e.name);
  } catch { return []; }
}

async function hasLocalMemories(id: string): Promise<boolean> {
  return (await dirHasFiles(localMemoryDir(id))) || (await dirHasFiles(localKnowledgeDir(id)));
}

async function readOrEmpty(p: string): Promise<string> {
  try { return await readFile(p, 'utf8'); } catch { return ''; }
}

/**
 * Whether the player ever did anything with this local companion (261023
 * boot offer): a memory entry, a transcript row of their own (a typed
 * message, or a game played together), a folded chat summary, or a
 * knowledge file. The greeting a companion sends first, the MEMORY.md title
 * block and `## World N` headers, PLAYER.md (seeded with the player's name
 * at summon) and other derived files do not count.
 */
async function localCompanionTouched(id: string): Promise<boolean> {
  if (await dirHasFiles(localKnowledgeDir(id))) return true;
  const dir = localMemoryDir(id);
  for (const f of ['MEMORY.md', 'MEMORY.archive.md']) {
    if ((await readOrEmpty(path.join(dir, f))).split('\n').some((l) => l.startsWith('- '))) return true;
  }
  if ((await exists(path.join(dir, 'bridge.json'))) || (await exists(path.join(dir, 'bridge.prev.json')))) return true;
  for (const line of (await readOrEmpty(path.join(dir, 'chat.jsonl'))).split('\n')) {
    if (!line.trim()) continue;
    try {
      const role = (JSON.parse(line) as { role?: unknown }).role;
      if (role !== 'assistant') return true;
    } catch { /* a torn line is not the player's */ }
  }
  return false;
}

/**
 * Local companions only the app put there: Sui, seeded into the party by the
 * first-run scene, with nothing the player did with her. Bringing her over
 * would add nothing the account cannot get from the World tab, so she alone
 * is not worth a prompt at boot or a Settings row.
 */
async function untouchedSeedIds(ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    if (id === DEFAULT_CHARACTER_UUIDS.sui && !(await localCompanionTouched(id))) out.push(id);
  }
  return out;
}

/**
 * Whether a local character sits in the local roster. Mirrors countsAsHomeSlot
 * for a signed-out profile: an own (owner null) companion always does; a
 * foreign-owned one (a World companion, Sui) only when it was added; a legacy
 * is_default copy only when it was invited.
 */
function inLocalRoster(c: Character, cfg: LocalConfigSnapshot | null): boolean {
  if (c.is_default === true) return (cfg?.added_default_ids ?? []).includes(c.id);
  if (c.owner == null) return true;
  return (cfg?.added_world_ids ?? []).includes(c.id);
}

export interface PeekLocalResult {
  /** Companions in the local roster: own ones, plus added World companions and Sui/Lyra/Marv. */
  migratableCharacterIds: string[];
  /** Not in the local roster, but with memories (or knowledge) still on disk. */
  memoryOnlyCharacterIds: string[];
  mcUsername: string | null;
  preferredName: string | null;
  /** True when there is anything worth offering to import. */
  hasData: boolean;
  /** True when there are companions or memories to bring (not just onboarding answers). */
  hasCompanionData: boolean;
  /** Of the ids above: the app-seeded Sui the player never touched (261023). */
  untouchedSeedIds: string[];
}

/** Inspect the `local` profile for importable data (companions, memories, onboarding answers). */
export async function peekLocalProfile(): Promise<PeekLocalResult> {
  const order = await readLocalIndexOrder();
  const cfg = await readLocalConfig();
  const migratable: string[] = [];
  const memoryOnly: string[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const char = await readLocalCharacter(id);
    if (!char) continue;
    if (inLocalRoster(char, cfg)) migratable.push(id);
    else if (await hasLocalMemories(id)) memoryOnly.push(id);
  }
  // Memories kept for companions whose character file is gone.
  const orphanIds = [
    ...(await uuidDirNames(path.join(localRoot(), 'memory'))),
    ...(await uuidDirNames(path.join(localRoot(), 'knowledge'))),
  ];
  for (const id of orphanIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (await hasLocalMemories(id)) memoryOnly.push(id);
  }
  const mcUsername = cfg?.mc_username ? cfg.mc_username : null;
  const preferredName = cfg?.preferred_name ? cfg.preferred_name : null;
  const hasCompanionData = migratable.length > 0 || memoryOnly.length > 0;
  return {
    migratableCharacterIds: migratable,
    memoryOnlyCharacterIds: memoryOnly,
    mcUsername,
    preferredName,
    hasData: hasCompanionData || mcUsername != null,
    hasCompanionData,
    untouchedSeedIds: await untouchedSeedIds([...migratable, ...memoryOnly]),
  };
}

/**
 * Move a single file or dir local→target when the target has none. When the
 * target already has one, the target's is kept and the local copy dropped.
 */
async function moveUnlessPresent(src: string, dest: string): Promise<void> {
  if (!(await exists(src))) return;
  if (await exists(dest)) {
    await rm(src, { recursive: true, force: true });
    return;
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(src, dest);
}

export interface ImportLocalResult {
  imported: string[];
  failed: string[];
  /** Whether mc_username / preferred_name were copied into the account profile. */
  copiedOnboarding: boolean;
  /** 'party_full' = nothing was imported: the companions would not fit the party (261116). */
  skipped?: 'party_full';
}

/**
 * Whether the local roster fits the account's party (261116). Pure, for the
 * import guard and the peek.
 *
 * Importing used to ignore the party limit: two local companions into an
 * account with three filled the party past MAX_COMPANION_SLOTS, and the Home
 * wall (four panels) and the rail (then also capped) hid the extras. Now an
 * import that would overflow imports nothing (the player frees a slot, then
 * imports from Settings). A local companion the account's party already
 * holds (same id) takes no new slot.
 */
export function partyFitFor(
  accountCharacters: Pick<Character, 'id' | 'is_default' | 'owner'>[],
  accountConfig: { added_default_ids?: string[] | null; added_world_ids?: string[] | null },
  accountId: string,
  localRosterIds: readonly string[],
): LocalImportPartyFit {
  const addedDefaultIds = new Set(accountConfig.added_default_ids ?? []);
  const addedWorldIds = new Set(accountConfig.added_world_ids ?? []);
  const party = new Set(
    accountCharacters
      .filter((c) => countsAsHomeSlot(c, { currentUserId: accountId, addedDefaultIds, addedWorldIds }))
      .map((c) => c.id),
  );
  const incoming = new Set(localRosterIds.filter((id) => !party.has(id))).size;
  return {
    count: party.size,
    incoming,
    limit: MAX_COMPANION_SLOTS,
    fits: incoming === 0 || party.size + incoming <= MAX_COMPANION_SLOTS,
  };
}

/**
 * The party fit of importing `localRosterIds` into the ACTIVE account scope
 * (`accountId` must be it): its characters and roster as they are now.
 */
export async function localImportPartyFit(
  accountId: string,
  localRosterIds: readonly string[],
): Promise<LocalImportPartyFit> {
  const { listCharacters } = await import('../characterStore');
  const { loadConfig } = await import('../configStore');
  const [chars, cfg] = await Promise.all([listCharacters(), loadConfig()]);
  return partyFitFor(chars, cfg, accountId, localRosterIds);
}

/**
 * Import the `local` profile's companions (+ memory/skins/portraits) and
 * onboarding answers into `targetScope` (the freshly signed-in account),
 * merging into whatever the account already has without replacing any of it.
 * Onboarding answers are copied only when the account profile lacks them.
 *
 * @param targetScope must equal the active scope (the signed-in account).
 * @param opts.characterIds optional subset to import (defaults to everything peek finds).
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
  const { updateConfig } = await import('../configStore');

  const peek = await peekLocalProfile();
  const roster = new Set(peek.migratableCharacterIds);
  const candidates = [...peek.migratableCharacterIds, ...peek.memoryOnlyCharacterIds];
  const ids = opts?.characterIds ? candidates.filter((id) => opts.characterIds!.includes(id)) : candidates;
  // 261116: the companions must fit the account's party, or nothing comes
  // across (the local profile is left exactly as it is, for a later import
  // from Settings once a slot is free). The renderer checks first (the
  // peek's `party`); this is the backstop for every entry point.
  const fit = await localImportPartyFit(targetScope, ids.filter((id) => roster.has(id)));
  if (!fit.fits) {
    logger.info(
      `skipped: ${fit.incoming} companion(s) would not fit the party (${fit.count}/${fit.limit}) of ${targetScope}`,
    );
    return { imported: [], failed: [], copiedOnboarding: false, skipped: 'party_full' };
  }

  const imported: string[] = [];
  const failed: string[] = [];
  /** Removed from the local roster/index once their data lives in the account. */
  const clearedFromLocal: string[] = [];
  let rosterChanged = false;
  // An explicit World add in the local roster marks a companion as someone
  // else's even when its local copy lost the owner stamp (a save that raced
  // the stamp, a legacy owner-null cloud row). Claiming it would make the
  // sign-in sweep delete it: the cloud row's owner is not this account and it
  // would not be in added_world_ids.
  const localAddedWorld = new Set((await readLocalConfig())?.added_world_ids ?? []);

  // Target paths are pinned to the TARGET profile, never the active scope: a
  // sign-out mid-companion would otherwise point them at the local profile
  // itself, where "the account already has it" is true of the local file and
  // the local copy is deleted.
  const targetRoot = profileRootFor(targetScope);
  const target = {
    memoryDir: (id: string) => path.join(targetRoot, 'memory', id),
    knowledgeDir: (id: string) => path.join(targetRoot, 'knowledge', id),
    avatarsDir: (id: string) => path.join(targetRoot, 'avatars', id),
    skinPath: (id: string) => path.join(targetRoot, 'skins', `${id}.png`),
    portraitPath: (id: string) => path.join(targetRoot, 'portraits', `${id}.png`),
    charPath: (id: string) => path.join(targetRoot, 'characters', `${id}.json`),
  };
  const scopeMoved = (): boolean => getActiveScope() !== targetScope;

  for (const id of ids) {
    // saveCharacterRaw writes through the ACTIVE scope; if the account changed
    // mid-import, stop rather than write into the next one.
    if (scopeMoved()) {
      logger.warn(`scope moved during import into ${targetScope}; stopping`);
      break;
    }
    try {
      // Memories first, always merged (never replaced). saveCharacterRaw
      // pre-creates an empty target memory dir, which the merge treats as empty.
      await mergeMemoryDir(localMemoryDir(id), target.memoryDir(id));
      await mergeKnowledgeDir(localKnowledgeDir(id), target.knowledgeDir(id));

      if (roster.has(id)) {
        const char = await readLocalCharacter(id);
        if (!char) { failed.push(id); continue; }
        // Own = made without an account (owner null) or already this account's.
        // Anyone else's (a World companion, Sui) keeps its real author: the
        // cloud row's owner is who wrote it, and the sign-in sweep deletes a
        // local copy whose owner disagrees with the cloud.
        const own =
          char.is_default !== true &&
          !localAddedWorld.has(id) &&
          (char.owner == null || char.owner === targetScope);
        await moveUnlessPresent(localAvatarsDir(id), target.avatarsDir(id));
        await moveUnlessPresent(localSkinPath(id), target.skinPath(id));
        await moveUnlessPresent(localPortraitPath(id), target.portraitPath(id));
        // The account's copy of the same companion wins; only a missing one is written.
        if (!(await exists(target.charPath(id)))) {
          // Checked right before the active-scope write; the local character
          // JSON stays put if the scope moved, and the next sign-in offers it.
          if (scopeMoved()) {
            logger.warn(`scope moved before writing ${id}; stopping`);
            failed.push(id);
            break;
          }
          await saveCharacterRaw(own ? { ...char, owner: targetScope } : char);
        }
        // Foreign companions only show on Home when they are in the roster.
        // Recorded BEFORE the local copy is removed, so a crash in between
        // cannot leave an account copy outside the roster (the sweep's leak).
        if (!own) {
          const key = char.is_default === true ? 'added_default_ids' : 'added_world_ids';
          await updateConfig(
            (cfg) => {
              const list = cfg[key] ?? [];
              if (list.includes(id)) return cfg;
              rosterChanged = true;
              return { ...cfg, [key]: [...list, id] };
            },
            { scope: targetScope },
          );
        }
        try { await rm(localCharPath(id), { force: true }); } catch { /* best-effort */ }
        clearedFromLocal.push(id);
      }
      imported.push(id);
    } catch (err) {
      logger.warn(`failed to import ${id}: ${(err as Error).message}`);
      failed.push(id);
    }
  }

  if (rosterChanged) {
    void import('../cloud/librarySync')
      .then((m) => m.syncLibraryRoster('local-import'))
      .catch(() => {});
  }

  // Leave the local profile clean: drop what moved from its index and roster.
  if (clearedFromLocal.length > 0) {
    const nextLocalOrder = (await readLocalIndexOrder()).filter((x) => !clearedFromLocal.includes(x));
    await writeLocalIndexOrder(nextLocalOrder);
    const localCfg = await readLocalConfig();
    const inLocalCfg = (x: string): boolean =>
      !!localCfg && (localCfg.added_world_ids.includes(x) || localCfg.added_default_ids.includes(x));
    if (clearedFromLocal.some(inLocalCfg)) {
      await updateConfig(
        (cfg) => ({
          ...cfg,
          added_world_ids: (cfg.added_world_ids ?? []).filter((x) => !clearedFromLocal.includes(x)),
          added_default_ids: (cfg.added_default_ids ?? []).filter((x) => !clearedFromLocal.includes(x)),
        }),
        { scope: SCOPE_LOCAL },
      );
    }
  }

  // Copy onboarding answers into the account profile only if it lacks them.
  let copiedOnboarding = false;
  const localCfg = await readLocalConfig();
  if (localCfg && (localCfg.mc_username || localCfg.preferred_name)) {
    await updateConfig(
      (targetCfg) => {
        const patch: Partial<typeof targetCfg> = {};
        if (!(targetCfg.mc_username ?? '').trim() && localCfg.mc_username) patch.mc_username = localCfg.mc_username;
        if (!(targetCfg.preferred_name ?? '').trim() && localCfg.preferred_name) patch.preferred_name = localCfg.preferred_name;
        copiedOnboarding = Object.keys(patch).length > 0;
        return copiedOnboarding ? { ...targetCfg, ...patch } : targetCfg;
      },
      // The account being imported into, even if the scope moved during the
      // character copy above.
      { scope: targetScope },
    );
  }

  logger.info(
    `imported ${imported.length} companion(s) into ${targetScope} (${failed.length} failed); onboarding copied: ${copiedOnboarding}`,
  );
  return { imported, failed, copiedOnboarding };
}
