/**
 * avatarStore (260804) — import/normalize/read/remove of Live2D model zips.
 *
 * The end-to-end import test runs against the REAL first test model (Snow
 * Bear Girl, GBK-named VTube Studio export) when it is present on this
 * machine, and is skipped otherwise — CI has no 19 MB proprietary model. The
 * synthetic-zip tests cover the same normalization contract everywhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

vi.mock('electron', () => ({
  app: {
    getPath: (_n: string) => '/tmp/sei-default',
  },
}));

import { _setUserDataOverride } from '../paths';
import {
  importAvatarZip,
  getAvatarManifest,
  readAvatarModelFiles,
  removeAvatar,
  mapEmotions,
  sanitizeEntryPath,
  buildSafePathMap,
  setAvatarAccessory,
  setAvatarLibraryLink,
  parseRigSpec,
  zipStoredAvatar,
  MANIFEST_VERSION,
} from './avatarStore';

const REAL_ZIP = '/Users/ouen/Downloads/_雪熊企划_雪熊少女.zip';
const REAL_RIG_ZIP = '/Users/ouen/slop/sei-studio/chibi-rig/chibi-rig-avatar.zip';

let dir: string;

/**
 * A PNG header the store accepts (signature, IHDR w x h, optional acTL, IEND;
 * CRCs are not checked), tagged with `n` after IEND so files differ.
 */
function pngOf(w: number, h: number, o: { actl?: boolean } = {}, ...n: number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(o.actl ? [chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))] : []),
    chunk('IEND', Buffer.alloc(0)),
    Buffer.from(n),
  ]);
}
/** A small static PNG (the store only keeps PNG/JPEG/WebP images), tagged with `n`. */
const png = (...n: number[]): Buffer => pngOf(2, 2, {}, ...n);
/** A baseline JPEG header (SOI, APP0, SOF0 2x2). */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 2, 1, 1, 0x11, 0]);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-avatar-'));
  _setUserDataOverride(dir);
});

