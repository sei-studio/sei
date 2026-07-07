/**
 * skinStore.test.ts — regression tests covering:
 *   - ITEM 9 (quick/260523-t8d): UUID→slug reverse-lookup in bundledSkinPath()
 *     so the bundled default PNGs (sui/lyra/marv) actually resolve. Pre-fix,
 *     bundledSkinPath interpolated the UUID directly, yielding a path that
 *     didn't exist; this test would have caught the Phase 11 latent bug at
 *     landing time.
 *   - ui-A8 (world-tab default skin loading): readSkinPng case-insensitive
 *     matching + bundled-default fallback for fresh-machine scenarios where
 *     the seedDefaultCharacters race has not yet populated local store but
 *     a renderer surface (SkinPreview3d on the world/Browse tab) is already
 *     requesting `${baseUrl}/skins/<Name>.png`.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Character } from '../shared/characterSchema';

// app.isPackaged must be falsy in tests so bundledSkinPath() takes the dev
// branch and resolves relative to <repo>/resources/skins.
vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

// paths is required by skinStore but unused in these read-only tests; stub
// out userData() so the module imports cleanly without a real Electron app.
vi.mock('./paths', () => ({
  paths: {
    userData: () => '/tmp/sei-test-userdata',
    skinsDir: () => '/tmp/sei-test-userdata/skins',
    skinPngPath: (id: string) => `/tmp/sei-test-userdata/skins/${id}.png`,
  },
}));

// characterStore is imported by skinStore but unused in these tests.
vi.mock('./characterStore', () => ({
  getCharacter: vi.fn(),
  saveCharacter: vi.fn(),
}));

import { bundledSkinPath, resolveSkinPng, readSkinPng } from './skinStore';
import { DEFAULT_CHARACTERS, DEFAULT_CHARACTER_UUIDS } from './defaultCharacters';

describe('ITEM 9: bundledSkinPath resolves slug-named PNGs by UUID', () => {
  it('returns null for non-default characters', () => {
    expect(
      bundledSkinPath({ id: '00000000-0000-0000-0000-000000000000', slug: null }),
    ).toBeNull();
  });

  it('resolves each default to its slug-named file (dev path)', () => {
    const sui = DEFAULT_CHARACTERS.find((c) => c.id === DEFAULT_CHARACTER_UUIDS.sui);
    const lyra = DEFAULT_CHARACTERS.find((c) => c.id === DEFAULT_CHARACTER_UUIDS.lyra);
    const marv = DEFAULT_CHARACTERS.find((c) => c.id === DEFAULT_CHARACTER_UUIDS.marv);
    expect(sui).toBeDefined();
    expect(lyra).toBeDefined();
    expect(marv).toBeDefined();
    const suiPath = bundledSkinPath(sui!);
    const lyraPath = bundledSkinPath(lyra!);
    const marvPath = bundledSkinPath(marv!);
    expect(suiPath?.endsWith(path.join('resources', 'skins', 'sui.png'))).toBe(true);
    expect(lyraPath?.endsWith(path.join('resources', 'skins', 'lyra.png'))).toBe(true);
    expect(marvPath?.endsWith(path.join('resources', 'skins', 'marv.png'))).toBe(true);
  });

  it('falls back to UUID→slug reverse lookup when slug is null (legacy on-disk row)', () => {
    // Simulate a default row that lost its slug field (e.g. from an older
    // build that didn't include slug). The UUID alone must be enough to
    // recover the slug via DEFAULT_CHARACTER_UUIDS.
    const p = bundledSkinPath({ id: DEFAULT_CHARACTER_UUIDS.sui, slug: null });
    expect(p?.endsWith(path.join('resources', 'skins', 'sui.png'))).toBe(true);
  });

  it('resolveSkinPng reads the actual bundled PNG bytes for Sui (byte-equal to resources/skins/sui.png)', async () => {
    const sui = DEFAULT_CHARACTERS.find((c) => c.id === DEFAULT_CHARACTER_UUIDS.sui)!;
    const resolved = await resolveSkinPng({ ...sui, skin: { ...sui.skin, source: 'bundled' } });
    expect(resolved).not.toBeNull();
    const onDisk = await readFile(bundledSkinPath(sui)!);
    expect(resolved!.equals(onDisk)).toBe(true);
    // Sanity: not the 1x1 placeholder symptom (which would be < 100 bytes).
    expect(resolved!.length).toBeGreaterThan(100);
  });
});

/**
 * ui-A8 — world-tab default-skin loading (case-insensitive + bundled fallback).
 *
 * The world (Browse) tab can surface default personas (sui/lyra/marv) before
 * seedDefaultCharacters has populated <userData>/characters/. When the user
 * clicks one of those Browse entries the renderer mounts SkinPreview3d which
 * pings `${skinServerBaseUrl}/skins/<Name>.png`. Pre-fix, readSkinPng matched
 * `c.username === args.username` exactly (case-sensitive) and gave up on the
 * empty local list — so the preview fell back to the Steve silhouette even
 * though the bundled PNG is sitting right there at resources/skins/<slug>.png.
 *
 * These tests lock in both halves of the fix:
 *   (a) case-insensitive username + sanitized-name match when the default IS
 *       seeded locally;
 *   (b) bundled-default fallback (slug | username | sanitized-name) when the
 *       local list is empty.
 */
