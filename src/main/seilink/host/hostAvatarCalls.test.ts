import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { answerHostAvatarCall, hostPortrait, type HostAvatarStores } from './hostAvatarCalls';

const stores: HostAvatarStores = {
  avatarManifest: async (id) => ({ entry: `${id}.model3.json` }),
  avatarFiles: async () => [{ path: 'a.moc3', file: '/x/a.moc3' }],
  facepackFor: async (id) => (id === 'her' ? 'sui' : null),
  facepackManifest: async (id) => ({ id }),
  facepackFilePath: async (id, rel) => (rel === 'missing.webp' ? null : `/packs/${id}/${rel}`),
};

describe('answerHostAvatarCall', () => {
  it('answers for the moved-in character', async () => {
    await expect(answerHostAvatarCall('her', 'avatarGet', ['her'], stores)).resolves.toEqual({ entry: 'her.model3.json' });
    await expect(answerHostAvatarCall('her', 'avatarModelFiles', ['her'], stores)).resolves.toEqual([{ path: 'a.moc3', file: '/x/a.moc3' }]);
    await expect(answerHostAvatarCall('her', 'facepackForCharacter', ['her'], stores)).resolves.toBe('sui');
    await expect(answerHostAvatarCall('her', 'facepackManifest', ['sui'], stores)).resolves.toEqual({ id: 'sui' });
    await expect(answerHostAvatarCall('her', 'facepackFile', ['sui', 'eyes/open.webp'], stores)).resolves.toEqual({ file: '/packs/sui/eyes/open.webp' });
    await expect(answerHostAvatarCall('her', 'facepackFile', ['sui', 'missing.webp'], stores)).resolves.toBeNull();
  });

  it('tells nothing about anyone else or another face set', async () => {
    await expect(answerHostAvatarCall('her', 'avatarGet', ['other'], stores)).resolves.toBeNull();
    await expect(answerHostAvatarCall('her', 'avatarModelFiles', ['other'], stores)).resolves.toEqual([]);
    await expect(answerHostAvatarCall('her', 'facepackForCharacter', ['other'], stores)).resolves.toBeNull();
    await expect(answerHostAvatarCall('her', 'facepackManifest', ['lyra'], stores)).resolves.toBeNull();
    await expect(answerHostAvatarCall('her', 'facepackFile', ['lyra', 'a.webp'], stores)).resolves.toBeNull();
  });
});

describe('avatarShown (261105, analytics)', () => {
  it('records her shown kind only, and answers null', async () => {
    const seen: Array<[string, string]> = [];
    const s: HostAvatarStores = { ...stores, noteShown: (id, kind) => seen.push([id, kind]) };
    await expect(answerHostAvatarCall('her', 'avatarShown', ['her', 'facepack'], s)).resolves.toBeNull();
    await expect(answerHostAvatarCall('her', 'avatarShown', ['other', 'facepack'], s)).resolves.toBeNull();
    await expect(answerHostAvatarCall('her', 'avatarShown', ['her', 'bogus'], s)).resolves.toBeNull();
    expect(seen).toEqual([['her', 'facepack']]);
  });
});

describe('hostPortrait', () => {
  let dir = '';
  beforeAll(async () => {
    dir = realpathSync(await mkdtemp(path.join(tmpdir(), 'seilink-portrait-')));
    await writeFile(path.join(dir, 'abc-123.png'), 'png');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const at = (uuid: string): string => path.join(dir, `${uuid}.png`);

  it('passes URLs and bundled paths through', async () => {
    await expect(hostPortrait('https://x.test/p.png', at)).resolves.toEqual({ url: 'https://x.test/p.png', file: null });
    await expect(hostPortrait('./img/sui.png', at)).resolves.toEqual({ url: './img/sui.png', file: null });
    await expect(hostPortrait(null, at)).resolves.toEqual({ url: null, file: null });
    const data = 'data:image/png;base64,iVBOR';
    await expect(hostPortrait(data, at)).resolves.toEqual({ url: data, file: null });
  });

  it('drops every other scheme and path (no file:// SMB leak on Windows)', async () => {
    for (const ref of [
      'file://host/share/p.png',
      'file:///C:/Users/x/p.png',
      '\\\\host\\share\\p.png',
      '//host/share/p.png',
      'http://x.test/p.png',
      'sei-portrait://local/abc.png',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      './img/../../etc/passwd',
      '../img/sui.png',
      '/etc/passwd',
      'portraits/abc/def.png',
    ]) {
      await expect(hostPortrait(ref, at), ref).resolves.toEqual({ url: null, file: null });
    }
  });

  it('serves a stored portrait through sei-room://_portrait with a cache key', async () => {
    const p = await hostPortrait('abc-123.png', at);
    expect(p.file).toBe(path.join(dir, 'abc-123.png'));
    expect(p.url).toMatch(/^sei-room:\/\/_portrait\/abc-123\.png\?v=\d+$/);
  });

  it('gives nothing for a missing file or an odd ref', async () => {
    await expect(hostPortrait('nope.png', at)).resolves.toEqual({ url: null, file: null });
    await expect(hostPortrait('..%2Fsecret.png', at)).resolves.toEqual({ url: null, file: null });
    await expect(hostPortrait('a.jpg', at)).resolves.toEqual({ url: null, file: null });
  });
});
