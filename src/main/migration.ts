/**
 * First-launch migration. Idempotent.
 *
 * Sources:
 *   - CONTEXT D-10 (legacy persona → characters/sui.json)
 *   - RESEARCH §Resolved Q4 (TREAT AS FRESH — no cross-machine migration)
 *   - PATTERNS §"Idempotent migrations" (early-return pattern)
 *
 * Scope (v1):
 *   - Dev-clone case: user runs Electron app from same cwd that has CLI's config.json.
 *     We pull persona out and write characters/sui.json, then strip persona from cwd config.
 *   - Packaged-app case: cwd has no legacy file → no-op. Per RESEARCH §Resolved Q4
 *     packaged users start fresh — we do NOT attempt cross-machine memory migration.
 */
import { readFile, writeFile, access, rename, unlink, mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';
import { saveCharacter } from './characterStore';
import { paths } from './paths';
import type { Character } from '../shared/characterSchema';
import { DEFAULT_CHARACTER_UUIDS, DEFAULT_CHARACTERS_OWNER } from './defaultCharacters';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; }
  catch { return false; }
}

interface LegacyPersona {
  name?: string;
  backstory?: string;
  tone?: string;
}

interface LegacyConfigShape {
  persona?: LegacyPersona;
  [key: string]: unknown;
}

/**
 * Run on app boot, AFTER app.whenReady so userData path resolves.
 *
 * @param cwdConfigPath  Path to the legacy CLI's config.json (defaults to './config.json' in cwd).
 *                       Tests can pass a fixture path.
 */
