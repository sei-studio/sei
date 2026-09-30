/**
 * Phase 11 Plan 11-06 Task 2 — portraitStore.applyPortrait + removePortrait.
 *
 * Verifies:
 *   - applyPortrait writes a file at paths.portraitPath(uuid) + updates
 *     character.portrait_image to '<uuid>.png'
 *   - applyPortrait re-validates bytes (rejects bad magic / oversize)
 *   - removePortrait clears character.portrait_image + unlinks file
 *     (swallows ENOENT)
 *
 * Source: 11-06-PLAN.md Task 2 <behavior>.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

// electron isn't available in the node-test env. Stub safeStorage so the
// apiKeyStore module that characterStore drags in via personaExpansion can
// be imported without exploding. Tests do NOT call expandAndSaveCharacter,
// so the API key path is never actually exercised.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    getSelectedStorageBackend: () => 'basic_text',
  },
  app: {
    getPath: (_n: string) => '/tmp/sei-default',
  },
}));

// saveCharacter fires a best-effort, un-awaited cloud-mirror enqueue that
// writes <profileRoot>/sync-queue.json via tmp+rename. With the tmpdir torn
// down in afterEach, that late rename can surface as an ENOENT unhandled
// rejection. We don't exercise cloud sync here — stub the queue inert.
vi.mock('./cloud/syncQueue', () => ({
  enqueueUpsert: vi.fn(async () => {}),
  enqueueDelete: vi.fn(async () => {}),
  processNext: vi.fn(async () => {}),
}));

import { _setUserDataOverride, paths } from './paths';
import {
  addPortraitVersion,
  applyPortrait,
  getPortraitVersions,
  removePortrait,
  selectPortraitVersion,
} from './portraitStore';
import { deletePortraitFiles, listPortraitVersionFilesOnDisk } from './portraitFiles';
import { deleteCharacter, getCharacter, saveCharacter } from './characterStore';
import type { Character } from '../shared/characterSchema';
import { MAX_PORTRAIT_REGENS, MAX_PORTRAIT_VERSIONS } from '../shared/characterSchema';

let tmp: string;

const UUID_A = '550e8400-e29b-41d4-a716-446655440000';

function makeChar(id: string): Character {
  return {
    id,
    kind: 'custom',
    public_id: null,
    name: 'TestPersona',
    persona: { source: 'test blurb', expanded: '' },
    is_default: false,
    shared: true,
    slug: null,
    metadata: {},
    created: '2026-05-21T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
  };
}

// ── PNG fixture (mirrors portraitImageUtil.test.ts) ────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function buildPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (1 + rowBytes));
  const idat = deflateSync(raw);
  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', idat),
    buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-portrait-'));
  _setUserDataOverride(tmp);
});

afterEach(async () => {
  _setUserDataOverride(null);
  // maxRetries/retryDelay: macOS fs.rm can intermittently throw ENOTEMPTY
  // mid-walk under the parallel suite (recursive enumeration races a still-
  // closing file handle). The built-in retry makes temp-dir teardown robust.
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('applyPortrait', () => {
  it('writes the file and updates character.portrait_image to <uuid>.png', async () => {
    await saveCharacter(makeChar(UUID_A));
    const png = buildPng(64, 64);

    const ref = await applyPortrait({ characterId: UUID_A, bytes: png });

    expect(ref).toBe(`${UUID_A}.png`);
    // File landed at paths.portraitPath(uuid)
    const written = await readFile(paths.portraitPath(UUID_A));
    expect(written.equals(png)).toBe(true);
    // Character JSON now points at the path ref
    const persisted = JSON.parse(
      await readFile(paths.characterPath(UUID_A), 'utf8'),
    );
    expect(persisted.portrait_image).toBe(`${UUID_A}.png`);
  });

  it('rejects invalid bytes (defense-in-depth re-validation)', async () => {
    await saveCharacter(makeChar(UUID_A));
    const garbage = Buffer.alloc(64, 0x42);
    await expect(
      applyPortrait({ characterId: UUID_A, bytes: garbage }),
    ).rejects.toThrow(/PORTRAIT_BAD_MAGIC/);
  });

  it('rejects when character does not exist', async () => {
    const png = buildPng(64, 64);
    await expect(
      applyPortrait({ characterId: UUID_A, bytes: png }),
    ).rejects.toThrow(/Character not found/);
  });
});

describe('removePortrait', () => {
  it('clears portrait_image and unlinks the file', async () => {
    await saveCharacter(makeChar(UUID_A));
    // Pre-create a portrait file
    await mkdir(paths.portraitsDir(), { recursive: true });
    const target = paths.portraitPath(UUID_A);
    await writeFile(target, buildPng(64, 64));
    // Patch the character's portrait_image to a path ref so removal is meaningful
    await saveCharacter({ ...makeChar(UUID_A), portrait_image: `${UUID_A}.png` });

    await removePortrait(UUID_A);

    const persisted = JSON.parse(
      await readFile(paths.characterPath(UUID_A), 'utf8'),
    );
    expect(persisted.portrait_image).toBeNull();
    // File should be gone
    await expect(access(target)).rejects.toThrow();
  });

  it('swallows ENOENT on missing portrait file', async () => {
    await saveCharacter(makeChar(UUID_A));
    // No file exists; should not throw.
    await expect(removePortrait(UUID_A)).resolves.toBeUndefined();
    const persisted = JSON.parse(
      await readFile(paths.characterPath(UUID_A), 'utf8'),
    );
    expect(persisted.portrait_image).toBeNull();
  });
});

// ── Versions (260909) ─────────────────────────────────────────────────────

/** A PNG whose IDAT differs per `tag` so version bytes are distinguishable. */
function buildTaggedPng(tag: number): Buffer {
  const png = buildPng(64, 64);
  // Append a private ancillary chunk; validatePortrait only checks the
  // signature + IHDR, and byte-equality is what the tests compare.
  const data = Buffer.from([tag]);
  const chunk = buildChunk('tEXt', data);
  return Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)]);
}

