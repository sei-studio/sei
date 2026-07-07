/**
 * skinStore.test.ts — skin serving contract after the 260707 bundle removal.
 *
 * There are NO bundled skins anymore. The only bytes served are the per-user
 * cached override at <userData>/skins/<id>.png (pointed at by an
 * 'upload'/'username' descriptor). The three former defaults (sui/lyra/marv)
 * are ordinary public characters — they get NO offline baseline and behave
 * exactly like any other public character whose cloud skin has not downloaded
 * yet (server 404 → Steve).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Character } from '../shared/characterSchema';
import { DEFAULT_CHARACTER_UUIDS } from './defaultCharacters';

// Mutable userData root so the paths mock resolves at each test's temp dir.
const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./paths', () => ({
  paths: {
    userData: () => h.userData,
    skinsDir: () => path.join(h.userData, 'skins'),
    skinPngPath: (id: string) => path.join(h.userData, 'skins', `${id}.png`),
  },
}));
vi.mock('./characterStore', () => ({ getCharacter: vi.fn(), saveCharacter: vi.fn() }));

import { resolveSkinPng, readSkinPng } from './skinStore';

const SKIN_BYTES = Buffer.from('cached-skin-bytes');

function mkChar(overrides: Partial<Character> = {}): Character {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    kind: 'custom',
    public_id: null,
    name: 'Nova',
    persona: { source: 'A test persona.', expanded: '' },
    is_default: false,
    shared: true,
    slug: null,
    metadata: {},
    created: '2026-01-01T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    username: null,
    owner: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    ...overrides,
  } as Character;
}

async function cacheSkin(id: string): Promise<void> {
  await mkdir(path.join(h.userData, 'skins'), { recursive: true });
  await writeFile(path.join(h.userData, 'skins', `${id}.png`), SKIN_BYTES);
}

beforeEach(async () => {
  h.userData = await mkdtemp(path.join(tmpdir(), 'sei-skin-test-'));
});
afterEach(async () => {
  if (h.userData) await rm(h.userData, { recursive: true, force: true }).catch(() => {});
});

describe('resolveSkinPng — cloud-cached override only, no bundle', () => {
  it('serves the cached override bytes when source is upload and the file exists', async () => {
    const c = mkChar({ skin: { source: 'upload', mojang_username: null, png_sha256: 'x', applied_at: null } });
    await cacheSkin(c.id);
    const bytes = await resolveSkinPng(c);
    expect(bytes).not.toBeNull();
    expect(bytes!.equals(SKIN_BYTES)).toBe(true);
  });

  it('returns null when source is upload but no bytes cached (Steve until download)', async () => {
    const c = mkChar({ skin: { source: 'upload', mojang_username: null, png_sha256: 'x', applied_at: null } });
    expect(await resolveSkinPng(c)).toBeNull();
  });

  it('returns null for source none', async () => {
    expect(await resolveSkinPng(mkChar())).toBeNull();
  });

  it('gives a FORMER DEFAULT no bundled fallback — behaves like any public char', async () => {
    // Sui's frozen UUID, source none (or a cloud override whose bytes have not
    // downloaded): pre-260707 this served a bundled PNG; now it must be null.
    const sui = mkChar({ id: DEFAULT_CHARACTER_UUIDS.sui, name: 'Sui', slug: 'sui', is_default: true });
    expect(await resolveSkinPng(sui)).toBeNull();
  });
});

describe('readSkinPng — local match only, no bundled-default fallback', () => {
  it('matches by username (case-insensitive) and serves the cached skin', async () => {
    const c = mkChar({
      username: 'Nova',
      skin: { source: 'upload', mojang_username: null, png_sha256: 'x', applied_at: null },
    });
    await cacheSkin(c.id);
    const bytes = await readSkinPng({ username: 'nova', listCharacters: async () => [c] });
    expect(bytes).not.toBeNull();
    expect(bytes!.equals(SKIN_BYTES)).toBe(true);
  });

  it('matches by sanitized name when username is unset', async () => {
    const c = mkChar({
      name: 'Nova',
      username: null,
      skin: { source: 'upload', mojang_username: null, png_sha256: 'x', applied_at: null },
    });
    await cacheSkin(c.id);
    const bytes = await readSkinPng({ username: 'Nova', listCharacters: async () => [c] });
    expect(bytes).not.toBeNull();
  });

  it('returns null for a former default alias with an empty local store', async () => {
    // 'Sui'/'sui' used to hit the bundled-default fallback; now there is none.
    expect(await readSkinPng({ username: 'Sui', listCharacters: async () => [] })).toBeNull();
    expect(await readSkinPng({ username: 'sui', listCharacters: async () => [] })).toBeNull();
  });

  it('returns null when the matched character has no cached skin', async () => {
    const c = mkChar({ username: 'Nova' }); // source none, nothing cached
    expect(await readSkinPng({ username: 'Nova', listCharacters: async () => [c] })).toBeNull();
  });
});
