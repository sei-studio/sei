/**
 * regeneratePortrait orchestration (260909) — exercised with an injected
 * `generate` so no KusArt / network is touched. Also covers the pure prompt
 * builders it relies on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

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
vi.mock('./cloud/syncQueue', () => ({
  enqueueUpsert: vi.fn(async () => {}),
  enqueueDelete: vi.fn(async () => {}),
  processNext: vi.fn(async () => {}),
}));

import { _setUserDataOverride, paths } from './paths';
import { saveCharacter } from './characterStore';
import { getPortraitVersions } from './portraitStore';
import { listPortraitVersionFilesOnDisk } from './portraitFiles';
import {
  assemblePortraitPrompt,
  buildRegenPortraitPrompt,
  regeneratePortrait,
} from './uniqueGeneration';
import type { Character } from '../shared/characterSchema';
import { MAX_PORTRAIT_REGENS } from '../shared/characterSchema';

const UUID_A = '550e8400-e29b-41d4-a716-446655440000';

// ── Minimal valid PNG (64x64 RGBA) with a per-tag marker chunk ─────────────
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
function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function png(tag: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  const raw = Buffer.alloc(64 * (1 + 64 * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('tEXt', Buffer.from([tag])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeChar(over: Partial<Character> = {}): Character {
  return {
    id: UUID_A,
    kind: 'custom',
    public_id: null,
    name: 'Mira',
    persona: { source: 'A wry cartographer with ink-stained fingers.', expanded: '' },
    is_default: false,
    shared: false,
    slug: null,
    metadata: {},
    created: '2026-05-21T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
    description: 'a wry wood elf cartographer',
    ...over,
  };
}

const SHEET = {
  name: 'Anaya',
  gender: 'female',
  background: 'beastkin',
  personality: { tone: 'direct and candid — never flustered', values: [], quirks: [], fears: [] },
  image_prompt: 'A wolf-eared ranger with silver hair.',
};

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-regen-'));
  _setUserDataOverride(tmp);
});
afterEach(async () => {
  _setUserDataOverride(null);
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('assemblePortraitPrompt', () => {
  it('appends the framing suffix, tone + beastkin clauses and strips dashes', () => {
    const p = assemblePortraitPrompt({ subject: 'A knight — armored.', tone: 'calm – steady', beastkin: true });
    expect(p.startsWith('A knight, armored. One character, medium shot from the waist up.')).toBe(true);
    expect(p).toContain('convey: calm, steady.');
    expect(p).toContain('Beastkin: fully human face');
    expect(p).not.toMatch(/[—–]/);
  });
  it('omits the optional clauses when absent', () => {
    const p = assemblePortraitPrompt({ subject: 'A scholar' });
    expect(p).not.toContain('convey:');
    expect(p).not.toContain('Beastkin');
  });
});

describe('buildRegenPortraitPrompt', () => {
  it('uses the soulcaster sheet verbatim (image_prompt + tone + beastkin + gender)', () => {
    const r = buildRegenPortraitPrompt(makeChar({ metadata: { soulcaster_sheet: SHEET } }));
    expect(r).not.toBeNull();
    expect(r!.gender).toBe('female');
    expect(r!.prompt.startsWith('A wolf-eared ranger with silver hair. One character')).toBe(true);
    expect(r!.prompt).toContain('direct and candid, never flustered');
    expect(r!.prompt).toContain('Beastkin:');
  });
  it('falls back to name + description + persona source for hand-made characters', () => {
    const r = buildRegenPortraitPrompt(makeChar());
    expect(r!.gender).toBe('other');
    expect(r!.prompt).toContain('A character portrait of Mira. a wry wood elf cartographer');
    expect(r!.prompt).toContain('ink-stained fingers');
    expect(r!.prompt).toContain('One character, medium shot from the waist up.');
  });
  it('returns null when there is nothing to describe', () => {
    expect(buildRegenPortraitPrompt(makeChar({ name: ' ', description: null, persona: { source: '', expanded: '' } }))).toBeNull();
  });
});

describe('regeneratePortrait', () => {
  it('returns not_found for an unknown character without generating', async () => {
    const generate = vi.fn(async () => png(1));
    const r = await regeneratePortrait({ characterId: UUID_A, jwt: 'jwt', generate });
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns not_signed_in when there is no JWT (any backend mode)', async () => {
    await saveCharacter(makeChar());
    const generate = vi.fn(async () => png(1));
    const r = await regeneratePortrait({ characterId: UUID_A, jwt: null, generate });
    expect(r).toMatchObject({ ok: false, code: 'not_signed_in' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('generates from the sheet prompt, snapshots the original, stores v2 and counts the regen', async () => {
    await saveCharacter(makeChar({ metadata: { soulcaster_sheet: SHEET }, portrait_image: `${UUID_A}.png` }));
    await mkdir(paths.portraitsDir(), { recursive: true });
    const original = png(0);
    await writeFile(paths.portraitPath(UUID_A), original);
    const fresh = png(7);
    const generate = vi.fn(async (_prompt: string, _style: string, _jwt: string) => fresh);

    const r = await regeneratePortrait({ characterId: UUID_A, jwt: 'jwt-123', generate });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(generate).toHaveBeenCalledTimes(1);
    const [prompt, styleId, jwt] = generate.mock.calls[0];
    expect(prompt).toContain('A wolf-eared ranger');
    expect(typeof styleId).toBe('string');
    expect(jwt).toBe('jwt-123');
    expect(r.state.regenCount).toBe(1);
    expect(r.state.active).toBe(`${UUID_A}-v2.png`);
    expect(r.state.versions.map((v) => v.source)).toEqual(['original', 'regen']);
    expect((await readFile(paths.portraitPath(UUID_A))).equals(fresh)).toBe(true);
    expect(await listPortraitVersionFilesOnDisk(UUID_A)).toEqual([`${UUID_A}-v1.png`, `${UUID_A}-v2.png`]);
  });

  it('maps a generator failure to network / generation_failed without storing anything', async () => {
    await saveCharacter(makeChar());
    const r1 = await regeneratePortrait({
      characterId: UUID_A,
      jwt: 'jwt',
      generate: async () => {
        throw new Error('fetch failed');
      },
    });
    expect(r1).toMatchObject({ ok: false, code: 'network' });
    const r2 = await regeneratePortrait({
      characterId: UUID_A,
      jwt: 'jwt',
      generate: async () => {
        throw new Error('image generation failed: task failed');
      },
    });
    expect(r2).toMatchObject({ ok: false, code: 'generation_failed' });
    expect(await listPortraitVersionFilesOnDisk(UUID_A)).toEqual([]);
    expect((await getPortraitVersions(UUID_A)).regenCount).toBe(0);
  });

  it('refuses past MAX_PORTRAIT_REGENS without calling the generator', async () => {
    await saveCharacter(makeChar({ metadata: { portrait_regen_count: MAX_PORTRAIT_REGENS } }));
    const generate = vi.fn(async () => png(1));
    const r = await regeneratePortrait({ characterId: UUID_A, jwt: 'jwt', generate });
    expect(r).toMatchObject({ ok: false, code: 'limit' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('the cap holds across successive successful regens', async () => {
    await saveCharacter(makeChar());
    for (let i = 1; i <= MAX_PORTRAIT_REGENS; i++) {
      const r = await regeneratePortrait({ characterId: UUID_A, jwt: 'jwt', generate: async () => png(i) });
      expect(r.ok).toBe(true);
    }
    const r = await regeneratePortrait({ characterId: UUID_A, jwt: 'jwt', generate: async () => png(9) });
    expect(r).toMatchObject({ ok: false, code: 'limit' });
    expect((await getPortraitVersions(UUID_A)).regenCount).toBe(MAX_PORTRAIT_REGENS);
  });
});
