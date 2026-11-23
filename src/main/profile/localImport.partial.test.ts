/**
 * Own-key import under partial failure and a scope change mid-import (review
 * of 261023). Every case here is a way the merge could lose or mislabel a
 * player's companion data even though each step on its own is idempotent:
 *
 *   - a crash between the world-registry merge and the MEMORY.md merge used to
 *     drop the local worlds.json first, so the re-run could not renumber the
 *     local `## World N` headers and filed them under the account's World N;
 *   - a scope change (sign-out) mid-companion re-pointed the target paths at
 *     the local profile itself, so "the account already has it" was true of
 *     the local file and the local skin, portrait and character JSON were
 *     deleted;
 *   - a knowledge entry moved before the manifest write was skipped on re-run
 *     and left invisible;
 *   - a World companion whose local copy had lost its owner stamp was claimed
 *     by the account, which the sign-in sweep then deletes as a leak.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    getSelectedStorageBackend: () => 'basic_text',
  },
}));

vi.mock('../cloud/syncQueue', () => ({
  enqueueUpsert: vi.fn(async () => {}),
  enqueueDelete: vi.fn(async () => {}),
  processNext: vi.fn(async () => {}),
  kickDrain: vi.fn(),
}));

vi.mock('../cloud/librarySync', () => ({
  syncLibraryRoster: vi.fn(async () => {}),
}));

// Test seam: run a hook after the knowledge merge of a companion (the last
// step before its assets and character JSON are handled).
const afterKnowledge: { fn: null | (() => void) } = { fn: null };
vi.mock('./memoryMerge', async (importOriginal) => {
  const real = await importOriginal<typeof import('./memoryMerge')>();
  return {
    ...real,
    mergeKnowledgeDir: async (src: string, dest: string) => {
      await real.mergeKnowledgeDir(src, dest);
      afterKnowledge.fn?.();
    },
  };
});

import { _setUserDataOverride, setActiveScope, profileRootFor } from '../paths';
import { importLocalProfileInto } from './localImport';
import { mergeKnowledgeDir } from './memoryMerge';

const ACCOUNT = '7a1f3c55-9b2e-4d1a-8c3f-0e5d6b7a8c9d';
const OTHER_AUTHOR = '3c9e2a71-5d4b-4f8e-9a6c-1b2d3e4f5a6b';
const OWN = '11111111-1111-4111-8111-111111111111';
const WORLD = '33333333-3333-4333-8333-333333333333';

let tmp: string;

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

function charObj(id: string, owner: string | null, kind = 'custom'): Record<string, unknown> {
  return {
    id,
    kind,
    name: `C-${id.slice(0, 4)}`,
    persona: { source: 'a companion', expanded: 'expanded text' },
    is_default: false,
    shared: kind === 'world',
    slug: null,
    metadata: {},
    created: '2026-01-01T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
    owner,
  };
}

const root = (scope: string): string => profileRootFor(scope);

async function seedChar(scope: string, id: string, owner: string | null, kind = 'custom'): Promise<void> {
  const r = root(scope);
  await mkdir(path.join(r, 'characters'), { recursive: true });
  await writeFile(path.join(r, 'characters', `${id}.json`), JSON.stringify(charObj(id, owner, kind)), 'utf8');
  const idx = path.join(r, 'characters', 'index.json');
  let order: string[] = [];
  try { order = JSON.parse(await readFile(idx, 'utf8')).order ?? []; } catch { /* fresh */ }
  if (!order.includes(id)) order.push(id);
  await writeFile(idx, JSON.stringify({ version: 1, order }), 'utf8');
}

async function seedFiles(dir: string, files: Record<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body, 'utf8');
}

const HEADER = '# Memory\n\nAppend-only record.\n\n';

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-import-partial-'));
  _setUserDataOverride(tmp);
  setActiveScope('local');
  afterKnowledge.fn = null;
});

