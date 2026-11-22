/**
 * Own-key (local) import vs the party limit (product call 261116): an import
 * that would put the account's party past MAX_COMPANION_SLOTS imports
 * nothing and leaves the local profile untouched, for a later import from
 * Settings once a slot is free.
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

// The roster mirror talks to Supabase; the import only needs to ask for it.
vi.mock('../cloud/librarySync', () => ({
  syncLibraryRoster: vi.fn(async () => {}),
}));

import { paths, _setUserDataOverride, setActiveScope, profileRootFor } from '../paths';
import { peekLocalProfile, importLocalProfileInto, partyFitFor } from './localImport';
import { DEFAULT_CHARACTER_UUIDS, DEFAULT_CHARACTERS_OWNER } from '../defaultCharacters';

const ACCOUNT = '7a1f3c55-9b2e-4d1a-8c3f-0e5d6b7a8c9d';
const OTHER_AUTHOR = '3c9e2a71-5d4b-4f8e-9a6c-1b2d3e4f5a6b';
const OWN = '11111111-1111-4111-8111-111111111111';
const OWN2 = '22222222-2222-4222-8222-222222222222';
const WORLD = '33333333-3333-4333-8333-333333333333';
const A1 = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const A2 = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const A3 = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const SUI = DEFAULT_CHARACTER_UUIDS.sui;

let tmp: string;

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

interface CharOpts {
  name?: string;
  owner?: string | null;
  kind?: 'custom' | 'unique' | 'world';
  shared?: boolean;
}

function charObj(id: string, o: CharOpts = {}): Record<string, unknown> {
  return {
    id,
    kind: o.kind ?? 'custom',
    name: o.name ?? `C-${id.slice(0, 4)}`,
    persona: { source: 'a companion', expanded: 'expanded text' },
    is_default: false,
    shared: o.shared ?? false,
    slug: null,
    metadata: {},
    created: '2026-01-01T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
    owner: o.owner ?? null,
  };
}

function rootOf(scope: string): string { return profileRootFor(scope); }

async function seedChar(scope: string, id: string, o: CharOpts = {}): Promise<void> {
  const root = rootOf(scope);
  await mkdir(path.join(root, 'characters'), { recursive: true });
  await writeFile(path.join(root, 'characters', `${id}.json`), JSON.stringify(charObj(id, o), null, 2), 'utf8');
  const idxPath = path.join(root, 'characters', 'index.json');
  let order: string[] = [];
  try { order = JSON.parse(await readFile(idxPath, 'utf8')).order ?? []; } catch { /* fresh */ }
  if (!order.includes(id)) order.push(id);
  await writeFile(idxPath, JSON.stringify({ version: 1, order }, null, 2), 'utf8');
  await mkdir(path.join(root, 'memory', id), { recursive: true });
}

async function seedMemory(scope: string, id: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(rootOf(scope), 'memory', id);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body, 'utf8');
}

async function seedConfig(scope: string, cfg: Record<string, unknown>): Promise<void> {
  const root = rootOf(scope);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

async function readCfg(scope: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(rootOf(scope), 'config.json'), 'utf8'));
}

const HEADER = '# Memory\n\nAppend-only record. One line per entry. Written via remember(); removed via forget().\n\n';

function mem(...lines: string[]): string {
  return HEADER + lines.join('\n') + '\n';
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-import-party-'));
  _setUserDataOverride(tmp);
  setActiveScope('local');
});

afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

async function listDir(p: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try { return (await readdir(p)).sort(); } catch { return []; }
}

/** Every file under the local profile, with its contents, to prove nothing moved. */
async function snapshotLocal(): Promise<Record<string, string>> {
  const { readdir } = await import('node:fs/promises');
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out[path.relative(rootOf('local'), p)] = await readFile(p, 'utf8');
    }
  }
  await walk(rootOf('local'));
  return out;
}

