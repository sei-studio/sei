/**
 * 261027 lazy skins: the skin_pending marker follows the skin. Only the
 * creation placeholder keeps it; any skin the player picks (upload, search,
 * remove) or a generated one clears it, so a later launch never replaces it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Character } from '../shared/characterSchema';

const h = vi.hoisted(() => ({ userData: '', saved: null as Character | null, current: null as Character | null }));

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./paths', () => ({
  paths: {
    userData: () => h.userData,
    skinsDir: () => path.join(h.userData, 'skins'),
    skinPngPath: (id: string) => path.join(h.userData, 'skins', `${id}.png`),
  },
}));
vi.mock('./characterStore', () => ({
  getCharacter: vi.fn(async () => (h.current ? structuredClone(h.current) : null)),
  saveCharacter: vi.fn(async (c: Character) => {
    h.saved = structuredClone(c);
    h.current = structuredClone(c);
  }),
}));
vi.mock('./cloud/syncQueue', () => ({ enqueueUpsert: vi.fn(async () => {}) }));

import { applyPng, removePng } from './skinStore';

/** Minimal valid 64x64 RGBA PNG. */
function png64(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer): number => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(64 * (1 + 64 * 4)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ID = '11111111-1111-1111-1111-111111111111';
function mkChar(metadata: Record<string, unknown>): Character {
  return {
    id: ID,
    kind: 'unique',
    public_id: null,
    name: 'Nova',
    persona: { source: 'x', expanded: '' },
    is_default: false,
    shared: false,
    slug: null,
    metadata,
    created: '2026-01-01T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    username: null,
    owner: null,
    skin: { source: 'upload', mojang_username: null, png_sha256: 'old', applied_at: null },
  } as Character;
}

beforeEach(async () => {
  h.userData = await mkdtemp(path.join(tmpdir(), 'sei-skin-pending-'));
  h.saved = null;
});
afterEach(async () => {
  await rm(h.userData, { recursive: true, force: true }).catch(() => {});
});

describe('skin_pending follows the skin', () => {
  it('applyPng with skinPending: true sets the marker (the creation placeholder)', async () => {
    h.current = mkChar({ other: 1 });
    await applyPng({ personaId: ID, pngBytes: png64(), source: 'upload', skinPending: true });
    expect(h.saved!.metadata).toEqual({ other: 1, skin_pending: true });
  });

  it('any other applyPng clears it (upload, search, a generated skin)', async () => {
    h.current = mkChar({ other: 1, skin_pending: true });
    await applyPng({ personaId: ID, pngBytes: png64(), source: 'upload' });
    expect(h.saved!.metadata).toEqual({ other: 1 });
  });

  it('removing the skin clears it too', async () => {
    h.current = mkChar({ skin_pending: true });
    await removePng(ID);
    expect(h.saved!.metadata).toEqual({});
    expect(h.saved!.skin.source).toBe('none');
  });
});