export async function runFirstLaunchMigration(
  cwdConfigPath: string = path.resolve(process.cwd(), 'config.json'),
): Promise<void> {
  // Idempotent guard: already migrated → no-op
  if (await fileExists(paths.characterPath('sui'))) {
    return;
  }

  // No legacy file → nothing to migrate (packaged-app case)
  if (!await fileExists(cwdConfigPath)) {
    return;
  }

  let raw: string;
  try { raw = await readFile(cwdConfigPath, 'utf8'); }
  catch (err) {
    logger.warn(`migration: legacy config read failed: ${(err as Error).message}`);
    return;
  }

  let parsed: LegacyConfigShape;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    logger.warn(`migration: legacy config invalid JSON, skipping: ${(err as Error).message}`);
    return;
  }

  if (!parsed.persona || typeof parsed.persona !== 'object') {
    return; // already migrated or never had a persona
  }

  // 260516-0yw: emit the new persona shape { source, expanded:'' }. Migration
  // uses RAW saveCharacter (NOT expandAndSaveCharacter) so first-launch does
  // NOT burn an Anthropic API call on a freshly-cloned dev tree. The first
  // time the user opens the migrated character in the GUI to summon, the bot
  // will throw an explicit error ("persona expansion missing — re-save the
  // character in the GUI to populate persona.expanded") prompting a re-save.
  // The renderer can also show a "Generate expanded persona" CTA on the Edit
  // modal when persona.expanded is empty.
  const p = parsed.persona;
  const character: Character = {
    id: 'sui',
    kind: 'custom',
    public_id: null,
    name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Sui',
    persona: {
      source: typeof p.backstory === 'string' && p.backstory.trim()
        ? p.backstory
        : 'A curious companion who enjoys exploring blocky worlds alongside their friend.',
      expanded: '',
    },
    is_default: true,
    // Phase 11 schema fields (D-16, D-23, D-24). This legacy migration path
    // produces a row that Plan 11-05's slug→UUID migration will rewrite —
    // until then the runtime value here matches the schema defaults so
    // Zod-parse-on-read keeps working.
    shared: true,
    slug: 'sui',
    metadata: {},
    created: new Date().toISOString(),
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    // New schema fields. Migrated legacy sui has no skin yet —
    // first-launch seedDefaultCharacters won't run for an already-existing id,
    // so the migrated sui stays on the 'none' skin until the user picks one.
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
  };

  try {
    await saveCharacter(character);
    logger.info(`migration: created characters/sui.json from legacy persona (persona.expanded empty — user must re-save in the GUI to populate the LLM-expanded prompt before first summon)`);
  } catch (err) {
    logger.warn(`migration: saveCharacter failed: ${(err as Error).message}`);
    return;
  }

  // Strip persona from legacy file (idempotent — running twice is harmless).
  // Only attempt to mutate the cwd legacy file when running
  // unpackaged (dev clone). In packaged builds the cwd is typically the
  // installer dir / signed Sei.app bundle, which is read-only — writeFile
  // would throw EROFS and noisily mark the otherwise-clean migration as
  // failed. Skipping the strip-write in packaged mode is harmless because
  // packaged users never had a legacy CLI cwd config to begin with (per
  // RESEARCH §Resolved Q4 — packaged users start fresh).
  const { persona, ...rest } = parsed;
  void persona;
  if (!app.isPackaged) {
    try {
      await writeFile(cwdConfigPath, JSON.stringify(rest, null, 2) + '\n', 'utf8');
      logger.info(`migration: stripped persona field from ${cwdConfigPath}`);
    } catch (err) {
      logger.warn(`migration: failed to strip persona from legacy config: ${(err as Error).message}`);
    }
  } else {
    logger.info('migration: skipping cwd config strip-write in packaged build (read-only bundle)');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// added_default_ids backfill — Home defaults must survive the upgrade.
//
// The Home visibility model inverted from removed_default_ids (a default is
// SHOWN unless removed) to added_default_ids (a default is HIDDEN unless
// invited into a slot). Nothing seeds added_default_ids, so a pre-existing
// user who had Sui/Lyra/Clawd on Home (local is_default copies, never removed)
// would see all three vanish from the party wall + IconRail after updating.
//
// This one-shot, idempotent backfill seeds added_default_ids with the ids of
// any locally-present is_default characters on the first boot after upgrade so
// previously-seeded defaults stay on Home. Idempotency + "runs once" is gated
// by config.added_defaults_backfilled. A fresh install has no local is_default
// copies (it gets cloud-sourced defaults), so the backfill adds nothing and
// just flips the marker — no re-seeding.
// ──────────────────────────────────────────────────────────────────────────

export async function runAddedDefaultsBackfill(): Promise<void> {
  const { loadConfig, updateConfig } = await import('./configStore');
  const config = await loadConfig();
  // One-shot gate: already backfilled → no-op.
  if (config.added_defaults_backfilled) return;

  const { listCharacters } = await import('./characterStore');
  let localDefaultIds: string[];
  try {
    const chars = await listCharacters();
    localDefaultIds = chars.filter((c) => c.is_default === true).map((c) => c.id);
  } catch (err) {
    // Leave the marker unset so the next boot retries rather than permanently
    // losing the defaults on a transient read failure.
    logger.warn(`added-defaults backfill: listCharacters failed, will retry next boot: ${(err as Error).message}`);
    return;
  }

  await updateConfig((cur) => {
    if (cur.added_defaults_backfilled) return cur; // re-check under the lock
    const merged = new Set<string>([...(cur.added_default_ids ?? []), ...localDefaultIds]);
    return { ...cur, added_default_ids: [...merged], added_defaults_backfilled: true };
  });
  logger.info(`added-defaults backfill: kept ${localDefaultIds.length} seeded default(s) on Home`);
}

// ──────────────────────────────────────────────────────────────────────────
// 260706 — Defaults → normal user-owned public World characters.
//
// The three shipped defaults (sui/lyra/marv) used to be read-only bundled
// `is_default` copies, hidden from cloud sync and hard-labelled "by Sei". They
// are now ordinary PUBLIC World characters owned by DEFAULT_CHARACTERS_OWNER
// (the ouen@sei.gg account), authored in-app like any other shared character;
// their cloud rows are `shared`, `moderation_status='clean'`, owner=that account.
//
// This one-shot, idempotent migration converts any locally-present `is_default`
// copy left over from an older build into that new model:
//   - is_default:false  → makes it editable-by-owner, unblocks cloud mirroring
//                          and the cache-on-demand refresh (both skip is_default)
//   - owner = DEFAULT_CHARACTERS_OWNER → so countsAsHomeSlot treats it as an
//                          own char for that account and a foreign World char
//                          for everyone else
//   - shared:true       → keeps it discoverable / re-shareable on save
//   - cloud_updated_at:null → forces refreshFromCloud to re-pull the authoritative
//                          cloud persona/art on next open, normalising the local
//                          copy (bundle → cloud)
// and moves each id from added_default_ids → added_world_ids so a user who had
// invited a default keeps it on Home under the new foreign-owned code path.
//
// Fresh installs have no local is_default copies → the migration touches nothing
// and just flips the marker. Idempotency + "runs once" gated by
// config.defaults_to_world_migrated. A transient listCharacters failure leaves
// the marker unset so the next boot retries rather than stranding the defaults.
// ──────────────────────────────────────────────────────────────────────────

export async function runDefaultsToWorldMigration(): Promise<void> {
  const { loadConfig, updateConfig } = await import('./configStore');
  const { listCharacters, saveCharacterRaw } = await import('./characterStore');
  const defaultIds = new Set<string>(Object.values(DEFAULT_CHARACTER_UUIDS));
  const config = await loadConfig();

  let chars;
  try {
    chars = await listCharacters();
  } catch (err) {
    // Transient read failure: bail so the next boot retries rather than
    // permanently freezing the defaults in the old model.
    logger.warn(
      `defaults→world migration: listCharacters failed, will retry next boot: ${(err as Error).message}`,
    );
    return;
  }

  // Any frozen-default copy NOT already in the final shape (normal owned public
  // character: is_default:false, owner=DEFAULT_CHARACTERS_OWNER, kind:'custom').
  // Deliberately NOT gated by the one-shot marker: this heals both
  //   (a) never-converted copies (is_default:true), and
  //   (b) PARTIALLY-converted copies left by an older build of this migration —
  //       e.g. is_default:false but kind still 'world' on a default the user
  //       never opened (open triggers refreshFromCloud, which adopts kind; an
  //       un-opened one like Lyra keeps 'world' and stays view-only).
  // State-idempotent: a copy already in the final shape is skipped, so once
  // healed this is a no-op and safe to run every boot.
  const needsHeal = chars.filter(
    (c) =>
      defaultIds.has(c.id) &&
      (c.is_default === true || c.kind !== 'custom' || c.owner !== DEFAULT_CHARACTERS_OWNER),
  );
  if (needsHeal.length) {
    logger.info(`defaults→world migration: healing ${needsHeal.length} default(s)`);
  }

  let anyFailed = false;
  for (const c of needsHeal) {
    const wasDefault = c.is_default === true;
    try {
      await saveCharacterRaw({
        ...c,
        is_default: false,
        owner: DEFAULT_CHARACTERS_OWNER,
        // Reclassify to 'custom' so CharacterPage's kind-gated viewOnly
        // (isNonEditableKind = kind !== 'custom') lets the owner edit them.
        kind: 'custom',
        // Force public ONLY on the initial is_default→World conversion; a later
        // repair (kind/owner) must preserve whatever share state the user chose.
        shared: wasDefault ? true : c.shared,
        // Bust the refresh watermark on the initial conversion so
        // refreshFromCloud adopts the authoritative cloud persona/art; a repair
        // leaves it so we don't force a re-pull that could revert a local edit.
        cloud_updated_at: wasDefault ? null : (c.cloud_updated_at ?? null),
      });
      logger.info(`defaults→world migration: healed ${c.name} (${c.id})`);
    } catch (err) {
      anyFailed = true;
      logger.warn(
        `defaults→world migration: FAILED to heal ${c.id}: ${(err as Error).message}`,
      );
    }
  }

  // One-shot Home-placement move: added_default_ids → added_world_ids so an
  // invited default keeps its Home slot under the foreign-owned World code path.
  // Gated by the marker (runs once); the character heal above is state-idempotent
  // and runs every boot until nothing needs healing.
  if (!config.defaults_to_world_migrated && !anyFailed) {
    await updateConfig((cur) => {
      if (cur.defaults_to_world_migrated) return cur; // re-check under the lock
      const wasInvited = (cur.added_default_ids ?? []).filter((id) => defaultIds.has(id));
      const addedDefault = (cur.added_default_ids ?? []).filter((id) => !defaultIds.has(id));
      const addedWorld = [...new Set([...(cur.added_world_ids ?? []), ...wasInvited])];
      return {
        ...cur,
        added_default_ids: addedDefault,
        added_world_ids: addedWorld,
        defaults_to_world_migrated: true,
      };
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 11 D-23 — Slug→UUID one-shot rename migration.
//
// Source: 11-RESEARCH §Pattern 6 (full step sequence) + §Pitfall 7 (boot
// order). Idempotent via paths.migrationManifestPath() — existence of the
// manifest file means migration has completed for this install.
//
// Runs PURELY LOCAL — no Supabase code paths. Cloud sync runs later through
// Plans 11-07/11-08 gated on isCloudWriteAllowed(). The migration must run
// BEFORE botSupervisor is wired (Pitfall 7) — see src/main/index.ts.
// ──────────────────────────────────────────────────────────────────────────

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/i;

interface UuidRenameManifest {
  migratedAt: string;
  entries: Array<{ oldSlug: string; newId: string }>;
}

async function writeMigrationManifest(data: UuidRenameManifest): Promise<void> {
  const target = paths.migrationManifestPath();
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(data, null, 2) + '\n');
  });
}

/**
 * One-shot rename: local slug-keyed character files → UUID-keyed files.
 *
 * Steps (in order; idempotency-safe because manifest is LAST):
 *   1. Short-circuit if paths.migrationManifestPath() exists
 *   2. Read characters/index.json; if missing, write empty manifest and return
 *   3. For each entry in index.order: if not a UUID v4, resolve target UUID
 *      (frozen for sui/lyra/clawd; randomUUID() otherwise), rewrite JSON +
 *      decode any data: portrait_image into portraits/<uuid>.png, rename
 *      skin PNG + memory/<slug>/ dir, delete the old slug JSON
 *   4. Update characters/index.json `order` array entries to UUIDs
 *   5. Update defaults-seeded.json `ids` array to UUIDs (if file exists)
 *   6. Write manifest (idempotency gate)
 *
 * Per-character failures are logged and skipped — the rest of the chars
 * still migrate. A second launch will re-run idempotently on any survivors
 * (their slug-keyed JSON still on disk → still in index.order → still picked
 * up). The manifest is only written if at least the top-level scan
 * completed; a hard error mid-loop throws (manifest stays absent, next
 * launch retries).
 */
export async function runUuidRenameMigration(): Promise<void> {
  const log = {
    info: (m: string) => console.log(`[sei] uuid-rename: ${m}`),
    warn: (m: string) => console.warn(`[sei] uuid-rename: ${m}`),
  };

  // Idempotency gate. Already UUID-migrated (the common upgrade case): skip the
  // rename but STILL run the added_default_ids backfill — those users need their
  // seeded Home defaults kept, and their character ids are already UUIDs.
  if (await fileExists(paths.migrationManifestPath())) {
    await runAddedDefaultsBackfill();
    return;
  }

  const indexPath = paths.indexPath();

  let indexData: { version: number; order: string[] };
  try {
    const raw = await readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: number; order?: unknown };
    indexData = {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      order: Array.isArray(parsed.order) ? (parsed.order.filter(x => typeof x === 'string') as string[]) : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.info('no characters/index.json — fresh install, marking manifest');
      await writeMigrationManifest({ migratedAt: new Date().toISOString(), entries: [] });
      return;
    }
    throw err;
  }

  const manifest: Array<{ oldSlug: string; newId: string }> = [];

  for (const oldId of indexData.order) {
    if (UUID_V4_RE.test(oldId)) {
      // Already migrated for this entry — pass it through unchanged
      manifest.push({ oldSlug: oldId, newId: oldId });
      continue;
    }

    // Resolve target UUID: frozen for bundled defaults, fresh randomUUID for user-created.
    // 'clawd' is Marv's HISTORICAL slug (the bundle files were renamed clawd → marv);
    // its UUID is unchanged, so an old slug-keyed install still migrates to the same character.
    let newId: string;
    if (oldId === 'sui' || oldId === 'lyra') {
      newId = DEFAULT_CHARACTER_UUIDS[oldId];
    } else if (oldId === 'clawd') {
      newId = DEFAULT_CHARACTER_UUIDS.marv;
    } else {
      newId = randomUUID();
    }

    const oldJsonPath = paths.characterPath(oldId);
    const newJsonPath = paths.characterPath(newId);

    let charData: Record<string, unknown>;
    try {
      charData = JSON.parse(await readFile(oldJsonPath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      log.warn(`skipping ${oldId}: failed to read ${oldJsonPath}: ${(err as Error).message}`);
      continue;
    }

    // Rewrite id + slug + Phase 11 schema fields (D-16/D-23/D-24). A historical
    // 'clawd' install adopts the renamed 'marv' slug so bundled-skin resolution
    // (resources/skins/<slug>.png) finds the renamed file; refreshSeededDefaults
    // re-asserts it too, but doing it here keeps the migrated copy correct at once.
    charData.id = newId;
    charData.slug = oldId === 'clawd' ? 'marv' : oldId;
    if (charData.shared === undefined) charData.shared = true;
    if (charData.metadata === undefined) charData.metadata = {};

    // Portrait migration: decode data URL → write PNG file → replace field
    // with the local-cache filename. Plan 11-06 resolves filename→full URL
    // (local file:// for cache hit; Storage public URL for cloud fallback).
    const portrait = typeof charData.portrait_image === 'string' ? charData.portrait_image : null;
    if (portrait && DATA_URL_RE.test(portrait)) {
      const commaIdx = portrait.indexOf(',');
      const b64 = portrait.slice(commaIdx + 1);
      const bytes = Buffer.from(b64, 'base64');
      await mkdir(paths.portraitsDir(), { recursive: true });
      await withFileLock(paths.portraitPath(newId), async () => {
        await atomicWrite(paths.portraitPath(newId), bytes);
      });
      charData.portrait_image = `${newId}.png`;
    }

    // Write new JSON (atomic)
    await mkdir(path.dirname(newJsonPath), { recursive: true });
    await withFileLock(newJsonPath, async () => {
      await atomicWrite(newJsonPath, JSON.stringify(charData, null, 2) + '\n');
    });

    // Rename skin PNG <profileRoot>/skins/<slug>.png → <uuid>.png if present
    const oldSkinPath = paths.skinPngPath(oldId);
    const newSkinPath = paths.skinPngPath(newId);
    if (await fileExists(oldSkinPath)) {
      await mkdir(path.dirname(newSkinPath), { recursive: true });
      await rename(oldSkinPath, newSkinPath);
    }

    // Rename memory dir <profileRoot>/memory/<slug>/ → <uuid>/ (LIB-02:
    // directory key follows the rename; contents stay local-only forever).
    const oldMemoryDir = paths.memoryDir(oldId);
    const newMemoryDir = paths.memoryDir(newId);
    if (await fileExists(oldMemoryDir)) {
      await rename(oldMemoryDir, newMemoryDir);
    }

    // Delete the old slug JSON (now superseded). ENOENT is swallowed so a
    // partial prior run that already deleted it is harmless.
    try { await unlink(oldJsonPath); } catch { /* swallow ENOENT */ }

    manifest.push({ oldSlug: oldId, newId });
    log.info(`renamed ${oldId} → ${newId}`);
  }

  // Update index.json order to UUIDs
  const newOrder = manifest.map(e => e.newId);
  await withFileLock(indexPath, async () => {
    await atomicWrite(indexPath, JSON.stringify({ version: indexData.version, order: newOrder }, null, 2) + '\n');
  });

  // Update defaults-seeded.json ids array if the tracker file exists
  const defaultsSeededPath = paths.defaultsSeededPath();
  if (await fileExists(defaultsSeededPath)) {
    try {
      const seeded = JSON.parse(await readFile(defaultsSeededPath, 'utf8')) as { version?: number; ids?: unknown };
      const ids = Array.isArray(seeded.ids) ? (seeded.ids.filter(x => typeof x === 'string') as string[]) : [];
      // Remap slug ids → UUIDs. For sui/lyra/clawd not present in the
      // current manifest (e.g., already seeded before the user created any
      // character), fall back to the frozen DEFAULT_CHARACTER_UUIDS map.
      const remapped = ids.map(id => {
        const m = manifest.find(e => e.oldSlug === id);
        if (m) return m.newId;
        if (id === 'sui' || id === 'lyra') return DEFAULT_CHARACTER_UUIDS[id];
        if (id === 'clawd') return DEFAULT_CHARACTER_UUIDS.marv; // historical slug → Marv
        return id;
      });
      await withFileLock(defaultsSeededPath, async () => {
        await atomicWrite(
          defaultsSeededPath,
          JSON.stringify({ version: seeded.version ?? 1, ids: remapped }, null, 2) + '\n',
        );
      });
    } catch (err) {
      log.warn(`defaults-seeded rewrite failed: ${(err as Error).message}`);
    }
  }

  // LAST: write the idempotency manifest
  await writeMigrationManifest({ migratedAt: new Date().toISOString(), entries: manifest });
  log.info(`completed: ${manifest.length} entries`);

  // Backfill Home defaults AFTER the rename so is_default ids are UUIDs (a
  // user jumping straight from the slug era to procgen in one update).
  await runAddedDefaultsBackfill();
}
