/**
 * Lazy Minecraft skins (261027): when the Gemini skin call runs, what it is
 * charged for, and what a character is left wearing. Gemini, the proxy and
 * img2skin are all faked; the real skinStore writes the skin and the marker.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Character } from '../shared/characterSchema';

const h = vi.hoisted(() => ({
  root: '',
  chars: new Map<string, Character>(),
  session: { access_token: 'jwt-1', user: { id: 'user-1' } } as null | { access_token: string; user: { id: string } },
  /** What img2skin's panel branch says about the atlas. */
  panelValid: true,
  img2skinCalls: [] as Array<{ branch: string; variant: string; mockAtlas: string | null }>,
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp/sei-default' } }));
vi.mock('./paths', () => ({
  paths: {
    skinsDir: () => path.join(h.root, 'skins'),
    skinPngPath: (id: string) => path.join(h.root, 'skins', `${id}.png`),
    portraitPath: (id: string) => path.join(h.root, 'portraits', `${id}.png`),
  },
}));
vi.mock('./characterStore', () => ({
  getCharacter: vi.fn(async (id: string) => {
    const c = h.chars.get(id);
    return c ? structuredClone(c) : null;
  }),
  saveCharacter: vi.fn(async (c: Character) => {
    h.chars.set(c.id, structuredClone(c));
  }),
}));
vi.mock('./cloud/syncQueue', () => ({ enqueueUpsert: vi.fn(async () => {}) }));
vi.mock('./auth/supabaseClient', () => ({
  getClient: () => ({ auth: { getSession: async () => ({ data: { session: h.session } }) } }),
}));
vi.mock('img2skin/src/pipeline.js', () => ({
  characterToSkin: vi.fn(
    async (_src: string, out: string, opts: { branch: string; variant: string; mockAtlas?: string | null }) => {
      h.img2skinCalls.push({ branch: opts.branch, variant: opts.variant, mockAtlas: opts.mockAtlas ?? null });
      const valid = opts.branch === 'fallback' ? true : h.panelValid;
      if (valid) await writeFile(out, png(opts.branch === 'fallback' ? 1 : 2));
      return { skin: out, preview: '', branch: opts.branch, valid };
    },
  ),
}));

import {
  ensureMinecraftSkin,
  generateSkinForCharacter,
  paintFallbackSkin,
  skinVariantOf,
  _resetSkinGenerationForTests,
} from './skinGeneration';

