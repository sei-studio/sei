/**
 * Tests for src/main/cloud/cacheOnDemand.ts — Phase 11 plan 11-19
 *
 * Covers the cache-on-demand sync model (D-19, LIB-04):
 *   1. ensureLocallyCached(uuid) on an existing local JSON: no-op
 *   2. Cache miss + cloud row present → writes character JSON + skin + portrait
 *   3. Cache miss + cloud returns null → throws CLOUD_CHARACTER_NOT_FOUND
 *   4. Conflict path: local exists + sync queue has pending → writes shadow file
 *   5. Not signed in + public row → still downloads + caches (item 5)
 *   6. listMerged dedupes by id with correct source annotation
 *
 * Mock strategy: vi.mock the cloudCharacterClient, supabaseClient (auth),
 * characterStore (saveCharacterRaw + listCharacters), and syncQueue (getStatus).
 * cacheOnDemand uses dynamic imports throughout so vi.mock intercepts them.
 *
 * Real filesystem under os.tmpdir() via _setUserDataOverride — mirrors the
 * syncQueue.test.ts and portraitStore.test.ts pattern.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// electron is imported by paths.ts; stub before importing anything that touches paths.
vi.mock('electron', () => ({
  app: { getPath: (_: string) => tmpdir() },
}));

// ---- Mocks for dynamic imports inside ensureLocallyCached ------------------

const downloadCharacterMock = vi.fn();
const downloadSkinMock = vi.fn();
const downloadPortraitMock = vi.fn();
const listMyCharactersMock = vi.fn();
vi.mock('./cloudCharacterClient', () => ({
  downloadCharacter: downloadCharacterMock,
  downloadSkin: downloadSkinMock,
  downloadPortrait: downloadPortraitMock,
  listMyCharacters: listMyCharactersMock,
}));

const getSessionMock = vi.fn();
vi.mock('../auth/supabaseClient', () => ({
  getClient: () => ({ auth: { getSession: getSessionMock } }),
}));

const saveCharacterRawMock = vi.fn();
const listCharactersMock = vi.fn();
const getCharacterMock = vi.fn();
vi.mock('../characterStore', () => ({
  saveCharacterRaw: saveCharacterRawMock,
  listCharacters: listCharactersMock,
  getCharacter: getCharacterMock,
}));

const getStatusMock = vi.fn();
vi.mock('./syncQueue', () => ({
  getStatus: getStatusMock,
}));

// ---- After mocks, import paths + helpers + SUT -----------------------------

import { paths, _setUserDataOverride } from '../paths';

// ---- Test fixture lifecycle ------------------------------------------------

const OWNER = '00000000-0000-0000-0000-000000000001';
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function makeCharacter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID_A,
    name: 'Cloud Char',
    persona: { source: 'a friend', expanded: 'a friend who helps' },
    is_default: false,
    shared: true,
    slug: null,
    metadata: {},
    created: '2026-01-01T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
    ...overrides,
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-cod-'));
  _setUserDataOverride(tmp);
  downloadCharacterMock.mockReset();
  downloadSkinMock.mockReset();
  downloadPortraitMock.mockReset();
  listMyCharactersMock.mockReset();
  getSessionMock.mockReset();
  saveCharacterRawMock.mockReset();
  listCharactersMock.mockReset();
  getCharacterMock.mockReset();
  getStatusMock.mockReset();
  // Sensible defaults
  saveCharacterRawMock.mockResolvedValue(undefined);
  getCharacterMock.mockResolvedValue(null);
  getStatusMock.mockResolvedValue({ pending: 0, failed: [], pendingByUuid: {} });
  getSessionMock.mockResolvedValue({ data: { session: { user: { id: OWNER } } } });
});

afterEach(async () => {
  _setUserDataOverride(null);
  await rm(tmp, { recursive: true, force: true });
});

// Write a local <uuid>.json so existsSync returns true.
async function makeLocal(uuid: string): Promise<void> {
  await mkdir(paths.charactersDir(), { recursive: true });
  await writeFile(paths.characterPath(uuid), JSON.stringify({ id: uuid, name: 'Local' }, null, 2) + '\n');
}

describe('ensureLocallyCached', () => {
  it('no-op when local JSON already exists and no pending sync op', async () => {
    await makeLocal(UUID_A);
    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await ensureLocallyCached(UUID_A);
    // Should not have hit cloud at all
    expect(downloadCharacterMock).not.toHaveBeenCalled();
    expect(saveCharacterRawMock).not.toHaveBeenCalled();
  });

  it('cache miss + cloud row present writes character + skin + portrait', async () => {
    const cloudChar = makeCharacter();
    downloadCharacterMock.mockResolvedValue(cloudChar);
    downloadSkinMock.mockResolvedValue(Buffer.from([1, 2, 3, 4]));
    downloadPortraitMock.mockResolvedValue(Buffer.from([9, 9, 9]));

    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await ensureLocallyCached(UUID_A);

    expect(downloadCharacterMock).toHaveBeenCalledWith(UUID_A);
    expect(saveCharacterRawMock).toHaveBeenCalledTimes(1);
    expect(saveCharacterRawMock).toHaveBeenCalledWith(cloudChar);
    expect(downloadSkinMock).toHaveBeenCalledWith(OWNER, UUID_A);
    expect(downloadPortraitMock).toHaveBeenCalledWith(OWNER, UUID_A);
    // Skin + portrait bytes landed on disk
    const skinBytes = await readFile(paths.skinPngPath(UUID_A));
    expect(skinBytes.length).toBe(4);
    const portraitBytes = await readFile(paths.portraitPath(UUID_A));
    expect(portraitBytes.length).toBe(3);
  });

  it('throws CLOUD_CHARACTER_NOT_FOUND when cloud returns null', async () => {
    downloadCharacterMock.mockResolvedValue(null);
    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await expect(ensureLocallyCached(UUID_A)).rejects.toThrow(/CLOUD_CHARACTER_NOT_FOUND/);
    expect(saveCharacterRawMock).not.toHaveBeenCalled();
  });

  it('signed-out users CAN download + cache a public character (item 5)', async () => {
    // Public (shared) rows are anon-readable (RLS shared = true OR owner = uid),
    // so a local/signed-out user opening a World character must still cache it
    // to view it — no early "not signed in" throw.
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const cloudChar = makeCharacter({ owner: OWNER, shared: true });
    downloadCharacterMock.mockResolvedValue(cloudChar);
    downloadSkinMock.mockResolvedValue(null);
    downloadPortraitMock.mockResolvedValue(null);
    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await expect(ensureLocallyCached(UUID_A)).resolves.toBeUndefined();
    expect(downloadCharacterMock).toHaveBeenCalledWith(UUID_A);
    expect(saveCharacterRawMock).toHaveBeenCalledWith(cloudChar);
    // Asset path uses the ORIGINAL creator's owner id, not a (missing) session.
    expect(downloadSkinMock).toHaveBeenCalledWith(OWNER, UUID_A);
  });

  it('conflict path: local exists + sync queue pending → writes <uuid>.json.conflict and does NOT overwrite local', async () => {
    await makeLocal(UUID_A);
    const cloudChar = makeCharacter({ name: 'CloudEdit' });
    downloadCharacterMock.mockResolvedValue(cloudChar);
    getStatusMock.mockResolvedValue({
      pending: 1,
      failed: [],
      pendingByUuid: { [UUID_A]: 'syncing' },
    });

    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await ensureLocallyCached(UUID_A);

    // Should NOT have called saveCharacterRaw (no overwrite)
    expect(saveCharacterRawMock).not.toHaveBeenCalled();
    // Should have written a .conflict shadow file
    const conflictPath = `${paths.characterPath(UUID_A)}.conflict`;
    await access(conflictPath); // throws if missing
    const shadowText = await readFile(conflictPath, 'utf8');
    expect(shadowText).toContain('CloudEdit');
    // Local file is untouched
    const localText = await readFile(paths.characterPath(UUID_A), 'utf8');
    expect(localText).toContain('Local');
    expect(localText).not.toContain('CloudEdit');
  });

  it('HR-02: concurrent calls for the same uuid share a single download', async () => {
    // Two near-simultaneous opens of the same cloud-only char (HomeScreen
    // double-click, Strict-Mode double-invoke, parallel navigation) used to
    // both pass the existsSync check and double-download. The in-flight map
    // collapses concurrent calls onto one downloadCharacter / saveCharacterRaw
    // / downloadSkin / downloadPortrait round-trip; the second caller awaits
    // the first's promise.
    const cloudChar = makeCharacter();
    // Hold the download until both calls have entered the function.
    let resolveDownload: ((value: Record<string, unknown>) => void) | null = null;
    downloadCharacterMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDownload = resolve;
      }),
    );
    downloadSkinMock.mockResolvedValue(null);
    downloadPortraitMock.mockResolvedValue(null);

    const { ensureLocallyCached } = await import('./cacheOnDemand');
    const p1 = ensureLocallyCached(UUID_A);
    const p2 = ensureLocallyCached(UUID_A);
    // Both calls are now parked on the same in-flight promise. Release.
    resolveDownload!(cloudChar);
    await Promise.all([p1, p2]);

    expect(downloadCharacterMock).toHaveBeenCalledTimes(1);
    expect(saveCharacterRawMock).toHaveBeenCalledTimes(1);
    expect(downloadSkinMock).toHaveBeenCalledTimes(1);
    expect(downloadPortraitMock).toHaveBeenCalledTimes(1);

    // After the in-flight promise resolves, the map entry is cleared so a
    // future re-open re-checks disk. Simulate the post-download cache hit by
    // actually writing the local JSON (saveCharacterRawMock is a stub that
    // doesn't touch the FS), then verify a third call short-circuits via
    // existsSync without hitting cloud again.
    await makeLocal(UUID_A);
    downloadCharacterMock.mockClear();
    saveCharacterRawMock.mockClear();
    await ensureLocallyCached(UUID_A);
    expect(downloadCharacterMock).not.toHaveBeenCalled();
    expect(saveCharacterRawMock).not.toHaveBeenCalled();
  });
});

describe('ensureLocallyCached — refresh-on-open', () => {
  const AUTHOR = '99999999-9999-4999-8999-999999999999';

  // A locally-cached Character (what getCharacter returns), distinct shape from
  // the cloud row makeCharacter() produces.
  function makeLocalChar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: UUID_A,
      name: 'Local Name',
      persona: { source: 'old src', expanded: 'old expanded' },
      is_default: false,
      shared: true,
      slug: null,
      metadata: {},
      created: '2026-01-01T00:00:00.000Z',
      last_launched: '2026-02-02T00:00:00.000Z',
      playtime_ms: 5000,
      portrait_image: null,
      skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
      username: null,
      owner: AUTHOR,
      cloud_updated_at: '2026-03-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('foreign char + newer cloud row re-pulls content, preserving local stats + identity', async () => {
    await makeLocal(UUID_A);
    getCharacterMock.mockResolvedValue(makeLocalChar());
    downloadCharacterMock.mockResolvedValue(
      makeCharacter({
        owner: AUTHOR,
        name: 'Updated Name',
        persona: { source: 'new src', expanded: 'new expanded' },
        description: 'new description',
        last_launched: '2099-01-01T00:00:00.000Z', // author's stat — must NOT be adopted
        playtime_ms: 123456,                        // author's stat — must NOT be adopted
        cloud_updated_at: '2026-04-01T00:00:00.000Z',
      }),
    );

    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await ensureLocallyCached(UUID_A);

    expect(downloadCharacterMock).toHaveBeenCalledWith(UUID_A);
    expect(saveCharacterRawMock).toHaveBeenCalledTimes(1);
    const saved = saveCharacterRawMock.mock.calls[0][0];
    // Content adopted from cloud
    expect(saved.name).toBe('Updated Name');
    expect(saved.persona).toEqual({ source: 'new src', expanded: 'new expanded' });
    expect(saved.description).toBe('new description');
    expect(saved.cloud_updated_at).toBe('2026-04-01T00:00:00.000Z');
    // Local identity + stats preserved
    expect(saved.owner).toBe(AUTHOR);
    expect(saved.is_default).toBe(false);
    expect(saved.created).toBe('2026-01-01T00:00:00.000Z');
    expect(saved.last_launched).toBe('2026-02-02T00:00:00.000Z');
    expect(saved.playtime_ms).toBe(5000);
  });

  it('foreign char + NOT-newer cloud row makes no write', async () => {
    await makeLocal(UUID_A);
    getCharacterMock.mockResolvedValue(makeLocalChar({ cloud_updated_at: '2026-04-01T00:00:00.000Z' }));
    downloadCharacterMock.mockResolvedValue(
      makeCharacter({ owner: AUTHOR, cloud_updated_at: '2026-03-01T00:00:00.000Z' }),
    );

    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await ensureLocallyCached(UUID_A);

    expect(downloadCharacterMock).toHaveBeenCalledWith(UUID_A);
    expect(saveCharacterRawMock).not.toHaveBeenCalled();
  });

  it('char the local user OWNS is never pull-refreshed', async () => {
    await makeLocal(UUID_A);
    // owner === current session user (OWNER) → locally authoritative
    getCharacterMock.mockResolvedValue(makeLocalChar({ owner: OWNER }));

    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await ensureLocallyCached(UUID_A);

    expect(downloadCharacterMock).not.toHaveBeenCalled();
    expect(saveCharacterRawMock).not.toHaveBeenCalled();
  });

  it('null local watermark counts as stale and backfills from cloud', async () => {
    await makeLocal(UUID_A);
    getCharacterMock.mockResolvedValue(makeLocalChar({ cloud_updated_at: null }));
    downloadCharacterMock.mockResolvedValue(
      makeCharacter({ owner: AUTHOR, name: 'Backfilled', cloud_updated_at: '2026-01-01T00:00:00.000Z' }),
    );

    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await ensureLocallyCached(UUID_A);

    expect(saveCharacterRawMock).toHaveBeenCalledTimes(1);
    expect(saveCharacterRawMock.mock.calls[0][0].name).toBe('Backfilled');
  });

  it('default char refreshes prompt but keeps bundled art (cloud portrait null / skin bundled)', async () => {
    await makeLocal(UUID_A);
    getCharacterMock.mockResolvedValue(
      makeLocalChar({
        is_default: true,
        owner: null, // defaults stay locally editable — owner must not be adopted
        portrait_image: './img/sui.png',
        skin: { source: 'bundled', mojang_username: null, png_sha256: null, applied_at: null },
      }),
    );
    downloadCharacterMock.mockResolvedValue(
      makeCharacter({
        owner: AUTHOR, // system owner upstream — must NOT leak onto the editable default
        name: 'Sui v2',
        persona: { source: 'sui v2 src', expanded: 'sui v2 expanded' },
        portrait_image: null,
        skin: { source: 'bundled', mojang_username: null, png_sha256: null, applied_at: null },
        cloud_updated_at: '2026-05-01T00:00:00.000Z',
      }),
    );

    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await ensureLocallyCached(UUID_A);

    expect(saveCharacterRawMock).toHaveBeenCalledTimes(1);
    const saved = saveCharacterRawMock.mock.calls[0][0];
    expect(saved.persona).toEqual({ source: 'sui v2 src', expanded: 'sui v2 expanded' });
    // Identity preserved: still a default, still owner-null (editable), bundled art kept
    expect(saved.is_default).toBe(true);
    expect(saved.owner).toBeNull();
    expect(saved.portrait_image).toBe('./img/sui.png');
    expect(saved.skin.source).toBe('bundled');
  });

  it('default char adopts cloud portrait + skin once the bytes download', async () => {
    await makeLocal(UUID_A);
    getCharacterMock.mockResolvedValue(
      makeLocalChar({
        is_default: true,
        owner: null,
        cloud_updated_at: null,
        portrait_image: './img/sui.png',
        skin: { source: 'bundled', mojang_username: null, png_sha256: null, applied_at: null },
      }),
    );
    downloadCharacterMock.mockResolvedValue(
      makeCharacter({
        owner: AUTHOR,
        portrait_image: `${UUID_A}.png`, // rowToCharacter strips the <owner>/ prefix
        skin: { source: 'upload', mojang_username: null, png_sha256: 'deadbeef', applied_at: '2026-05-01T00:00:00.000Z' },
        cloud_updated_at: '2026-05-01T00:00:00.000Z',
      }),
    );
    downloadPortraitMock.mockResolvedValue(Buffer.from([1, 2, 3]));
    downloadSkinMock.mockResolvedValue(Buffer.from([4, 5, 6, 7]));

    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await ensureLocallyCached(UUID_A);

    // Bytes pulled from the AUTHOR's (system) storage path.
    expect(downloadPortraitMock).toHaveBeenCalledWith(AUTHOR, UUID_A);
    expect(downloadSkinMock).toHaveBeenCalledWith(AUTHOR, UUID_A);
    const saved = saveCharacterRawMock.mock.calls[0][0];
    expect(saved.portrait_image).toBe(`${UUID_A}.png`);
    expect(saved.skin.source).toBe('upload');
    expect(saved.cloud_updated_at).toBe('2026-05-01T00:00:00.000Z');
    // Still a default and still editable (owner not adopted from the system row)
    expect(saved.is_default).toBe(true);
    expect(saved.owner).toBeNull();
    // Bytes landed on disk
    expect((await readFile(paths.portraitPath(UUID_A))).length).toBe(3);
    expect((await readFile(paths.skinPngPath(UUID_A))).length).toBe(4);
  });

  it('keeps bundled art + does NOT advance the watermark when an asset 404s', async () => {
    await makeLocal(UUID_A);
    getCharacterMock.mockResolvedValue(
      makeLocalChar({
        is_default: true,
        owner: null,
        cloud_updated_at: null,
        portrait_image: './img/sui.png',
        skin: { source: 'bundled', mojang_username: null, png_sha256: null, applied_at: null },
      }),
    );
    downloadCharacterMock.mockResolvedValue(
      makeCharacter({
        owner: AUTHOR,
        portrait_image: `${UUID_A}.png`,
        skin: { source: 'bundled', mojang_username: null, png_sha256: null, applied_at: null },
        cloud_updated_at: '2026-05-01T00:00:00.000Z',
      }),
    );
    downloadPortraitMock.mockResolvedValue(null); // not yet uploaded → 404

    const { ensureLocallyCached } = await import('./cacheOnDemand');
    await ensureLocallyCached(UUID_A);

    const saved = saveCharacterRawMock.mock.calls[0][0];
    // Content still adopted, but the portrait reference stays bundled...
    expect(saved.portrait_image).toBe('./img/sui.png');
    // ...and the watermark is NOT advanced, so the next open retries.
    expect(saved.cloud_updated_at).toBeNull();
  });
});

describe('listMerged', () => {
  it('dedupes by id with correct source annotation', async () => {
    const localChar = { id: UUID_A, name: 'LocalOnly', is_default: false };
    const bothChar = { id: UUID_B, name: 'BothLocal', is_default: false };
    listCharactersMock.mockResolvedValue([localChar, bothChar]);
    const cloudOnlyId = '33333333-3333-4333-8333-333333333333';
    listMyCharactersMock.mockResolvedValue([
      { id: UUID_B, name: 'BothCloud' },
      { id: cloudOnlyId, name: 'CloudOnly' },
    ]);

    const { listMerged } = await import('./cacheOnDemand');
    const { characters } = await listMerged();

    expect(characters).toHaveLength(3);
    const byId = new Map(characters.map((c) => [c.id, c]));
    expect(byId.get(UUID_A)?.source).toBe('local');
    expect(byId.get(UUID_B)?.source).toBe('both');
    expect(byId.get(cloudOnlyId)?.source).toBe('cloud');
    // 'both' prefers local name (local is authoritative for already-cached chars)
    expect(byId.get(UUID_B)?.name).toBe('BothLocal');
    expect(byId.get(cloudOnlyId)?.name).toBe('CloudOnly');
  });

  it('returns local only when signed-out', async () => {
    listCharactersMock.mockResolvedValue([{ id: UUID_A, name: 'Local', is_default: false }]);
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const { listMerged } = await import('./cacheOnDemand');
    const { characters } = await listMerged();
    expect(characters).toHaveLength(1);
    expect(characters[0].source).toBe('local');
    expect(listMyCharactersMock).not.toHaveBeenCalled();
  });
});