async function readMeta(id: string): Promise<Record<string, unknown>> {
  const persisted = JSON.parse(await readFile(paths.characterPath(id), 'utf8'));
  return persisted.metadata ?? {};
}

describe('portrait versions', () => {
  it('an unversioned canonical portrait lists as a single virtual original', async () => {
    await saveCharacter({ ...makeChar(UUID_A), portrait_image: `${UUID_A}.png` });
    await mkdir(paths.portraitsDir(), { recursive: true });
    await writeFile(paths.portraitPath(UUID_A), buildTaggedPng(0));

    const state = await getPortraitVersions(UUID_A);
    expect(state.versions).toEqual([
      { file: `${UUID_A}.png`, created_at: expect.any(String), source: 'original' },
    ]);
    expect(state.active).toBe(`${UUID_A}.png`);
    expect(state.regenCount).toBe(0);
    expect(state.regenLimit).toBe(MAX_PORTRAIT_REGENS);
    // Listing must not materialize anything on disk.
    expect(await listPortraitVersionFilesOnDisk(UUID_A)).toEqual([]);
  });

  it('first regen snapshots the existing canonical as v1 (original) and stores v2', async () => {
    await saveCharacter({ ...makeChar(UUID_A), portrait_image: `${UUID_A}.png` });
    await mkdir(paths.portraitsDir(), { recursive: true });
    const original = buildTaggedPng(0);
    await writeFile(paths.portraitPath(UUID_A), original);

    const regen = buildTaggedPng(1);
    const state = await addPortraitVersion({ characterId: UUID_A, bytes: regen, source: 'regen' });

    expect(state.versions.map((v) => [v.file, v.source])).toEqual([
      [`${UUID_A}-v1.png`, 'original'],
      [`${UUID_A}-v2.png`, 'regen'],
    ]);
    expect(state.active).toBe(`${UUID_A}-v2.png`);
    expect(state.regenCount).toBe(1);
    // Sidecars hold the right bytes; canonical now holds the regen.
    expect((await readFile(paths.portraitPath(UUID_A))).equals(regen)).toBe(true);
    expect((await readFile(path.join(paths.portraitsDir(), `${UUID_A}-v1.png`))).equals(original)).toBe(true);
    expect((await readFile(path.join(paths.portraitsDir(), `${UUID_A}-v2.png`))).equals(regen)).toBe(true);
    // Metadata persisted on the character row.
    const meta = await readMeta(UUID_A);
    expect(meta.portrait_active).toBe(`${UUID_A}-v2.png`);
    expect(meta.portrait_regen_count).toBe(1);
    expect((meta.portrait_versions as unknown[]).length).toBe(2);
  });

  it('a character with no portrait gets v1 as the regen itself (nothing to snapshot)', async () => {
    await saveCharacter(makeChar(UUID_A));
    const state = await addPortraitVersion({ characterId: UUID_A, bytes: buildTaggedPng(1), source: 'regen' });
    expect(state.versions.map((v) => [v.file, v.source])).toEqual([[`${UUID_A}-v1.png`, 'regen']]);
    expect(state.active).toBe(`${UUID_A}-v1.png`);
  });

  it('select copies the sidecar bytes onto the canonical file and sets portrait_active', async () => {
    await saveCharacter({ ...makeChar(UUID_A), portrait_image: `${UUID_A}.png` });
    await mkdir(paths.portraitsDir(), { recursive: true });
    const original = buildTaggedPng(0);
    await writeFile(paths.portraitPath(UUID_A), original);
    const regen = buildTaggedPng(1);
    await addPortraitVersion({ characterId: UUID_A, bytes: regen, source: 'regen' });
    expect((await readFile(paths.portraitPath(UUID_A))).equals(regen)).toBe(true);

    const state = await selectPortraitVersion({ characterId: UUID_A, file: `${UUID_A}-v1.png` });

    expect(state.active).toBe(`${UUID_A}-v1.png`);
    expect((await readFile(paths.portraitPath(UUID_A))).equals(original)).toBe(true);
    const persisted = JSON.parse(await readFile(paths.characterPath(UUID_A), 'utf8'));
    expect(persisted.portrait_image).toBe(`${UUID_A}.png`);
    expect(persisted.metadata.portrait_active).toBe(`${UUID_A}-v1.png`);
    // Selecting does not consume a regeneration.
    expect(state.regenCount).toBe(1);
    // Both sidecars survive the swap.
    expect(await listPortraitVersionFilesOnDisk(UUID_A)).toEqual([`${UUID_A}-v1.png`, `${UUID_A}-v2.png`]);
  });

  it('select rejects a file that is not a recorded version of this character', async () => {
    await saveCharacter(makeChar(UUID_A));
    await addPortraitVersion({ characterId: UUID_A, bytes: buildTaggedPng(1), source: 'regen' });
    await expect(
      selectPortraitVersion({ characterId: UUID_A, file: `${UUID_A}-v9.png` }),
    ).rejects.toThrow(/Unknown portrait version/);
    await expect(
      selectPortraitVersion({ characterId: UUID_A, file: '../../etc/passwd.png' }),
    ).rejects.toThrow(/Unknown portrait version/);
  });

  it('refuses a regen past MAX_PORTRAIT_REGENS but still accepts uploads', async () => {
    await saveCharacter(makeChar(UUID_A));
    for (let i = 1; i <= MAX_PORTRAIT_REGENS; i++) {
      const state = await addPortraitVersion({ characterId: UUID_A, bytes: buildTaggedPng(i), source: 'regen' });
      expect(state.regenCount).toBe(i);
    }
    await expect(
      addPortraitVersion({ characterId: UUID_A, bytes: buildTaggedPng(9), source: 'regen' }),
    ).rejects.toThrow(/PORTRAIT_REGEN_LIMIT/);
    // Count is untouched by the refused attempt, and an upload still works.
    expect((await readMeta(UUID_A)).portrait_regen_count).toBe(MAX_PORTRAIT_REGENS);
    const after = await applyPortrait({ characterId: UUID_A, bytes: buildTaggedPng(10) });
    expect(after).toBe(`${UUID_A}.png`);
    const state = await getPortraitVersions(UUID_A);
    expect(state.regenCount).toBe(MAX_PORTRAIT_REGENS);
    expect(state.versions.at(-1)?.source).toBe('upload');
  });

  it('applyPortrait (picker upload) records an upload version', async () => {
    await saveCharacter(makeChar(UUID_A));
    await applyPortrait({ characterId: UUID_A, bytes: buildTaggedPng(1) });
    await applyPortrait({ characterId: UUID_A, bytes: buildTaggedPng(2) });
    const state = await getPortraitVersions(UUID_A);
    expect(state.versions.map((v) => [v.file, v.source])).toEqual([
      [`${UUID_A}-v1.png`, 'upload'],
      [`${UUID_A}-v2.png`, 'upload'],
    ]);
    expect(state.active).toBe(`${UUID_A}-v2.png`);
    expect(state.regenCount).toBe(0);
  });

  it('evicts the oldest inactive upload past MAX_PORTRAIT_VERSIONS, never the original', async () => {
    await saveCharacter({ ...makeChar(UUID_A), portrait_image: `${UUID_A}.png` });
    await mkdir(paths.portraitsDir(), { recursive: true });
    await writeFile(paths.portraitPath(UUID_A), buildTaggedPng(0));
    for (let i = 1; i <= MAX_PORTRAIT_VERSIONS; i++) {
      await applyPortrait({ characterId: UUID_A, bytes: buildTaggedPng(i) });
    }
    const state = await getPortraitVersions(UUID_A);
    expect(state.versions.length).toBe(MAX_PORTRAIT_VERSIONS);
    expect(state.versions[0]).toMatchObject({ file: `${UUID_A}-v1.png`, source: 'original' });
    // v2 (the oldest upload) was evicted, on disk too.
    expect(state.versions.some((v) => v.file === `${UUID_A}-v2.png`)).toBe(false);
    expect(await listPortraitVersionFilesOnDisk(UUID_A)).not.toContain(`${UUID_A}-v2.png`);
    expect(state.active).toBe(`${UUID_A}-v${MAX_PORTRAIT_VERSIONS + 1}.png`);
  });

  it('removePortrait unlinks the sidecars and clears the version metadata', async () => {
    await saveCharacter(makeChar(UUID_A));
    await addPortraitVersion({ characterId: UUID_A, bytes: buildTaggedPng(1), source: 'regen' });
    await applyPortrait({ characterId: UUID_A, bytes: buildTaggedPng(2) });
    expect(await listPortraitVersionFilesOnDisk(UUID_A)).toHaveLength(2);

    await removePortrait(UUID_A);

    expect(await listPortraitVersionFilesOnDisk(UUID_A)).toEqual([]);
    await expect(access(paths.portraitPath(UUID_A))).rejects.toThrow();
    const meta = await readMeta(UUID_A);
    expect(meta.portrait_versions).toBeUndefined();
    expect(meta.portrait_active).toBeUndefined();
    // Lifetime cap survives a remove.
    expect(meta.portrait_regen_count).toBe(1);
    expect((await getCharacter(UUID_A))?.portrait_image).toBeNull();
  });

  it('deleteCharacter removes the canonical portrait, its sidecars and the upload marker', async () => {
    await saveCharacter(makeChar(UUID_A));
    await addPortraitVersion({ characterId: UUID_A, bytes: buildTaggedPng(1), source: 'regen' });
    await applyPortrait({ characterId: UUID_A, bytes: buildTaggedPng(2) });
    await writeFile(`${paths.portraitPath(UUID_A)}.uploaded.json`, '{"owner":"x","md5":"y"}');
    // The reserved slots must survive untouched.
    await writeFile(paths.portraitPath('_user'), buildPng(8, 8));

    await deleteCharacter(UUID_A);

    await expect(access(paths.portraitPath(UUID_A))).rejects.toThrow();
    await expect(access(`${paths.portraitPath(UUID_A)}.uploaded.json`)).rejects.toThrow();
    expect(await listPortraitVersionFilesOnDisk(UUID_A)).toEqual([]);
    await expect(access(paths.portraitPath('_user'))).resolves.toBeUndefined();
  });

  it('deletePortraitFiles is ENOENT-tolerant', async () => {
    await expect(deletePortraitFiles(UUID_A)).resolves.toBeUndefined();
  });

  it('removePortrait also drops the md5 upload marker', async () => {
    await saveCharacter(makeChar(UUID_A));
    await applyPortrait({ characterId: UUID_A, bytes: buildTaggedPng(1) });
    const marker = `${paths.portraitPath(UUID_A)}.uploaded.json`;
    await writeFile(marker, '{"owner":"x","md5":"y"}');

    await removePortrait(UUID_A);

    await expect(access(marker)).rejects.toThrow();
  });
});