afterEach(async () => {
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

/** A minimal, valid synthetic model zip. */
async function syntheticZip(opts?: {
  withExpressionRefs?: boolean;
  withEyeBlink?: boolean;
}): Promise<Buffer> {
  const zip = new JSZip();
  const settings = {
    Version: 3,
    FileReferences: {
      Moc: 'model.moc3',
      Textures: ['tex/texture_00.png'],
      ...(opts?.withExpressionRefs
        ? { Expressions: [{ Name: 'declared', File: 'declared.exp3.json' }] }
        : {}),
    },
    Groups: opts?.withEyeBlink
      ? [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] }]
      : [],
  };
  zip.file('mymodel/model.model3.json', JSON.stringify(settings));
  zip.file('mymodel/model.moc3', Buffer.from([1, 2, 3]));
  zip.file('mymodel/tex/texture_00.png', png(4, 5, 6));
  zip.file('mymodel/declared.exp3.json', JSON.stringify({ Type: 'Live2D Expression' }));
  zip.file('mymodel/生气.exp3.json', JSON.stringify({ Type: 'Live2D Expression' }));
  zip.file('mymodel/__MACOSX/._junk', Buffer.from([0]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('sanitizeEntryPath', () => {
  it('normalizes separators and strips empty segments', () => {
    expect(sanitizeEntryPath('a\\b\\c.png')).toBe('a/b/c.png');
    expect(sanitizeEntryPath('a//b/./c.png')).toBeNull(); // '.' segment rejected
    expect(sanitizeEntryPath('a//b//c.png')).toBe('a/b/c.png');
  });

  it('rejects traversal and absolute paths', () => {
    expect(sanitizeEntryPath('../evil.js')).toBeNull();
    expect(sanitizeEntryPath('a/../evil.js')).toBeNull();
    expect(sanitizeEntryPath('/abs/path.png')).toBeNull();
    expect(sanitizeEntryPath('C:/windows/x.png')).toBeNull();
  });
});

describe('buildSafePathMap', () => {
  it('slugs non-ASCII and spaces to underscores, keeping extensions', () => {
    const map = buildSafePathMap(['【雪熊企划】雪熊少女.moc3', '1 帽.exp3.json', 'plain.png']);
    expect(map.get('【雪熊企划】雪熊少女.moc3')).toBe('_.moc3');
    expect(map.get('1 帽.exp3.json')).toBe('1_.exp3.json');
    expect(map.get('plain.png')).toBe('plain.png');
    // Every output is loader-safe: encodeURI must be an identity.
    for (const v of map.values()) expect(encodeURI(v)).toBe(v);
  });

  it('dedupes collisions within a directory and maps directories consistently', () => {
    const map = buildSafePathMap(['雪熊.png', '企划.png', '目录/a.png', '目录/b.png']);
    const [first, second] = [map.get('企划.png'), map.get('雪熊.png')];
    expect(first).not.toBe(second);
    expect(new Set([first, second])).toEqual(new Set(['_.png', '_-2.png']));
    expect(map.get('目录/a.png')!.split('/')[0]).toBe(map.get('目录/b.png')!.split('/')[0]);
  });
});

describe('mapEmotions', () => {
  it('maps the Snow Bear Girl expression names onto the closed emotion set', () => {
    const names = [
      '1 帽', '2 手机', '3 麦克', '4 手柄', '5 外套',
      '6 泪', '7 害羞', '8 生气', '9 爱心眼', '10 星星眼',
    ];
    const emotions = mapEmotions(names);
    expect(emotions.sad).toBe('6 泪');
    expect(emotions.shy).toBe('7 害羞');
    expect(emotions.angry).toBe('8 生气');
    expect(emotions.love).toBe('9 爱心眼');
    expect(emotions.excited).toBe('10 星星眼');
    // Accessory toggles map to nothing.
    expect(Object.values(emotions)).not.toContain('1 帽');
    expect(Object.values(emotions)).not.toContain('2 手机');
  });

  it('maps English names too', () => {
    const emotions = mapEmotions(['smile_big', 'angry_face', 'tear_drop']);
    expect(emotions.happy).toBe('smile_big');
    expect(emotions.angry).toBe('angry_face');
    expect(emotions.sad).toBe('tear_drop');
  });
});

describe('importAvatarZip (synthetic)', () => {
  it('imports, strips the common root, registers undeclared expressions and adds EyeBlink', async () => {
    const manifest = await importAvatarZip('char-1', await syntheticZip());
    expect(manifest.entry).toBe('model.model3.json');
    expect(manifest.expressions.map((e) => e.name).sort()).toEqual(['declared', '生气']);
    expect(manifest.emotions.angry).toBe('生气');

    // The stored settings were normalized.
    const files = await readAvatarModelFiles('char-1');
    const settingsFile = files.find((f) => f.path === 'model.model3.json');
    expect(settingsFile).toBeDefined();
    const settings = JSON.parse(Buffer.from(settingsFile!.bytes).toString('utf8'));
    expect(settings.FileReferences.Expressions).toHaveLength(2);
    expect(
      settings.Groups.some(
        (g: { Name: string }) => g.Name === 'EyeBlink',
      ),
    ).toBe(true);
    // Junk never lands on disk.
    expect(files.some((f) => f.path.includes('__MACOSX'))).toBe(false);
  });

  it('keeps declared expression refs and an existing EyeBlink group intact', async () => {
    const manifest = await importAvatarZip(
      'char-2',
      await syntheticZip({ withExpressionRefs: true, withEyeBlink: true }),
    );
    const declared = manifest.expressions.find((e) => e.file.endsWith('declared.exp3.json'));
    expect(declared?.name).toBe('declared');
    const files = await readAvatarModelFiles('char-2');
    const settings = JSON.parse(
      Buffer.from(files.find((f) => f.path === 'model.model3.json')!.bytes).toString('utf8'),
    );
    const eyeBlinks = settings.Groups.filter((g: { Name: string }) => g.Name === 'EyeBlink');
    expect(eyeBlinks).toHaveLength(1);
  });

  it('rejects a zip with no model3.json', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'hi');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(importAvatarZip('char-3', bytes)).rejects.toThrow(/model3\.json/);
    expect(await getAvatarManifest('char-3')).toBeNull();
  });

  it('rejects a model referencing a missing texture', async () => {
    const zip = new JSZip();
    zip.file(
      'm.model3.json',
      JSON.stringify({ FileReferences: { Moc: 'm.moc3', Textures: ['missing.png'] } }),
    );
    zip.file('m.moc3', Buffer.from([1]));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(importAvatarZip('char-4', bytes)).rejects.toThrow(/texture/);
  });

  it('stores every path ASCII-safe and rewrites settings refs to match', async () => {
    const manifest = await importAvatarZip('char-safe', await syntheticZip());
    expect(manifest.version).toBe(MANIFEST_VERSION);
    const files = await readAvatarModelFiles('char-safe');
    for (const f of files) {
      expect(encodeURI(f.path)).toBe(f.path); // no non-ASCII, no spaces
    }
    // 生气.exp3.json was renamed on disk but keeps its pretty NAME.
    const settings = JSON.parse(
      Buffer.from(files.find((f) => f.path === manifest.entry)!.bytes).toString('utf8'),
    );
    const byPath = new Set(files.map((f) => f.path));
    const angry = settings.FileReferences.Expressions.find(
      (e: { Name: string }) => e.Name === '生气',
    );
    expect(angry).toBeDefined();
    expect(byPath.has(angry.File)).toBe(true);
    expect(encodeURI(angry.File)).toBe(angry.File);
  });

  it('lazily re-normalizes a version-1 store (raw filenames) on manifest read', async () => {
    // Fabricate what the pre-rename import wrote: raw Chinese paths + v1 manifest.
    const { mkdir: mkdirP, writeFile: writeP } = await import('node:fs/promises');
    const storeDir = path.join(dir, 'profiles', 'local', 'avatars', 'char-v1');
    await mkdirP(storeDir, { recursive: true });
    const settings = {
      Version: 3,
      FileReferences: {
        Moc: '雪熊少女.moc3',
        Textures: ['雪熊少女.4096/texture_00.png'],
        Expressions: [{ Name: '生气', File: '8 生气.exp3.json' }],
      },
      Groups: [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen'] }],
    };
    await writeP(path.join(storeDir, '雪熊少女.model3.json'), JSON.stringify(settings));
    await writeP(path.join(storeDir, '雪熊少女.moc3'), Buffer.from([1]));
    await mkdirP(path.join(storeDir, '雪熊少女.4096'), { recursive: true });
    await writeP(path.join(storeDir, '雪熊少女.4096', 'texture_00.png'), png(2));
    await writeP(path.join(storeDir, '8 生气.exp3.json'), JSON.stringify({ Type: 'Live2D Expression' }));
    await writeP(
      path.join(storeDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        name: '雪熊少女',
        entry: '雪熊少女.model3.json',
        importedAt: new Date().toISOString(),
        bytes: 4,
        expressions: [{ name: '生气', file: '8 生气.exp3.json' }],
        emotions: { angry: '生气' },
      }),
    );

    const healed = await getAvatarManifest('char-v1');
    expect(healed).not.toBeNull();
    expect(healed!.version).toBe(MANIFEST_VERSION);
    expect(encodeURI(healed!.entry)).toBe(healed!.entry);
    const files = await readAvatarModelFiles('char-v1');
    for (const f of files) expect(encodeURI(f.path)).toBe(f.path);
    // Refs rewritten onto the renamed tree.
    const healedSettings = JSON.parse(
      Buffer.from(files.find((f) => f.path === healed!.entry)!.bytes).toString('utf8'),
    );
    const byPath = new Set(files.map((f) => f.path));
    expect(byPath.has(healedSettings.FileReferences.Moc)).toBe(true);
    expect(byPath.has(healedSettings.FileReferences.Textures[0])).toBe(true);
    expect(healed!.emotions.angry).toBe('生气');
    // Second read returns the healed manifest without re-running.
    expect((await getAvatarManifest('char-v1'))!.version).toBe(MANIFEST_VERSION);
  });

  it('remove is idempotent and clears the manifest', async () => {
    await importAvatarZip('char-5', await syntheticZip());
    expect(await getAvatarManifest('char-5')).not.toBeNull();
    await removeAvatar('char-5');
    await removeAvatar('char-5');
    expect(await getAvatarManifest('char-5')).toBeNull();
    expect(await readAvatarModelFiles('char-5')).toEqual([]);
  });
});

describe.skipIf(!existsSync(REAL_ZIP))('importAvatarZip (real Snow Bear Girl zip)', () => {
  it('imports the GBK-named VTube Studio export end to end', async () => {
    const bytes = await readFile(REAL_ZIP);
    const manifest = await importAvatarZip('sui-test', bytes);

    // GBK filenames decoded (the model name is the Chinese folder name).
    expect(manifest.name).toContain('雪熊');
    expect(manifest.entry.endsWith('.model3.json')).toBe(true);

    // All 10 expressions registered despite model3.json declaring none.
    expect(manifest.expressions).toHaveLength(10);
    expect(manifest.emotions.sad).toContain('泪');
    expect(manifest.emotions.shy).toContain('害羞');
    expect(manifest.emotions.angry).toContain('生气');
    expect(manifest.emotions.love).toContain('爱心');
    expect(manifest.emotions.excited).toContain('星星');

    // The normalized settings reference files that exist in the bundle.
    const files = await readAvatarModelFiles('sui-test');
    const byPath = new Map(files.map((f) => [f.path, f]));
    const settings = JSON.parse(
      Buffer.from(byPath.get(manifest.entry)!.bytes).toString('utf8'),
    );
    expect(settings.Groups.some((g: { Name: string }) => g.Name === 'EyeBlink')).toBe(true);
    for (const e of settings.FileReferences.Expressions) {
      expect(byPath.has(e.File)).toBe(true);
    }
    const moc = settings.FileReferences.Moc as string;
    expect(byPath.has(moc)).toBe(true);
    // Textures resolve too (4096 px pair).
    expect(settings.FileReferences.Textures).toHaveLength(2);
    for (const t of settings.FileReferences.Textures) {
      await access(path.join(dir, 'profiles', 'local', 'avatars', 'sui-test', ...t.split('/')))
        .then(() => true)
        .catch(() => {
          throw new Error(`texture missing on disk: ${t}`);
        });
    }
  }, 30_000);
});

describe('setAvatarAccessory', () => {
  it('toggles an accessory on and off, keeping the record sparse', async () => {
    await importAvatarZip('char-acc', await syntheticZip());
    const on = await setAvatarAccessory('char-acc', '生气', true);
    expect(on?.accessories).toEqual({ '生气': true });
    // Persisted: a fresh read sees it.
    expect((await getAvatarManifest('char-acc'))?.accessories).toEqual({ '生气': true });
    const off = await setAvatarAccessory('char-acc', '生气', false);
    expect(off?.accessories).toBeUndefined();
    expect((await getAvatarManifest('char-acc'))?.accessories).toBeUndefined();
  });

  it('ignores names the model does not ship', async () => {
    await importAvatarZip('char-acc2', await syntheticZip());
    const manifest = await setAvatarAccessory('char-acc2', 'no-such-expression', true);
    expect(manifest?.accessories).toBeUndefined();
  });

  it('returns null when no avatar is imported', async () => {
    expect(await setAvatarAccessory('char-none', 'x', true)).toBeNull();
  });
});

describe('parseRigSpec', () => {
  const valid = {
    version: 1,
    name: 'whale maid',
    canvas: [2048, 2048],
    layers: [
      { id: 'back', src: 'back.png', z: 0, group: 'head', physics: { k: 40, c: 7 } },
      { id: 'body', src: 'body.png', z: 1, sway: 0.15 },
      {
        id: 'eyes',
        z: 3,
        group: 'head',
        box: [524, 812, 1236, 1076],
        states: { open: 'eyes_open.png', closed: 'eyes_closed.png' },
      },
    ],
  };

  it('accepts a valid spec and preserves layer shape', () => {
    const spec = parseRigSpec(valid);
    expect(spec.canvas).toEqual([2048, 2048]);
    expect(spec.name).toBe('whale maid');
    expect(spec.layers).toHaveLength(3);
    expect(spec.layers[0].physics).toEqual({ k: 40, c: 7 });
    expect(spec.layers[2].states).toEqual({ open: 'eyes_open.png', closed: 'eyes_closed.png' });
    expect(spec.layers[2].box).toEqual([524, 812, 1236, 1076]);
  });

  it('rejects bad canvases, empty layers, and shape violations', () => {
    expect(() => parseRigSpec(null)).toThrow(/not an object/);
    expect(() => parseRigSpec({ ...valid, canvas: [0, 2048] })).toThrow(/canvas/);
    expect(() => parseRigSpec({ ...valid, layers: [] })).toThrow(/no layers/);
    expect(() =>
      parseRigSpec({ ...valid, layers: [{ id: 'a', z: 0 }] }),
    ).toThrow(/neither src nor states/);
    expect(() =>
      parseRigSpec({
        ...valid,
        layers: [{ id: 'a', z: 0, states: { open: 'o.png', closed: 'c.png' } }],
      }),
    ).toThrow(/box/);
    expect(() =>
      parseRigSpec({
        ...valid,
        layers: [valid.layers[0], { ...valid.layers[1], id: 'back' }],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseRigSpec({ ...valid, layers: [{ ...valid.layers[0], physics: { k: 0, c: 1 } }] }),
    ).toThrow(/physics/);
  });
});

describe('importAvatarZip (rig)', () => {
  function rigZip(opts?: { dropImage?: boolean }): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
      'rig.json',
      JSON.stringify({
        version: 1,
        name: 'whale maid',
        canvas: [2048, 2048],
        layers: [
          { id: 'back', src: 'back.png', z: 0, group: 'head', physics: { k: 40, c: 7 } },
          { id: 'body', src: 'body.png', z: 1, sway: 0.15 },
          {
            id: 'eyes',
            z: 3,
            group: 'head',
            box: [524, 812, 1236, 1076],
            states: { open: 'eyes_open.png', closed: 'eyes closed 图.png' },
          },
        ],
      }),
    );
    zip.file('back.png', png(1));
    zip.file('body.png', png(2));
    zip.file('eyes_open.png', png(3));
    if (!opts?.dropImage) zip.file('eyes closed 图.png', png(4));
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  it('imports a rig zip: kind flag, no expressions, refs rewritten ASCII-safe', async () => {
    const manifest = await importAvatarZip('char-rig', await rigZip());
    expect(manifest.kind).toBe('rig');
    expect(manifest.name).toBe('whale maid');
    expect(manifest.entry).toBe('rig.json');
    expect(manifest.expressions).toEqual([]);
    expect(manifest.emotions).toEqual({});

    const files = await readAvatarModelFiles('char-rig');
    for (const f of files) expect(encodeURI(f.path)).toBe(f.path);
    const byPath = new Set(files.map((f) => f.path));
    const spec = parseRigSpec(
      JSON.parse(Buffer.from(files.find((f) => f.path === 'rig.json')!.bytes).toString('utf8')),
    );
    for (const l of spec.layers) {
      if (l.src) expect(byPath.has(l.src)).toBe(true);
      if (l.states) {
        expect(byPath.has(l.states.open)).toBe(true);
        expect(byPath.has(l.states.closed)).toBe(true);
      }
    }
    // A rig manifest round-trips without triggering any heal.
    expect((await getAvatarManifest('char-rig'))?.kind).toBe('rig');
  });

  it('rejects a rig referencing a missing image, keeping any previous store', async () => {
    await importAvatarZip('char-rig2', await rigZip());
    await expect(importAvatarZip('char-rig2', await rigZip({ dropImage: true }))).rejects.toThrow(
      /missing image/,
    );
    expect((await getAvatarManifest('char-rig2'))?.kind).toBe('rig');
  });
});

describe.skipIf(!existsSync(REAL_RIG_ZIP))('importAvatarZip (real chibi-rig zip)', () => {
  it('imports the whale-maid rig end to end', async () => {
    const manifest = await importAvatarZip('chibi-test', await readFile(REAL_RIG_ZIP));
    expect(manifest.kind).toBe('rig');
    expect(manifest.name).toBe('whale maid');
    const files = await readAvatarModelFiles('chibi-test');
    const byPath = new Map(files.map((f) => [f.path, f.bytes]));
    const spec = parseRigSpec(
      JSON.parse(Buffer.from(byPath.get(manifest.entry)!).toString('utf8')),
    );
    expect(spec.canvas).toEqual([2048, 2048]);
    expect(spec.layers.filter((l) => l.states)).toHaveLength(2); // eyes + mouth
    expect(spec.layers.filter((l) => l.physics)).toHaveLength(2); // back + front hair
    for (const l of spec.layers) {
      if (l.src) expect(byPath.has(l.src)).toBe(true);
      if (l.states) {
        expect(byPath.has(l.states.open)).toBe(true);
        expect(byPath.has(l.states.closed)).toBe(true);
      }
    }
  }, 30_000);
});

/**
 * Rewrite the declared uncompressed size of `name` in both its local header
 * and its central directory entry (what a hand-made zip bomb does).
 */
function forgeSize(zip: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(zip);
  const n = Buffer.from(name);
  for (let i = 0; i + 46 <= out.length; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50 && out.readUInt16LE(i + 26) === n.length && out.subarray(i + 30, i + 30 + n.length).equals(n)) {
      out.writeUInt32LE(size, i + 22);
    }
    if (sig === 0x02014b50 && out.readUInt16LE(i + 28) === n.length && out.subarray(i + 46, i + 46 + n.length).equals(n)) {
      out.writeUInt32LE(size, i + 24);
    }
  }
  return out;
}

describe('importAvatarZip limits and image rules (261106)', () => {
  async function model(extra: Record<string, Buffer | string> = {}, textures = ['t.png']): Promise<JSZip> {
    const zip = new JSZip();
    zip.file('m.model3.json', JSON.stringify({ FileReferences: { Moc: 'm.moc3', Textures: textures } }));
    zip.file('m.moc3', Buffer.from([1]));
    zip.file('t.png', png(1));
    for (const [k, v] of Object.entries(extra)) zip.file(k, v);
    return zip;
  }

  it('stops inflating an entry that expands past its declared size (zip bomb)', async () => {
    const zip = await model({ 'pad.bin': Buffer.alloc(4 * 1024 * 1024) });
    const honest = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(honest.byteLength).toBeLessThan(64 * 1024);
    const bomb = forgeSize(honest, 'pad.bin', 1000);
    await expect(importAvatarZip('bomb', bomb)).rejects.toThrow(/declared size/);
    expect(await getAvatarManifest('bomb')).toBeNull();
    // an entry that inflates to fewer bytes than it declares is refused too
    // (JSZip's own end-of-entry size check may answer first; either way it is refused)
    await expect(importAvatarZip('short', forgeSize(honest, 'pad.bin', 4 * 1024 * 1024 + 7))).rejects.toThrow(/declared size|size mismatch/);
  });

  it('refuses declared sizes over the per-file or total cap before inflating anything', async () => {
    const zip = await model({ 'a.bin': 'x', 'b.bin': 'y', 'c.bin': 'z', 'd.bin': 'w', 'e.bin': 'v' });
    const raw = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await expect(importAvatarZip('big1', forgeSize(raw, 'a.bin', 65 * 1024 * 1024))).rejects.toThrow(/too large/);
    let many = raw;
    for (const n of ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin']) many = forgeSize(many, n, 60 * 1024 * 1024);
    await expect(importAvatarZip('big2', many)).rejects.toThrow(/expands too large/);
  });

  it('every texture must be a PNG, JPEG or WebP', async () => {
    const notImage = await (await model({ 'tex.dat': 'not an image' }, ['tex.dat'])).generateAsync({ type: 'nodebuffer' });
    await expect(importAvatarZip('tex1', notImage)).rejects.toThrow(/not a PNG, JPEG or WebP/);
    const gif = await (await model({ 'anim.png': Buffer.from('GIF89a\x01\x00\x01\x00') }, ['anim.png'])).generateAsync({ type: 'nodebuffer' });
    await expect(importAvatarZip('tex2', gif)).rejects.toThrow(/texture/);
    const jpeg = await (await model({ 'j.jpg': JPEG }, ['t.png', 'j.jpg'])).generateAsync({ type: 'nodebuffer' });
    expect((await importAvatarZip('tex3', jpeg)).entry).toBe('m.model3.json');
    const notList = new JSZip();
    notList.file('m.model3.json', JSON.stringify({ FileReferences: { Moc: 'm.moc3', Textures: 't.png' } }));
    notList.file('m.moc3', Buffer.from([1]));
    notList.file('t.png', png(1));
    await expect(importAvatarZip('tex4', await notList.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/Textures/);
  });

  it('every rig layer src and state must be a PNG, JPEG or WebP', async () => {
    const zip = new JSZip();
    zip.file('rig.json', JSON.stringify({ canvas: [10, 10], layers: [{ id: 'a', z: 0, src: 'a.bin' }] }));
    zip.file('a.bin', 'nope');
    await expect(importAvatarZip('rig-bad', await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/not a PNG, JPEG or WebP/);
  });

  it('leaves out images the library cannot moderate, so the stored model always uploads', async () => {
    const zip = await model({
      'preview.gif': Buffer.from('GIF89a\x01\x00\x01\x00'),
      'broken.png': 'not really',
      'hidden.bin': Buffer.from('GIF89a\x02\x00'),
      'notes.txt': 'kept',
    });
    await importAvatarZip('drop', await zip.generateAsync({ type: 'nodebuffer' }));
    const stored = new Set((await readAvatarModelFiles('drop')).map((f) => f.path));
    expect(stored.has('preview.gif') || stored.has('broken.png') || stored.has('hidden.bin')).toBe(false);
    expect(stored.has('notes.txt')).toBe(true);
    // the stable zip only holds what is stored
    const back = await JSZip.loadAsync((await zipStoredAvatar('drop'))!);
    expect(Object.keys(back.files).some((n) => /preview\.gif|broken\.png|hidden\.bin/.test(n))).toBe(false);
  });

  // Image rules on import (261106): what the library proxy refuses never gets stored.
  it('refuses a model whose texture is an APNG or larger than 8192 px, keeping any previous store', async () => {
    await importAvatarZip('anim', await syntheticZip());
    const apng = await (await model({ 'a.png': pngOf(4, 4, { actl: true }) }, ['a.png'])).generateAsync({ type: 'nodebuffer' });
    await expect(importAvatarZip('anim', apng)).rejects.toThrow(/animated/);
    const huge = await (await model({ 'h.png': pngOf(8193, 16) }, ['h.png'])).generateAsync({ type: 'nodebuffer' });
    await expect(importAvatarZip('anim', huge)).rejects.toThrow(/larger than 8192 px/);
    expect((await getAvatarManifest('anim'))?.entry).toBeTruthy();
    const edge = await (await model({ 'e.png': pngOf(8192, 16) }, ['e.png'])).generateAsync({ type: 'nodebuffer' });
    expect((await importAvatarZip('edge', edge)).entry).toBe('m.model3.json');
  });

  it('refuses an animated rig layer and drops unreferenced animated or oversized images', async () => {
    const rig = new JSZip();
    rig.file('rig.json', JSON.stringify({ canvas: [10, 10], layers: [{ id: 'a', z: 0, src: 'a.png' }] }));
    rig.file('a.png', pngOf(10, 10, { actl: true }));
    await expect(importAvatarZip('rig-anim', await rig.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/animated/);

    const zip = await model({ 'spare.png': pngOf(4, 4, { actl: true }), 'poster.png': pngOf(9000, 9000), 'ok.png': pngOf(3, 3) });
    await importAvatarZip('drop-anim', await zip.generateAsync({ type: 'nodebuffer' }));
    const stored = new Set((await readAvatarModelFiles('drop-anim')).map((f) => f.path));
    expect(stored.has('spare.png') || stored.has('poster.png')).toBe(false);
    expect(stored.has('ok.png')).toBe(true);
  });
});

describe('setAvatarLibraryLink (261106)', () => {
  it('links and unlinks the stored model', async () => {
    await importAvatarZip('link', await syntheticZip());
    const m = await setAvatarLibraryLink('link', { avatarId: 'a', rev: 'r1' });
    expect(m?.library).toEqual({ avatarId: 'a', rev: 'r1' });
    expect((await getAvatarManifest('link'))?.library).toEqual({ avatarId: 'a', rev: 'r1' });
    expect((await setAvatarLibraryLink('link', null))?.library).toBeUndefined();
    expect(await setAvatarLibraryLink('none', { avatarId: 'a', rev: 'r1' })).toBeNull();
  });

  it('reads the manifest inside the lock: a removal queued first is never undone', async () => {
    await importAvatarZip('race', await syntheticZip());
    const removal = removeAvatar('race');
    const link = setAvatarLibraryLink('race', { avatarId: 'a', rev: 'r1' });
    await removal;
    expect(await link).toBeNull();
    expect(await getAvatarManifest('race')).toBeNull();
  });

  it('an import that lands first is not overwritten with the old manifest', async () => {
    await importAvatarZip('race2', await syntheticZip());
    const other = new JSZip();
    other.file('rig.json', JSON.stringify({ name: 'second', canvas: [10, 10], layers: [{ id: 'a', z: 0, src: 'a.png' }] }));
    other.file('a.png', png(9));
    const bytes = await other.generateAsync({ type: 'nodebuffer' });
    const imp = importAvatarZip('race2', bytes);
    await new Promise((r) => setTimeout(r, 0));
    const link = setAvatarLibraryLink('race2', { avatarId: 'a', rev: 'r1' });
    await Promise.all([imp, link]);
    const m = await getAvatarManifest('race2');
    expect(m?.kind).toBe('rig');
    expect(m?.name).toBe('second');
  });
});
