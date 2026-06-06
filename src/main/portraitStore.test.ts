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
import { applyPortrait, removePortrait } from './portraitStore';
import { saveCharacter } from './characterStore';
import type { Character } from '../shared/characterSchema';

let tmp: string;

const UUID_A = '550e8400-e29b-41d4-a716-446655440000';

function makeChar(id: string): Character {
  return {
    id,
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
