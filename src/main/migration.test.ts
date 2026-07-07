/**
 * Tests for Phase 11 D-23 slug→UUID rename migration.
 * Source: 11-05-PLAN Task 1 behavior contract.
 *
 * Test surface:
 *   1. Idempotency — manifest existence short-circuits the migration
 *   2. Default character slug rename — sui/lyra/marv resolve to frozen UUIDs
 *   3. User-created slug rename — fresh UUID, slug field carries old kebab name
 *   4. Portrait data URL migration — decoded to <profileRoot>/portraits/<uuid>.png
 *   5. Memory dir rename — <profileRoot>/memory/<slug>/ → <profileRoot>/memory/<uuid>/
 *   6. Index + defaults-seeded.json rewriting to UUIDs
 *   7. No-character fresh-install case writes manifest with empty entries
 *   8. Grep gate — body of migration.ts contains zero supabase calls
 *
 * Test harness pattern matches sessionStore.test.ts:
 *   - vi.mock('electron') so electron's app/safeStorage isn't required
 *   - _setUserDataOverride to point paths.* at an os.tmpdir() scratch dir
 *
 * 260603 partition note: per-account stores now live under
 * <userData>/profiles/<scope>/… . These tests run at the default 'local'
 * scope and address every per-account fixture/assertion through the `paths`
 * helpers so they follow the profile root rather than the device root. The
 * slug→UUID migrate marker (paths.migrationManifestPath) stays device-global.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (_k: string) => tmpdir(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('ENC:' + s, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('decrypt failed');
      return s.slice(4);
    },
    getSelectedStorageBackend: () => 'gnome_libsecret',
  },
}));

import { paths, _setUserDataOverride, setActiveScope } from './paths';
import { runUuidRenameMigration, runDefaultsToWorldMigration } from './migration';
import { DEFAULT_CHARACTER_UUIDS, DEFAULT_CHARACTERS_OWNER } from './defaultCharacters';
import { loadConfig, saveConfig } from './configStore';
import { listCharacters } from './characterStore';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tmp: string;

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** Minimal valid v0.1.1-shape character JSON (slug-keyed `id`). */
function legacyChar(opts: { id: string; name?: string; portrait_image?: string | null }): Record<string, unknown> {
  return {
    id: opts.id,
    name: opts.name ?? opts.id,
    persona: { source: 'A test persona.', expanded: '' },
    is_default: false,
    created: '2026-05-21T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: opts.portrait_image ?? null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
  };
}

/** Write a slug-keyed character + an index.json listing the given order. */
async function seedIndex(order: string[]): Promise<void> {
  await writeFile(
    paths.indexPath(),
    JSON.stringify({ version: 1, order }, null, 2),
    'utf8',
  );
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-migration-test-'));
  _setUserDataOverride(tmp);
  setActiveScope('local');
  await mkdir(paths.charactersDir(), { recursive: true });
});

afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) {
    try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

describe('runUuidRenameMigration', () => {
  it('is idempotent: returns immediately when manifest exists', async () => {
    // Pre-populate manifest
    await writeFile(paths.migrationManifestPath(), JSON.stringify({ migratedAt: '2026-01-01T00:00:00Z', entries: [] }), 'utf8');
    // Also write a slug-keyed character that would normally be migrated
    await writeFile(paths.characterPath('sui'), JSON.stringify(legacyChar({ id: 'sui' }), null, 2), 'utf8');
    await seedIndex(['sui']);

    await runUuidRenameMigration();

    // sui.json should still be slug-keyed — migration was a no-op
    expect(await fileExists(paths.characterPath('sui'))).toBe(true);
    expect(await fileExists(paths.characterPath(DEFAULT_CHARACTER_UUIDS.sui))).toBe(false);
  });

  it('writes a manifest with empty entries when no characters/index.json exists', async () => {
    // Fresh install — characters/ dir is empty
    expect(await fileExists(paths.migrationManifestPath())).toBe(false);
    await runUuidRenameMigration();
    expect(await fileExists(paths.migrationManifestPath())).toBe(true);
    const m = JSON.parse(await readFile(paths.migrationManifestPath(), 'utf8'));
    expect(m.entries).toEqual([]);
  });

  it('renames bundled default sui to its frozen UUID', async () => {
    await writeFile(paths.characterPath('sui'), JSON.stringify(legacyChar({ id: 'sui', name: 'Sui' }), null, 2), 'utf8');
    await seedIndex(['sui']);

    await runUuidRenameMigration();

    const suiUuid = DEFAULT_CHARACTER_UUIDS.sui;
    const newPath = paths.characterPath(suiUuid);
    expect(await fileExists(newPath)).toBe(true);
    expect(await fileExists(paths.characterPath('sui'))).toBe(false);

    const newJson = JSON.parse(await readFile(newPath, 'utf8'));
    expect(newJson.id).toBe(suiUuid);
    expect(newJson.slug).toBe('sui');

    // Index updated
    const idx = JSON.parse(await readFile(paths.indexPath(), 'utf8'));
    expect(idx.order).toEqual([suiUuid]);

    // Manifest written
    const m = JSON.parse(await readFile(paths.migrationManifestPath(), 'utf8'));
    expect(m.entries).toContainEqual({ oldSlug: 'sui', newId: suiUuid });
  });

  it('renames a user-created character to a fresh UUID with slug preserved', async () => {
    await writeFile(paths.characterPath('lemon'), JSON.stringify(legacyChar({ id: 'lemon', name: 'Lemon' }), null, 2), 'utf8');
    await seedIndex(['lemon']);

    await runUuidRenameMigration();

    const idx = JSON.parse(await readFile(paths.indexPath(), 'utf8'));
    expect(idx.order).toHaveLength(1);
    const newId = idx.order[0];
    expect(UUID_V4_RE.test(newId)).toBe(true);
    expect(newId).not.toBe('lemon');

    const newPath = paths.characterPath(newId);
    expect(await fileExists(newPath)).toBe(true);
    expect(await fileExists(paths.characterPath('lemon'))).toBe(false);

    const newJson = JSON.parse(await readFile(newPath, 'utf8'));
    expect(newJson.id).toBe(newId);
    expect(newJson.slug).toBe('lemon');
  });

  it('decodes data-URL portrait_image into <profileRoot>/portraits/<uuid>.png and rewrites field', async () => {
    // 1x1 transparent PNG
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;

    await writeFile(paths.characterPath('sui'), JSON.stringify(legacyChar({ id: 'sui', portrait_image: dataUrl }), null, 2), 'utf8');
    await seedIndex(['sui']);

    await runUuidRenameMigration();

    const suiUuid = DEFAULT_CHARACTER_UUIDS.sui;
    const portraitFile = paths.portraitPath(suiUuid);
    expect(await fileExists(portraitFile)).toBe(true);
    const onDisk = await readFile(portraitFile);
    expect(onDisk.equals(pngBytes)).toBe(true);

    const newJson = JSON.parse(await readFile(paths.characterPath(suiUuid), 'utf8'));
    expect(newJson.portrait_image).toBe(`${suiUuid}.png`);
  });

  it('renames the memory dir from <slug>/ to <uuid>/ preserving contents', async () => {
    const suiUuid = DEFAULT_CHARACTER_UUIDS.sui;
    await mkdir(paths.memoryDir('sui'), { recursive: true });
    await writeFile(path.join(paths.memoryDir('sui'), 'OWNER.md'), '# owner\n', 'utf8');
    await writeFile(path.join(paths.memoryDir('sui'), 'DIARY.md'), '# diary\n', 'utf8');

    await writeFile(paths.characterPath('sui'), JSON.stringify(legacyChar({ id: 'sui' }), null, 2), 'utf8');
    await seedIndex(['sui']);

    await runUuidRenameMigration();

    expect(await fileExists(paths.memoryDir('sui'))).toBe(false);
    expect(await fileExists(paths.memoryDir(suiUuid))).toBe(true);
    const owner = await readFile(path.join(paths.memoryDir(suiUuid), 'OWNER.md'), 'utf8');
    expect(owner).toBe('# owner\n');
  });

  it('renames the skin PNG from <slug>.png to <uuid>.png if present', async () => {
    const suiUuid = DEFAULT_CHARACTER_UUIDS.sui;
    await mkdir(paths.skinsDir(), { recursive: true });
    const skinBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic stub
    await writeFile(paths.skinPngPath('sui'), skinBytes);

    await writeFile(paths.characterPath('sui'), JSON.stringify(legacyChar({ id: 'sui' }), null, 2), 'utf8');
    await seedIndex(['sui']);

    await runUuidRenameMigration();

    expect(await fileExists(paths.skinPngPath('sui'))).toBe(false);
    expect(await fileExists(paths.skinPngPath(suiUuid))).toBe(true);
    const moved = await readFile(paths.skinPngPath(suiUuid));
    expect(moved.equals(skinBytes)).toBe(true);
  });

  it('remaps defaults-seeded.json ids from slugs to UUIDs', async () => {
    await writeFile(paths.characterPath('sui'), JSON.stringify(legacyChar({ id: 'sui' }), null, 2), 'utf8');
    await seedIndex(['sui']);
    await writeFile(paths.defaultsSeededPath(), JSON.stringify({ ids: ['sui', 'lyra'] }, null, 2), 'utf8');

    await runUuidRenameMigration();

    const seeded = JSON.parse(await readFile(paths.defaultsSeededPath(), 'utf8'));
    expect(seeded.ids).toContain(DEFAULT_CHARACTER_UUIDS.sui);
    expect(seeded.ids).toContain(DEFAULT_CHARACTER_UUIDS.lyra);
    expect(seeded.ids).not.toContain('sui');
  });

  it('grep gate: migration.ts source contains zero supabase/getClient references', () => {
    // Read the source on disk so we statically verify no cloud calls leaked in
    // (defense-in-depth; the unit tests above never touch a Supabase client).
    const src = readFileSync(path.join(__dirname, 'migration.ts'), 'utf8');
    // Strip comments to avoid matching the threat-model docblock.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
    expect(/supabase\.from/.test(codeOnly)).toBe(false);
    expect(/getClient\s*\(/.test(codeOnly)).toBe(false);
    expect(/supabase\.storage/.test(codeOnly)).toBe(false);
  });
});

describe('defaultsSeededPath remap after partition', () => {
  it('also writes the index update to the active profile root', async () => {
    setActiveScope('local');
    await writeFile(paths.characterPath('sui'), JSON.stringify(legacyChar({ id: 'sui' }), null, 2), 'utf8');
    await seedIndex(['sui']);

    await runUuidRenameMigration();

    // index.json must be the profile-scoped one, not a device-root one.
    const idx = JSON.parse(await readFile(paths.indexPath(), 'utf8'));
    expect(idx.order).toEqual([DEFAULT_CHARACTER_UUIDS.sui]);
    expect(paths.indexPath()).toContain(path.join('profiles', 'local'));
  });
});

describe('runDefaultsToWorldMigration', () => {
  // A UUID-keyed local copy of a bundled default, in the OLD read-only model.
  function defaultChar(id: string, name: string, slug: string): Record<string, unknown> {
    return {
      id,
      slug,
      name,
      persona: { source: `${name} persona.`, expanded: '' },
      is_default: true,
      shared: false,
      owner: null,
      kind: 'world',
      created: '2026-05-21T00:00:00.000Z',
      last_launched: null,
      playtime_ms: 0,
      cloud_updated_at: '2026-05-21T00:00:00.000Z',
      portrait_image: `./img/${slug}.png`,
      skin: { source: 'bundled', mojang_username: null, png_sha256: null, applied_at: null },
      username: name,
    };
  }

  async function seedChar(row: Record<string, unknown>): Promise<void> {
    await writeFile(paths.characterPath(row.id as string), JSON.stringify(row, null, 2), 'utf8');
  }

  it('self-heals a partially-converted default (is_default:false but kind:world → custom) even with the marker set', async () => {
    // The Lyra case: an older build converted is_default/owner but not kind, and
    // the user never opened her (so refreshFromCloud never adopted kind). The
    // marker is already set, but the heal must still fix the kind.
    await seedChar({
      ...defaultChar(DEFAULT_CHARACTER_UUIDS.lyra, 'Lyra', 'lyra'),
      is_default: false,
      owner: DEFAULT_CHARACTERS_OWNER,
      kind: 'world',
      shared: true,
    });
    await seedIndex([DEFAULT_CHARACTER_UUIDS.lyra]);
    await saveConfig({ ...(await loadConfig()), defaults_to_world_migrated: true });

    await runDefaultsToWorldMigration();

    const lyra = (await listCharacters()).find((c) => c.id === DEFAULT_CHARACTER_UUIDS.lyra)!;
    expect(lyra.kind).toBe('custom');
    expect(lyra.shared).toBe(true); // preserved (not force-flipped) on a repair
  });

  it('is state-idempotent: a default already in final shape is not re-forced public', async () => {
    // A user who later made their adopted default PRIVATE must not have it
    // flipped back to public every boot.
    await seedChar({
      ...defaultChar(DEFAULT_CHARACTER_UUIDS.sui, 'Sui', 'sui'),
      is_default: false,
      owner: DEFAULT_CHARACTERS_OWNER,
      kind: 'custom',
      shared: false,
      cloud_updated_at: '2026-06-01T00:00:00.000Z',
    });
    await seedIndex([DEFAULT_CHARACTER_UUIDS.sui]);

    await runDefaultsToWorldMigration();

    const sui = (await listCharacters()).find((c) => c.id === DEFAULT_CHARACTER_UUIDS.sui)!;
    expect(sui.shared).toBe(false); // NOT re-forced to public
    expect(sui.cloud_updated_at).toBe('2026-06-01T00:00:00.000Z'); // watermark not busted
  });

  it('fresh install (no local defaults) just flips the marker', async () => {
    expect((await loadConfig()).defaults_to_world_migrated).toBe(false);
    await runDefaultsToWorldMigration();
    expect((await loadConfig()).defaults_to_world_migrated).toBe(true);
  });

  it('converts a local is_default default into an owned/shared World character', async () => {
    await seedChar(defaultChar(DEFAULT_CHARACTER_UUIDS.sui, 'Sui', 'sui'));
    await seedIndex([DEFAULT_CHARACTER_UUIDS.sui]);

    await runDefaultsToWorldMigration();

    const sui = (await listCharacters()).find((c) => c.id === DEFAULT_CHARACTER_UUIDS.sui)!;
    expect(sui.is_default).toBe(false);
    expect(sui.owner).toBe(DEFAULT_CHARACTERS_OWNER);
    expect(sui.shared).toBe(true);
    expect(sui.kind).toBe('custom'); // reclassified so viewOnly (kind-gated) unlocks for the owner
    expect(sui.cloud_updated_at ?? null).toBeNull(); // watermark busted → forces cloud re-pull
    expect((await loadConfig()).defaults_to_world_migrated).toBe(true);
  });

  it('moves an INVITED default from added_default_ids → added_world_ids', async () => {
    const suiId = DEFAULT_CHARACTER_UUIDS.sui;
    await seedChar(defaultChar(suiId, 'Sui', 'sui'));
    await seedIndex([suiId]);
    await saveConfig({ ...(await loadConfig()), added_default_ids: [suiId], added_world_ids: [] });

    await runDefaultsToWorldMigration();

    const cfg = await loadConfig();
    expect(cfg.added_default_ids).not.toContain(suiId);
    expect(cfg.added_world_ids).toContain(suiId);
  });

  it('leaves a non-default user character alone', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    await seedChar({ ...defaultChar(userId, 'Custom', 'custom'), is_default: false, owner: userId });
    await seedIndex([userId]);

    await runDefaultsToWorldMigration();

    const custom = (await listCharacters()).find((c) => c.id === userId)!;
    expect(custom.owner).toBe(userId); // not restamped to DEFAULT_CHARACTERS_OWNER
    expect(custom.shared).toBe(false);
  });
});
