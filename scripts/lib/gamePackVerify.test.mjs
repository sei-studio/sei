// Tests for the pack-zip verification the builder runs on every zip it writes
// (260924). The fixture shapes mirror real release assets: the DST pack as the
// fixed builder writes it, and the 745-byte v0.6.5-beta.1 DST pack that held
// only pack.json and the empty node_modules placeholder.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { REQUIRED_PAYLOAD, treeHashOfEntries, verifyPackZip } from './gamePackVerify.mjs';
import { GAME_IDS, GAME_PACKS } from '../../src/shared/gamePacks';

const sha = (s) => createHash('sha256').update(s).digest('hex');

const DST_TREE = {
  'node_modules/.sei-pack-keep': '',
  'assets/dst-mod/sei/modinfo.lua': 'name = "Sei"\n',
  'assets/dst-mod/sei/modmain.lua': '-- main\n',
  'assets/dst-mod/sei/scripts/sei/net.lua': '-- net\n',
};

/** The staged tree's hash, computed the way the builder does. */
function stagedHash(tree) {
  return treeHashOfEntries(Object.entries(tree).map(([f, body]) => [f, sha(body)]));
}

/** Zip `zipped` with a pack.json describing `staged` (they differ when the zip drops files). */
async function zipOf(zipped, staged = zipped, game = 'dontstarve') {
  const { treeHash, files } = stagedHash(staged);
  const zip = new JSZip();
  zip.file('pack.json', JSON.stringify({ game, treeHash, files }));
  for (const [f, body] of Object.entries(zipped)) zip.file(f, body);
  return { buf: await zip.generateAsync({ type: 'nodebuffer' }), treeHash, files };
}

describe('verifyPackZip', () => {
  it('passes a zip that holds exactly the staged tree and the payload', async () => {
    const z = await zipOf(DST_TREE);
    expect(await verifyPackZip(z.buf, { game: 'dontstarve', treeHash: z.treeHash, files: z.files })).toEqual([]);
  });

  it('fails the v0.6.5-beta.1 DST shape: hashed with the mod, zipped without it', async () => {
    const z = await zipOf({ 'node_modules/.sei-pack-keep': '' }, DST_TREE);
    const problems = await verifyPackZip(z.buf, { game: 'dontstarve', treeHash: z.treeHash, files: z.files });
    expect(problems).toContain('zip holds 1 files, the staged tree had 4');
    expect(problems.some((p) => p.startsWith('treeHash of the zip contents differs'))).toBe(true);
    expect(problems).toContain('required payload missing from the zip: assets/dst-mod/sei/modinfo.lua');
    expect(problems).toContain('zip carries no payload (only pack.json and placeholders)');
  });

  it('fails a zip whose one changed file no longer matches the hash', async () => {
    const z = await zipOf({ ...DST_TREE, 'assets/dst-mod/sei/modmain.lua': '-- other\n' }, DST_TREE);
    const problems = await verifyPackZip(z.buf, { game: 'dontstarve', treeHash: z.treeHash, files: z.files });
    expect(problems).toEqual(['treeHash of the zip contents differs from the staged tree (the zip is missing or adding files)']);
  });

  it('fails a consistent zip that still lacks the required payload', async () => {
    const tree = { 'assets/dst-mod/sei/README.md': 'x' };
    const z = await zipOf(tree);
    const problems = await verifyPackZip(z.buf, { game: 'dontstarve', treeHash: z.treeHash, files: z.files });
    expect(problems).toEqual([
      'required payload missing from the zip: assets/dst-mod/sei/modinfo.lua',
      'required payload missing from the zip: assets/dst-mod/sei/modmain.lua',
    ]);
  });

  it('fails a zip with no pack.json', async () => {
    const zip = new JSZip();
    for (const [f, body] of Object.entries(DST_TREE)) zip.file(f, body);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const { treeHash, files } = stagedHash(DST_TREE);
    expect(await verifyPackZip(buf, { game: 'dontstarve', treeHash, files })).toContain('zip has no pack.json');
  });
});

describe('treeHashOfEntries', () => {
  it('ignores entry order and pack.json, and keeps the pre-260924 algorithm', () => {
    const a = treeHashOfEntries([['b', '2'], ['a', '1'], ['pack.json', 'z']]);
    const b = treeHashOfEntries([['a', '1'], ['b', '2']]);
    expect(a).toEqual(b);
    expect(a.files).toBe(2);
    // sha256 over "path\nsha\n" in sorted order: unchanged sources keep their
    // treeHash across this fix, so healthy installs still re-link.
    expect(a.treeHash).toBe(sha('a\n1\nb\n2\n'));
  });
});

describe('REQUIRED_PAYLOAD', () => {
  it('covers every game and equals the client copy in GAME_PACKS', () => {
    expect(Object.keys(REQUIRED_PAYLOAD).sort()).toEqual([...GAME_IDS].sort());
    for (const g of GAME_IDS) expect(REQUIRED_PAYLOAD[g]).toEqual([...GAME_PACKS[g].requiredPaths]);
  });
});