// â”€â”€ 64x64 PNG with a marker byte, so painted (1) and generated (2) differ â”€â”€
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(64 * (1 + 64 * 4)))),
    chunk('tEXt', Buffer.from([tag])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ID = '550e8400-e29b-41d4-a716-446655440000';
const CHARGE_ID = '7d5e2c1a-3b4f-4e6a-9c8d-1f2e3d4c5b6a';
const PAINTED = { source: 'upload' as const, mojang_username: null, png_sha256: 'painted', applied_at: null };
const NO_SKIN = { source: 'none' as const, mojang_username: null, png_sha256: null, applied_at: null };

function mkChar(over: Partial<Character> = {}): Character {
  return {
    id: ID,
    kind: 'unique',
    public_id: null,
    name: 'Nova',
    persona: { source: 'x', expanded: 'y' },
    is_default: false,
    shared: false,
    slug: null,
    metadata: { skin_pending: true, soulcaster_sheet: { gender: 'female' } },
    created: '2026-10-27T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: `${ID}.png`,
    skin: PAINTED,
    username: null,
    owner: 'user-1',
    ...over,
  } as Character;
}

type Call = { url: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
/** Answer for POST /generate/skin. */
let skinAnswer: () => Response;

function okPanel(chargeId: string | null = CHARGE_ID): Response {
  return new Response(JSON.stringify({ png_base64: png(9).toString('base64') }), {
    status: 200,
    headers: chargeId ? { 'content-type': 'application/json', 'x-sei-charge-id': chargeId } : {},
  });
}

function skinCalls(): Call[] {
  return calls.filter((c) => c.url.endsWith('/generate/skin'));
}
function confirmCalls(): Call[] {
  return calls.filter((c) => c.url.endsWith('/generate/skin/confirm'));
}
function stored(): Character {
  return h.chars.get(ID)!;
}

// Some deps are imported lazily. Two concurrent first imports of a mocked
// module can race vitest's mock registry, so warm them once.
beforeAll(async () => {
  await import('./auth/supabaseClient');
  await import('img2skin/src/pipeline.js');
});

beforeEach(async () => {
  h.root = await mkdtemp(path.join(tmpdir(), 'sei-skingen-'));
  await mkdir(path.join(h.root, 'portraits'), { recursive: true });
  await writeFile(path.join(h.root, 'portraits', `${ID}.png`), png(5));
  h.chars.clear();
  h.session = { access_token: 'jwt-1', user: { id: 'user-1' } };
  h.panelValid = true;
  h.img2skinCalls = [];
  calls = [];
  skinAnswer = () => okPanel();
  _resetSkinGenerationForTests();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    if (url.endsWith('/generate/skin/confirm')) {
      return new Response(JSON.stringify({ ok: true, charged: true }), { status: 200 });
    }
    return skinAnswer();
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(h.root, { recursive: true, force: true }).catch(() => {});
});

describe('ensureMinecraftSkin (launch panel / launch)', () => {
  it('does nothing for a character without the pending marker', async () => {
    h.chars.set(ID, mkChar({ metadata: {} }));
    const res = await ensureMinecraftSkin(ID);
    expect(res.outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('pending: one confirm-mode Gemini call, the skin applied, the charge confirmed as used, marker cleared', async () => {
    h.chars.set(ID, mkChar());
    const res = await ensureMinecraftSkin(ID);
    expect(res.outcome).toBe('generated');
    expect(skinCalls()).toHaveLength(1);
    expect(skinCalls()[0].headers['x-sei-charge-confirm']).toBe('1');
    expect(skinCalls()[0].headers.Authorization).toBe('Bearer jwt-1');
    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0].body).toEqual({ charge_id: CHARGE_ID, used: true });
    expect(h.img2skinCalls).toEqual([expect.objectContaining({ branch: 'panel', variant: 'slim' })]);
    expect(stored().metadata.skin_pending).toBeUndefined();
    expect(stored().skin.source).toBe('upload');
    expect(stored().skin.png_sha256).not.toBe('painted');
    const bytes = await readFile(path.join(h.root, 'skins', `${ID}.png`));
    expect(bytes.equals(png(2))).toBe(true);
  });

  it('charges once per character: a second open (or launch) makes no call', async () => {
    h.chars.set(ID, mkChar());
    await ensureMinecraftSkin(ID);
    const again = await ensureMinecraftSkin(ID);
    expect(again.outcome).toBe('skipped');
    expect(skinCalls()).toHaveLength(1);
  });

  it('a panel open and a launch at the same time share one call', async () => {
    h.chars.set(ID, mkChar());
    const [a, b] = await Promise.all([ensureMinecraftSkin(ID), ensureMinecraftSkin(ID)]);
    expect(a.outcome).toBe('generated');
    expect(b.outcome).toBe('generated');
    expect(skinCalls()).toHaveLength(1);
  });

  it('402 (not enough credits): no confirm, the painted skin stays, marker kept for a later run', async () => {
    h.chars.set(ID, mkChar());
    skinAnswer = () => new Response(JSON.stringify({ error: 'payment_required', detail: 'insufficient_credits' }), { status: 402 });
    const res = await ensureMinecraftSkin(ID);
    expect(res.outcome).toBe('insufficient_credits');
    expect(confirmCalls()).toHaveLength(0);
    expect(stored().skin.png_sha256).toBe('painted');
    expect(stored().metadata.skin_pending).toBe(true);
  });

  it('402 on a character with no skin at all: the free painted skin is applied (launch still gets a skin)', async () => {
    h.chars.set(ID, mkChar({ skin: NO_SKIN }));
    skinAnswer = () => new Response('{}', { status: 402 });
    const res = await ensureMinecraftSkin(ID);
    expect(res.outcome).toBe('insufficient_credits');
    expect(h.img2skinCalls).toEqual([expect.objectContaining({ branch: 'fallback', variant: 'slim' })]);
    expect(stored().skin.source).toBe('upload');
    expect(stored().metadata.skin_pending).toBe(true);
    const bytes = await readFile(path.join(h.root, 'skins', `${ID}.png`));
    expect(bytes.equals(png(1))).toBe(true);
  });

  it('429 daily cap and network errors map to their outcomes and never throw', async () => {
    h.chars.set(ID, mkChar());
    skinAnswer = () => new Response('{}', { status: 429 });
    expect((await ensureMinecraftSkin(ID)).outcome).toBe('daily_limit');
    _resetSkinGenerationForTests();
    skinAnswer = () => {
      throw new Error('ECONNRESET');
    };
    expect((await ensureMinecraftSkin(ID)).outcome).toBe('failed');
    expect(stored().metadata.skin_pending).toBe(true);
  });

  it('an image img2skin cannot map: charge confirmed as NOT used, painted skin kept, marker cleared (no automatic re-send)', async () => {
    h.chars.set(ID, mkChar());
    h.panelValid = false;
    const res = await ensureMinecraftSkin(ID);
    expect(res.outcome).toBe('failed');
    expect(confirmCalls()[0].body).toEqual({ charge_id: CHARGE_ID, used: false });
    expect(stored().skin.png_sha256).toBe('painted');
    expect(stored().metadata.skin_pending).toBeUndefined();
  });

  it('a 200 with no image is reported as not used', async () => {
    h.chars.set(ID, mkChar());
    skinAnswer = () => new Response('{}', { status: 200, headers: { 'x-sei-charge-id': CHARGE_ID } });
    const res = await ensureMinecraftSkin(ID);
    expect(res.outcome).toBe('failed');
    expect(confirmCalls()[0].body).toEqual({ charge_id: CHARGE_ID, used: false });
  });

  it('an image body that fails after the charge was held is refunded, marker kept', async () => {
    h.chars.set(ID, mkChar());
    skinAnswer = () =>
      ({
        status: 200,
        ok: true,
        headers: new Headers({ 'x-sei-charge-id': CHARGE_ID }),
        json: async () => {
          throw new Error('body stream aborted');
        },
      }) as unknown as Response;
    const res = await ensureMinecraftSkin(ID);
    expect(res.outcome).toBe('failed');
    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0].body).toEqual({ charge_id: CHARGE_ID, used: false });
    expect(stored().metadata.skin_pending).toBe(true);
  });

  it('a proxy without confirm mode (no charge id): no confirm call', async () => {
    h.chars.set(ID, mkChar());
    skinAnswer = () => okPanel(null);
    expect((await ensureMinecraftSkin(ID)).outcome).toBe('generated');
    expect(confirmCalls()).toHaveLength(0);
  });

  it('never for someone else\'s character, a default, or when signed out', async () => {
    h.chars.set(ID, mkChar({ owner: 'someone-else' }));
    expect((await ensureMinecraftSkin(ID)).outcome).toBe('not_allowed');
    _resetSkinGenerationForTests();
    h.chars.set(ID, mkChar({ is_default: true }));
    expect((await ensureMinecraftSkin(ID)).outcome).toBe('not_allowed');
    _resetSkinGenerationForTests();
    h.chars.set(ID, mkChar());
    h.session = null;
    expect((await ensureMinecraftSkin(ID)).outcome).toBe('not_signed_in');
    expect(calls).toHaveLength(0);
  });

  it('no portrait on disk: nothing is sent', async () => {
    h.chars.set(ID, mkChar());
    await rm(path.join(h.root, 'portraits', `${ID}.png`));
    expect((await ensureMinecraftSkin(ID)).outcome).toBe('no_portrait');
    expect(calls).toHaveLength(0);
  });
});

describe('generateSkinForCharacter (the profile button)', () => {
  it('is a new billed call every press, even when the skin was already made', async () => {
    h.chars.set(ID, mkChar({ metadata: {} }));
    expect((await generateSkinForCharacter(ID)).outcome).toBe('generated');
    expect((await generateSkinForCharacter(ID)).outcome).toBe('generated');
    expect(skinCalls()).toHaveLength(2);
    expect(confirmCalls()).toHaveLength(2);
  });

  it('a failed regenerate keeps the current skin (no painter over it)', async () => {
    h.chars.set(ID, mkChar({ metadata: {} }));
    skinAnswer = () => new Response('{}', { status: 502 });
    expect((await generateSkinForCharacter(ID)).outcome).toBe('failed');
    expect(h.img2skinCalls).toHaveLength(0);
    expect(stored().skin.png_sha256).toBe('painted');
  });

  it('a press counts as this run\'s attempt, so the launch after it does not call again', async () => {
    h.chars.set(ID, mkChar());
    skinAnswer = () => new Response('{}', { status: 402 });
    await generateSkinForCharacter(ID);
    expect((await ensureMinecraftSkin(ID)).outcome).toBe('skipped');
    expect(skinCalls()).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('variant: slim for female sheets, classic otherwise', () => {
    expect(skinVariantOf(mkChar())).toBe('slim');
    expect(skinVariantOf(mkChar({ metadata: { soulcaster_sheet: { gender: 'male' } } }))).toBe('classic');
    expect(skinVariantOf(mkChar({ metadata: {} }))).toBe('classic');
  });

  it('paintFallbackSkin runs only the no-network painter', async () => {
    const out = await paintFallbackSkin(png(5), 'classic');
    expect(out.equals(png(1))).toBe(true);
    expect(h.img2skinCalls).toEqual([{ branch: 'fallback', variant: 'classic', mockAtlas: null }]);
    expect(calls).toHaveLength(0);
  });
});