// ── Synced metadata vs local sidecars (second-device reconciliation) ──────
//
// `metadata.portrait_versions` / `portrait_active` ride the cloud row verbatim
// but the `<uuid>-v<n>.png` sidecars are local-only, so a second device (or a
// cache-on-demand row) carries a version list whose files it never had.

describe('portrait versions: metadata synced without sidecars', () => {
  const syncedMeta = {
    portrait_versions: [
      { file: `${UUID_A}-v1.png`, created_at: '2026-05-21T00:00:00.000Z', source: 'original' },
      { file: `${UUID_A}-v2.png`, created_at: '2026-05-22T00:00:00.000Z', source: 'regen' },
    ],
    portrait_active: `${UUID_A}-v2.png`,
    portrait_regen_count: 1,
  };

  async function seedSyncedCharacter(canonical: Buffer): Promise<void> {
    await saveCharacter({ ...makeChar(UUID_A), portrait_image: `${UUID_A}.png`, metadata: syncedMeta });
    await mkdir(paths.portraitsDir(), { recursive: true });
    await writeFile(paths.portraitPath(UUID_A), canonical);
  }

  it('lists only the virtual canonical original when no recorded sidecar is on disk', async () => {
    await seedSyncedCharacter(buildTaggedPng(0));

    const state = await getPortraitVersions(UUID_A);

    expect(state.versions).toEqual([
      { file: `${UUID_A}.png`, created_at: expect.any(String), source: 'original' },
    ]);
    expect(state.active).toBe(`${UUID_A}.png`);
    // The regen count is metadata and DOES follow the character.
    expect(state.regenCount).toBe(1);
    expect(await listPortraitVersionFilesOnDisk(UUID_A)).toEqual([]);
  });

  it('a write on that device snapshots its canonical first, past the synced indices', async () => {
    const canonical = buildTaggedPng(0);
    await seedSyncedCharacter(canonical);

    const upload = buildTaggedPng(5);
    const state = await addPortraitVersion({ characterId: UUID_A, bytes: upload });

    // v1/v2 are taken by the synced records, so the snapshot is v3 and the
    // upload v4; the phantom entries are dropped from the list.
    expect(state.versions.map((v) => [v.file, v.source])).toEqual([
      [`${UUID_A}-v3.png`, 'original'],
      [`${UUID_A}-v4.png`, 'upload'],
    ]);
    expect(state.active).toBe(`${UUID_A}-v4.png`);
    expect((await readFile(path.join(paths.portraitsDir(), `${UUID_A}-v3.png`))).equals(canonical)).toBe(true);
    expect((await readFile(paths.portraitPath(UUID_A))).equals(upload)).toBe(true);
    // Switching back to what this device was showing works.
    const back = await selectPortraitVersion({ characterId: UUID_A, file: `${UUID_A}-v3.png` });
    expect(back.active).toBe(`${UUID_A}-v3.png`);
    expect((await readFile(paths.portraitPath(UUID_A))).equals(canonical)).toBe(true);
  });

  it('selecting a recorded-but-missing version is an unknown version, not ENOENT', async () => {
    await seedSyncedCharacter(buildTaggedPng(0));
    await expect(
      selectPortraitVersion({ characterId: UUID_A, file: `${UUID_A}-v2.png` }),
    ).rejects.toThrow(/Unknown portrait version/);
    // Nothing was written or changed by the refusal.
    expect((await getPortraitVersions(UUID_A)).active).toBe(`${UUID_A}.png`);
  });

  it('keeps the sidecars that ARE on disk and reports the canonical as active when the recorded active is not', async () => {
    const canonical = buildTaggedPng(0);
    await seedSyncedCharacter(canonical);
    // Only v1 made it to this machine; the recorded active (v2) did not.
    const v1 = buildTaggedPng(1);
    await writeFile(path.join(paths.portraitsDir(), `${UUID_A}-v1.png`), v1);

    const state = await getPortraitVersions(UUID_A);
    expect(state.versions.map((v) => v.file)).toEqual([`${UUID_A}-v1.png`]);
    expect(state.active).toBe(`${UUID_A}.png`);

    // A regen on this device still snapshots the canonical it is showing.
    const next = await addPortraitVersion({ characterId: UUID_A, bytes: buildTaggedPng(7), source: 'regen' });
    expect(next.versions.map((v) => [v.file, v.source])).toEqual([
      [`${UUID_A}-v1.png`, 'original'],
      [`${UUID_A}-v3.png`, 'original'],
      [`${UUID_A}-v4.png`, 'regen'],
    ]);
    expect((await readFile(path.join(paths.portraitsDir(), `${UUID_A}-v3.png`))).equals(canonical)).toBe(true);
    expect(next.regenCount).toBe(2);
  });
});