describe('partyFitFor (pure)', () => {
  const own = (id: string) => ({ id, is_default: false, owner: ACCOUNT });
  it('fits when the party has room for every incoming companion', () => {
    expect(partyFitFor([own(A1), own(A2)], {}, ACCOUNT, [OWN, OWN2])).toEqual({ count: 2, incoming: 2, limit: 4, fits: true });
  });
  it('does not fit when the import would go past the limit', () => {
    expect(partyFitFor([own(A1), own(A2), own(A3)], {}, ACCOUNT, [OWN, OWN2])).toMatchObject({ count: 3, incoming: 2, fits: false });
  });
  it('a companion the party already holds takes no new slot', () => {
    expect(partyFitFor([own(A1), own(A2), own(A3), own(OWN)], {}, ACCOUNT, [OWN])).toMatchObject({ count: 4, incoming: 0, fits: true });
  });
  it('counts only real party members: a cached World row outside the roster is not one', () => {
    const cached = { id: WORLD, is_default: false, owner: OTHER_AUTHOR };
    expect(partyFitFor([own(A1), own(A2), own(A3), cached], {}, ACCOUNT, [OWN])).toMatchObject({ count: 3, fits: true });
    expect(
      partyFitFor([own(A1), own(A2), own(A3), cached], { added_world_ids: [WORLD] }, ACCOUNT, [OWN]),
    ).toMatchObject({ count: 4, fits: false });
  });
});

describe('importing past the party limit (261116)', () => {
  async function seedFullishAccount(n: number): Promise<void> {
    for (const id of [A1, A2, A3].slice(0, n)) await seedChar(ACCOUNT, id, { owner: ACCOUNT });
    await seedConfig(ACCOUNT, { mc_username: '', preferred_name: 'Acct' });
  }
  async function seedLocal(): Promise<void> {
    await seedChar('local', OWN, { name: 'Mira' });
    await seedChar('local', OWN2, { name: 'Bo' });
    await seedMemory('local', OWN, { 'MEMORY.md': mem('- likes caves') });
    await seedConfig('local', { mc_username: 'steve', preferred_name: 'Steve' });
  }

  it('imports nothing and leaves the local profile exactly as it was', async () => {
    await seedFullishAccount(3);
    await seedLocal();
    const before = await snapshotLocal();
    setActiveScope(ACCOUNT);
    const res = await importLocalProfileInto(ACCOUNT);
    expect(res).toEqual({ imported: [], failed: [], copiedOnboarding: false, skipped: 'party_full' });
    expect(await snapshotLocal()).toEqual(before);
    // The account is untouched too: no new characters, no roster change.
    expect(await listDir(path.join(rootOf(ACCOUNT), 'characters'))).toEqual(
      [`${A1}.json`, `${A2}.json`, `${A3}.json`, 'index.json'].sort(),
    );
    expect(await exists(path.join(rootOf(ACCOUNT), 'memory', OWN))).toBe(false);
    expect((await readCfg(ACCOUNT)).preferred_name).toBe('Acct');
  });

  it('peek reports the fit, and an import that fits still goes through', async () => {
    await seedFullishAccount(2);
    await seedLocal();
    setActiveScope(ACCOUNT);
    const peek = await peekLocalProfile();
    expect(peek.migratableCharacterIds.sort()).toEqual([OWN, OWN2].sort());
    const res = await importLocalProfileInto(ACCOUNT);
    expect(res.skipped).toBeUndefined();
    expect(res.imported.sort()).toEqual([OWN, OWN2].sort());
    expect(await exists(path.join(rootOf(ACCOUNT), 'characters', `${OWN}.json`))).toBe(true);
  });

  it('a subset that fits imports even when the whole roster would not', async () => {
    await seedFullishAccount(3);
    await seedLocal();
    setActiveScope(ACCOUNT);
    const res = await importLocalProfileInto(ACCOUNT, { characterIds: [OWN] });
    expect(res.skipped).toBeUndefined();
    expect(res.imported).toEqual([OWN]);
    // The one left behind is still on disk in the local profile.
    expect(await exists(path.join(rootOf('local'), 'characters', `${OWN2}.json`))).toBe(true);
  });
});