afterEach(async () => {
  afterKnowledge.fn = null;
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('a crash between the world merge and the memory merge', () => {
  it('still renumbers the local world sections on the re-run', async () => {
    const acctMem = path.join(root(ACCOUNT), 'memory', OWN);
    await seedChar(ACCOUNT, OWN, ACCOUNT);
    await seedFiles(acctMem, {
      'worlds.json': JSON.stringify({ version: 1, worlds: [{ num: 1, fingerprint: 'fpA', label: 'Acct' }] }),
    });
    // Obstacle: MEMORY.md on the account side is a non-empty directory, so
    // the merged write fails after the world registry has been merged.
    await mkdir(path.join(acctMem, 'MEMORY.md'), { recursive: true });
    await writeFile(path.join(acctMem, 'MEMORY.md', 'x'), 'x', 'utf8');

    await seedChar('local', OWN, null);
    await seedFiles(path.join(root('local'), 'memory', OWN), {
      'MEMORY.md': HEADER + '## World 1 — Local Farm\n- [2026-09-01T10:00:00.000Z] farm fact\n',
      'worlds.json': JSON.stringify({ version: 1, worlds: [{ num: 1, fingerprint: 'fpLocal', label: 'Local Farm' }] }),
    });

    setActiveScope(ACCOUNT);
    const first = await importLocalProfileInto(ACCOUNT);
    expect(first.failed).toContain(OWN);

    // The obstacle is cleared (the disk-full is over); the account gets a real MEMORY.md.
    await rm(path.join(acctMem, 'MEMORY.md'), { recursive: true, force: true });
    await writeFile(
      path.join(acctMem, 'MEMORY.md'),
      HEADER + '## World 1 — Acct\n- [2026-10-01T10:00:00.000Z] acct fact\n',
      'utf8',
    );

    const second = await importLocalProfileInto(ACCOUNT);
    expect(second.failed).toEqual([]);
    const memory = await readFile(path.join(acctMem, 'MEMORY.md'), 'utf8');
    // The farm is world 2 in the account's registry, and its fact is filed there.
    expect(memory).toMatch(/## World 2 — Local Farm\n- \[2026-09-01T10:00:00.000Z\] farm fact/);
    expect(memory).not.toMatch(/## World 1 — Local Farm/);
  });
});

describe('the scope moves (sign-out) in the middle of a companion', () => {
  it('loses none of its files', async () => {
    await seedChar('local', OWN, null);
    await seedFiles(path.join(root('local'), 'memory', OWN), { 'MEMORY.md': HEADER + '- [2026-09-01T10:00:00.000Z] m\n' });
    await seedFiles(path.join(root('local'), 'skins'), { [`${OWN}.png`]: 'skin' });
    await seedFiles(path.join(root('local'), 'portraits'), { [`${OWN}.png`]: 'portrait' });

    afterKnowledge.fn = () => setActiveScope('local');
    setActiveScope(ACCOUNT);
    await importLocalProfileInto(ACCOUNT);

    const somewhere = async (rel: string): Promise<boolean> =>
      (await exists(path.join(root('local'), rel))) || (await exists(path.join(root(ACCOUNT), rel)));
    expect(await somewhere(path.join('characters', `${OWN}.json`))).toBe(true);
    expect(await somewhere(path.join('skins', `${OWN}.png`))).toBe(true);
    expect(await somewhere(path.join('portraits', `${OWN}.png`))).toBe(true);
    // Nothing of the account was written into the local profile.
    const localChar = path.join(root('local'), 'characters', `${OWN}.json`);
    if (await exists(localChar)) {
      expect(JSON.parse(await readFile(localChar, 'utf8')).owner).toBeNull();
    }
  });
});

describe('knowledge re-run after a crash mid-merge', () => {
  it('lists an entry whose file was already moved', async () => {
    const src = path.join(tmp, 'src-k');
    const dest = path.join(tmp, 'dest-k');
    const entry = { id: 'e2', title: 'Two', bytes: 3, created: '2026-01-01T00:00:00.000Z' };
    await seedFiles(src, { 'index.json': JSON.stringify({ version: 1, entries: [entry] }) });
    // e2.md already moved into the account, the manifest write never happened.
    await seedFiles(dest, {
      'index.json': JSON.stringify({ version: 1, entries: [{ id: 'e1', title: 'One' }] }),
      'e1.md': 'one',
      'e2.md': 'two',
    });
    await mergeKnowledgeDir(src, dest);
    const manifest = JSON.parse(await readFile(path.join(dest, 'index.json'), 'utf8'));
    expect(manifest.entries.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2']);
  });
});

describe('a World companion whose local copy lost its owner stamp', () => {
  it('is not claimed by the account and stays in the roster', async () => {
    await seedChar('local', WORLD, null, 'world');
    await mkdir(root('local'), { recursive: true });
    await writeFile(
      path.join(root('local'), 'config.json'),
      JSON.stringify({ preferred_name: 'Boss', added_world_ids: [WORLD] }),
      'utf8',
    );
    setActiveScope(ACCOUNT);
    await importLocalProfileInto(ACCOUNT);
    const w = JSON.parse(await readFile(path.join(root(ACCOUNT), 'characters', `${WORLD}.json`), 'utf8'));
    expect(w.owner).not.toBe(ACCOUNT);
    const cfg = JSON.parse(await readFile(path.join(root(ACCOUNT), 'config.json'), 'utf8'));
    expect(cfg.added_world_ids).toEqual([WORLD]);
    void OTHER_AUTHOR;
  });
});