describe('ui-A8: readSkinPng default-skin lookups for world tab', () => {
  const suiDefault = DEFAULT_CHARACTERS.find((c) => c.id === DEFAULT_CHARACTER_UUIDS.sui)!;
  const lyraDefault = DEFAULT_CHARACTERS.find((c) => c.id === DEFAULT_CHARACTER_UUIDS.lyra)!;
  const marvDefault = DEFAULT_CHARACTERS.find((c) => c.id === DEFAULT_CHARACTER_UUIDS.marv)!;

  it('matches the seeded default by exact username (Sui)', async () => {
    // Local store has Sui with username='Sui' (the post-seed steady state).
    const localOnly = [suiDefault];
    const bytes = await readSkinPng({
      username: 'Sui',
      listCharacters: async () => localOnly,
    });
    expect(bytes).not.toBeNull();
    const onDisk = await readFile(bundledSkinPath(suiDefault)!);
    expect(bytes!.equals(onDisk)).toBe(true);
  });

  it('matches the seeded default case-insensitively (sui vs Sui)', async () => {
    // Some upstream consumers (CSL builds that lowercase the substituted
    // username, future programmatic preview links) request the slug form.
    // The match must be case-fold; pre-fix this returned null → 404.
    const bytes = await readSkinPng({
      username: 'sui',
      listCharacters: async () => [suiDefault],
    });
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBeGreaterThan(100);
  });

  it('falls back to bundled PNG when default is not yet seeded locally (Sui)', async () => {
    // Fresh-machine scenario: world tab open BEFORE seedDefaultCharacters
    // populates the local store. Pre-fix, listCharacters() returned [], no
    // match found, server 404'd, SkinPreview3d fell back to Steve. Post-fix,
    // we recognise 'Sui' as a default slug/username/name and serve the
    // bundled bytes directly.
    const bytes = await readSkinPng({
      username: 'Sui',
      listCharacters: async () => [],
    });
    expect(bytes).not.toBeNull();
    const onDisk = await readFile(bundledSkinPath(suiDefault)!);
    expect(bytes!.equals(onDisk)).toBe(true);
  });

  it('bundled-default fallback matches by lowercase slug for all three defaults', async () => {
    for (const def of [suiDefault, lyraDefault, marvDefault]) {
      const bytes = await readSkinPng({
        username: def.slug!,                // 'sui', 'lyra', 'marv' (lowercase slugs)
        listCharacters: async () => [],
      });
      expect(bytes, `default ${def.slug} should match by lowercase slug`).not.toBeNull();
      const onDisk = await readFile(bundledSkinPath(def)!);
      expect(bytes!.equals(onDisk)).toBe(true);
    }
  });

  it('bundled-default fallback matches by capitalized name for all three defaults', async () => {
    // 'Sui' / 'Lyra' / 'Marv' — the persona-username form the renderer
    // builds via `character.username` (which is set to the capitalized name
    // in the bundled JSON).
    for (const def of [suiDefault, lyraDefault, marvDefault]) {
      const bytes = await readSkinPng({
        username: def.username!,
        listCharacters: async () => [],
      });
      expect(bytes, `default ${def.username} should match by username`).not.toBeNull();
      expect(bytes!.length).toBeGreaterThan(100);
    }
  });

  it('returns null for an unknown username with empty local store', async () => {
    // Belt-and-suspenders: the bundled fallback must NOT promiscuously serve
    // a default for arbitrary unknown requests; only default-aliased ones.
    const bytes = await readSkinPng({
      username: 'StevePlayer123',
      listCharacters: async () => [],
    });
    expect(bytes).toBeNull();
  });

  it('local custom character wins over bundled-default fallback (no shadow)', async () => {
    // If the user created a custom character named 'Sui' (their own persona,
    // not the bundled default), the local match short-circuits BEFORE the
    // bundled fallback runs. resolveSkinPng on a non-bundled character with
    // skin.source='none' returns null — that's the correct behavior (user
    // hasn't picked a skin yet) and the renderer's transparent placeholder
    // shows Steve, which matches their intent.
    const customSui: Character = {
      ...suiDefault,
      id: '11111111-1111-1111-1111-111111111111', // not a default UUID
      is_default: false,
      slug: null,
      skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    };
    const bytes = await readSkinPng({
      username: 'Sui',
      listCharacters: async () => [customSui],
    });
    expect(bytes).toBeNull();
  });
});
