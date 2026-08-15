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
  MANIFEST_VERSION,
} from './avatarStore';

const REAL_ZIP = '/Users/ouen/Downloads/_雪熊企划_雪熊少女.zip';

let dir: string;

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
  zip.file('mymodel/tex/texture_00.png', Buffer.from([4, 5, 6]));
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
    await writeP(path.join(storeDir, '雪熊少女.4096', 'texture_00.png'), Buffer.from([2]));
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
