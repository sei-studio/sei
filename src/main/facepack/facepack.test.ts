/**
 * Facepack pilot dev flag + pack store (261028). The flag must be OFF in any
 * packaged build whatever the environment says, and the pack reader must
 * never leave the pack directory.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ packaged: true }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged;
    },
  },
}));

import { facepackDir, facepackBaseUrl, facesEnabled } from './facepackDev';
import { readPackFile, readPackManifest, listPacks, facepackDevInfo } from './facepackStore';
import { emitFaceCue, emitReplyFaces, setFaceCueSink } from './faceEvents';
import { isSafePackPath, type FaceCue } from '../../shared/facepack';

let root = '';
const envDir = process.env.SEI_FACEPACK_DIR;
const envUrl = process.env.SEI_FACEPACK_URL;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sei-facepack-'));
  await mkdir(path.join(root, 'sui', 'frames', 'neutral'), { recursive: true });
  await writeFile(
    path.join(root, 'sui', 'facepack.json'),
    JSON.stringify({
      format: 'sei-facepack',
      version: 1,
      character: 'Sui',
      canvas: [512, 768],
      poses: { c: 'c' },
      expressions: { neutral: { poses: { c: { base: 'frames/neutral/c.webp' } } } },
      bytes: 123,
      attribution: ['made with test'],
    }),
  );
  await writeFile(path.join(root, 'sui', 'frames', 'neutral', 'c.webp'), Buffer.from([1, 2, 3]));
  await writeFile(path.join(root, 'secret.json'), '{"no":1}');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  state.packaged = true;
  if (envDir === undefined) delete process.env.SEI_FACEPACK_DIR;
  else process.env.SEI_FACEPACK_DIR = envDir;
  if (envUrl === undefined) delete process.env.SEI_FACEPACK_URL;
  else process.env.SEI_FACEPACK_URL = envUrl;
  setFaceCueSink(null);
});

describe('dev flag', () => {
  it('is off in a packaged build even with SEI_FACEPACK_DIR set', async () => {
    state.packaged = true;
    process.env.SEI_FACEPACK_DIR = root;
    process.env.SEI_FACEPACK_URL = 'https://example.com/packs';
    expect(facepackDir()).toBeNull();
    expect(facepackBaseUrl()).toBeNull();
    expect(facesEnabled()).toBe(false);
    expect(await listPacks()).toEqual([]);
    expect(await readPackManifest('sui')).toBeNull();
    expect(await readPackFile('sui', 'frames/neutral/c.webp')).toBeNull();
    expect(await facepackDevInfo()).toEqual({ enabled: false, packs: [], baseUrl: null });
  });

  it('is off unpackaged without the variable', () => {
    state.packaged = false;
    delete process.env.SEI_FACEPACK_DIR;
    expect(facepackDir()).toBeNull();
    expect(facesEnabled()).toBe(false);
  });

  it('is on unpackaged with the variable', async () => {
    state.packaged = false;
    process.env.SEI_FACEPACK_DIR = root;
    process.env.SEI_FACEPACK_URL = 'https://example.com/packs';
    expect(facepackDir()).toBe(path.resolve(root));
    expect(facepackBaseUrl()).toBe('https://example.com/packs/');
    expect(facesEnabled()).toBe(true);
    const info = await facepackDevInfo();
    expect(info.enabled).toBe(true);
    expect(info.packs).toEqual([{ id: 'sui', character: 'Sui', bytes: 123, attribution: ['made with test'] }]);
  });

  it('rejects a non-http pack URL', () => {
    state.packaged = false;
    process.env.SEI_FACEPACK_URL = 'file:///etc/';
    expect(facepackBaseUrl()).toBeNull();
  });
});

describe('readPackFile', () => {
  it('reads a file inside the pack', async () => {
    state.packaged = false;
    process.env.SEI_FACEPACK_DIR = root;
    const bytes = await readPackFile('sui', 'frames/neutral/c.webp');
    expect(bytes && Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('never leaves the pack directory', async () => {
    state.packaged = false;
    process.env.SEI_FACEPACK_DIR = root;
    expect(await readPackFile('sui', '../secret.json')).toBeNull();
    expect(await readPackFile('sui', 'frames/../../secret.json')).toBeNull();
    expect(await readPackFile('sui', path.join(root, 'secret.json'))).toBeNull();
    expect(await readPackFile('..', 'secret.json')).toBeNull();
    expect(await readPackFile('sui/..', 'secret.json')).toBeNull();
    expect(await readPackFile('sui', 'frames/neutral/missing.webp')).toBeNull();
  });
});

describe('isSafePackPath', () => {
  it('accepts plain relative image and json paths', () => {
    expect(isSafePackPath('frames/neutral/c.webp')).toBe(true);
    expect(isSafePackPath('overlays/blush.png')).toBe(true);
    expect(isSafePackPath('facepack.json')).toBe(true);
  });
  it('rejects traversal, absolute, backslash, empty segments and other types', () => {
    for (const bad of ['../x.webp', 'a/../x.webp', '/etc/x.png', 'a\\b.webp', 'a//b.webp', './a.webp', 'a\0.webp', 'run.sh', '', 'a/' + 'x'.repeat(400) + '.webp']) {
      expect(isSafePackPath(bad), bad).toBe(false);
    }
  });
});

describe('face cue emission', () => {
  it('sends nothing while the flag is off', () => {
    const seen: FaceCue[] = [];
    setFaceCueSink((c) => seen.push(c));
    state.packaged = true;
    process.env.SEI_FACEPACK_DIR = root;
    emitFaceCue({ characterId: 'a', expression: 'happy', at: 'start', text: 'hi' });
    emitReplyFaces('a', { id: 'm', text: 'hi' }, { lead: 'happy', trail: 'smug' });
    expect(seen).toEqual([]);
  });

  it('sends lead and trail cues keyed to the bubble when on', () => {
    const seen: FaceCue[] = [];
    setFaceCueSink((c) => seen.push(c));
    state.packaged = false;
    process.env.SEI_FACEPACK_DIR = root;
    emitReplyFaces('a', { id: 'm1', text: 'hi there' }, { lead: 'happy', trail: 'smug' });
    emitReplyFaces('a', { id: 'm2', text: 'ok' }, null);
    expect(seen).toEqual([
      { characterId: 'a', expression: 'happy', at: 'start', text: 'hi there', messageId: 'm1' },
      { characterId: 'a', expression: 'smug', at: 'end', text: 'hi there', messageId: 'm1' },
    ]);
  });
});
