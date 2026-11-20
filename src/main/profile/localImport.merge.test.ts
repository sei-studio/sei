/**
 * Own-key (local) profile -> Sei account import, the cases the first version
 * missed (261023):
 *
 *   1. An EXISTING account. The import used to assume an empty target: a
 *      companion already in the account was overwritten by the local copy,
 *      and its local memories were left behind in the local profile (the dir
 *      move is skipped when the target dir exists) and then orphaned.
 *   2. Sui, Lyra and Marv (the former defaults) were never offered, so their
 *      local memories stayed in the local profile while the account used its
 *      own copy: two copies of the same companion.
 *   3. A World character (someone else's public companion added to the local
 *      roster) was stamped with the signing-in user as owner and lost its
 *      roster membership, so the next sign-in sweep deleted it as a leak.
 *
 * Plus: the merge never overwrites account data and running it twice changes
 * nothing.
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
import { peekLocalProfile, importLocalProfileInto } from './localImport';
import { DEFAULT_CHARACTER_UUIDS, DEFAULT_CHARACTERS_OWNER } from '../defaultCharacters';

const ACCOUNT = '7a1f3c55-9b2e-4d1a-8c3f-0e5d6b7a8c9d';
const OTHER_AUTHOR = '3c9e2a71-5d4b-4f8e-9a6c-1b2d3e4f5a6b';
const OWN = '11111111-1111-4111-8111-111111111111';
const OWN2 = '22222222-2222-4222-8222-222222222222';
const WORLD = '33333333-3333-4333-8333-333333333333';
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

async function readMem(scope: string, id: string, name = 'MEMORY.md'): Promise<string> {
  return readFile(path.join(rootOf(scope), 'memory', id, name), 'utf8');
}

const HEADER = '# Memory\n\nAppend-only record. One line per entry. Written via remember(); removed via forget().\n\n';

function mem(...lines: string[]): string {
  return HEADER + lines.join('\n') + '\n';
}

function chatRow(ts: number, text: string): string {
  return JSON.stringify({ role: 'user', text, ts });
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-import-merge-'));
  _setUserDataOverride(tmp);
  setActiveScope('local');
});

afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('bug 1: importing into an existing account', () => {
  it('merges memories into the account copy of the same companion and never overwrites it', async () => {
    // The account already has this companion (same id), with its own memories.
    await seedChar(ACCOUNT, OWN, { name: 'Account Name', owner: ACCOUNT });
    await seedMemory(ACCOUNT, OWN, {
      'MEMORY.md': mem('- [2026-10-01T10:00:00.000Z] account memory'),
      'chat.jsonl': chatRow(2000, 'account hi') + '\n',
      'bridge.json': '{"from":"account"}\n',
    });
    await seedConfig(ACCOUNT, { preferred_name: 'AcctPref' });
    // The local copy has different memories.
    await seedChar('local', OWN, { name: 'Local Name' });
    await seedMemory('local', OWN, {
      'MEMORY.md': mem('- [2026-09-01T10:00:00.000Z] local memory'),
      'chat.jsonl': chatRow(1000, 'local hi') + '\n' + chatRow(3000, 'local later') + '\n',
      'bridge.json': '{"from":"local"}\n',
    });

    setActiveScope(ACCOUNT);
    const res = await importLocalProfileInto(ACCOUNT);
    expect(res.failed).toEqual([]);
    expect(res.imported).toContain(OWN);

    // The account's character JSON is untouched.
    const acct = JSON.parse(await readFile(paths.characterPath(OWN), 'utf8'));
    expect(acct.name).toBe('Account Name');
    // Both sets of memories, in one place.
    const memory = await readMem(ACCOUNT, OWN);
    expect(memory).toContain('account memory');
    expect(memory).toContain('local memory');
    // Transcript is the union, in time order.
    const rows = (await readMem(ACCOUNT, OWN, 'chat.jsonl')).trim().split('\n').map((l) => JSON.parse(l).text);
    expect(rows).toEqual(['local hi', 'account hi', 'local later']);
    // Derived state the account already has is kept as is.
    expect(await readMem(ACCOUNT, OWN, 'bridge.json')).toContain('account');
    // Nothing of this companion is left behind in the local profile.
    expect(await exists(path.join(rootOf('local'), 'memory', OWN))).toBe(false);
    expect(await exists(path.join(rootOf('local'), 'characters', `${OWN}.json`))).toBe(false);
    // The account's onboarding answers are not replaced.
    expect((await readCfg(ACCOUNT)).preferred_name).toBe('AcctPref');
  });

  it('adds new local companions next to the account ones', async () => {
    await seedChar(ACCOUNT, OWN, { owner: ACCOUNT });
    await seedConfig(ACCOUNT, { preferred_name: 'AcctPref' });
    await seedChar('local', OWN2);
    await seedMemory('local', OWN2, { 'MEMORY.md': mem('- [2026-09-01T10:00:00.000Z] new one') });

    setActiveScope(ACCOUNT);
    await importLocalProfileInto(ACCOUNT);

    const idx = JSON.parse(await readFile(paths.indexPath(), 'utf8'));
    expect(idx.order).toEqual(expect.arrayContaining([OWN, OWN2]));
    expect(JSON.parse(await readFile(paths.characterPath(OWN2), 'utf8')).owner).toBe(ACCOUNT);
    expect(await readMem(ACCOUNT, OWN2)).toContain('new one');
  });
});

describe('bug 2: default companions (Sui)', () => {
  async function seedLocalSui(): Promise<void> {
    await seedChar('local', SUI, { name: 'Sui', owner: DEFAULT_CHARACTERS_OWNER, shared: true });
    await seedMemory('local', SUI, {
      'MEMORY.md': mem('- [2026-09-02T10:00:00.000Z] local sui memory'),
      'chat.jsonl': chatRow(1000, 'hi sui') + '\n',
    });
    await seedConfig('local', { preferred_name: 'Boss', added_world_ids: [SUI] });
  }

  it('peek offers Sui when the local profile has her in the roster', async () => {
    await seedLocalSui();
    const peek = await peekLocalProfile();
    expect(peek.migratableCharacterIds).toContain(SUI);
    expect(peek.hasData).toBe(true);
  });

  it('merges local Sui memories into the account copy of Sui (one copy, not two)', async () => {
    await seedLocalSui();
    await seedChar(ACCOUNT, SUI, { name: 'Sui (cloud)', owner: DEFAULT_CHARACTERS_OWNER, shared: true });
    await seedMemory(ACCOUNT, SUI, { 'MEMORY.md': mem('- [2026-10-02T10:00:00.000Z] account sui memory') });
    await seedConfig(ACCOUNT, { preferred_name: 'AcctPref', added_world_ids: [SUI] });

    setActiveScope(ACCOUNT);
    const res = await importLocalProfileInto(ACCOUNT);
    expect(res.imported).toContain(SUI);

    const memory = await readMem(ACCOUNT, SUI);
    expect(memory).toContain('account sui memory');
    expect(memory).toContain('local sui memory');
    // The account's copy of Sui is kept, owner unchanged.
    const sui = JSON.parse(await readFile(paths.characterPath(SUI), 'utf8'));
    expect(sui.name).toBe('Sui (cloud)');
    expect(sui.owner).toBe(DEFAULT_CHARACTERS_OWNER);
    // Still listed once in the roster.
    expect((await readCfg(ACCOUNT)).added_world_ids).toEqual([SUI]);
    expect(await exists(path.join(rootOf('local'), 'memory', SUI))).toBe(false);
  });

  it('brings Sui into an account that does not have her yet, keeping her real owner', async () => {
    await seedLocalSui();
    setActiveScope(ACCOUNT);
    await importLocalProfileInto(ACCOUNT);

    const sui = JSON.parse(await readFile(paths.characterPath(SUI), 'utf8'));
    expect(sui.owner).toBe(DEFAULT_CHARACTERS_OWNER);
    expect((await readCfg(ACCOUNT)).added_world_ids).toEqual([SUI]);
    expect(await readMem(ACCOUNT, SUI)).toContain('local sui memory');
    expect(((await readCfg('local')).added_world_ids as string[]) ?? []).not.toContain(SUI);
  });
});

describe('bug 3: World companions keep their author', () => {
  it('imports a World companion without claiming it, and keeps it in the roster', async () => {
    await seedChar('local', WORLD, { name: 'Eris', owner: OTHER_AUTHOR, kind: 'world', shared: true });
    await seedMemory('local', WORLD, { 'MEMORY.md': mem('- [2026-09-03T10:00:00.000Z] world memory') });
    await seedConfig('local', { preferred_name: 'Boss', added_world_ids: [WORLD] });

    setActiveScope(ACCOUNT);
    const res = await importLocalProfileInto(ACCOUNT);
    expect(res.imported).toContain(WORLD);

    const w = JSON.parse(await readFile(paths.characterPath(WORLD), 'utf8'));
    expect(w.owner).toBe(OTHER_AUTHOR);
    expect((await readCfg(ACCOUNT)).added_world_ids).toEqual([WORLD]);
    expect(await readMem(ACCOUNT, WORLD)).toContain('world memory');
  });

  it('own companions made without an account still become the account owner', async () => {
    await seedChar('local', OWN);
    setActiveScope(ACCOUNT);
    await importLocalProfileInto(ACCOUNT);
    expect(JSON.parse(await readFile(paths.characterPath(OWN), 'utf8')).owner).toBe(ACCOUNT);
  });

  it('does not offer a merely cached World companion with no memories', async () => {
    await seedChar('local', WORLD, { owner: OTHER_AUTHOR, kind: 'world', shared: true });
    const peek = await peekLocalProfile();
    expect(peek.migratableCharacterIds).not.toContain(WORLD);
    expect(peek.memoryOnlyCharacterIds).not.toContain(WORLD);
  });
});

describe('world numbering across the two copies', () => {
  it('renumbers local world sections so they do not collide with the account worlds', async () => {
    await seedChar(ACCOUNT, OWN, { owner: ACCOUNT });
    await seedMemory(ACCOUNT, OWN, {
      'MEMORY.md': mem('## World 1 — Acct Base (Minecraft)', '- [2026-10-01T10:00:00.000Z] acct world fact'),
      'worlds.json': JSON.stringify({ version: 1, worlds: [{ num: 1, fingerprint: 'fpA', label: 'Acct Base' }] }),
    });
    await seedChar('local', OWN);
    await seedMemory('local', OWN, {
      'MEMORY.md': mem(
        '## World 1 — Local Farm (Minecraft)',
        '- [2026-09-01T10:00:00.000Z] local world fact',
        '## World 2 — Shared Base (Minecraft)',
        '- [2026-09-01T11:00:00.000Z] shared world fact',
      ),
      'worlds.json': JSON.stringify({
        version: 1,
        worlds: [
          { num: 1, fingerprint: 'fpLocal', label: 'Local Farm' },
          { num: 2, fingerprint: 'fpA', label: 'Shared Base' },
        ],
      }),
    });

    setActiveScope(ACCOUNT);
    await importLocalProfileInto(ACCOUNT);

    const reg = JSON.parse(await readMem(ACCOUNT, OWN, 'worlds.json'));
    const byFp = Object.fromEntries(reg.worlds.map((w: { fingerprint: string; num: number }) => [w.fingerprint, w.num]));
    expect(byFp).toEqual({ fpA: 1, fpLocal: 2 });
    const memory = await readMem(ACCOUNT, OWN);
    // Local World 1 is a new world here: World 2. Local World 2 is the account's World 1.
    expect(memory).toMatch(/## World 2 — Local Farm \(Minecraft\)\n- \[2026-09-01T10:00:00.000Z\] local world fact/);
    expect(memory).toMatch(/## World 1 — Shared Base \(Minecraft\)\n- \[2026-09-01T11:00:00.000Z\] shared world fact/);
  });
});

describe('idempotent', () => {
  it('a second run (and a re-run over leftovers) duplicates nothing', async () => {
    await seedChar(ACCOUNT, SUI, { owner: DEFAULT_CHARACTERS_OWNER, shared: true });
    await seedMemory(ACCOUNT, SUI, { 'MEMORY.md': mem('- [2026-10-02T10:00:00.000Z] account sui memory') });
    await seedConfig(ACCOUNT, { preferred_name: 'AcctPref', added_world_ids: [SUI] });
    const localSui = async (): Promise<void> => {
      await seedChar('local', SUI, { owner: DEFAULT_CHARACTERS_OWNER, shared: true });
      await seedMemory('local', SUI, {
        'MEMORY.md': mem('- [2026-09-02T10:00:00.000Z] local sui memory'),
        'chat.jsonl': chatRow(1000, 'hi sui') + '\n',
      });
      await seedConfig('local', { preferred_name: 'Boss', added_world_ids: [SUI] });
    };
    await localSui();

    setActiveScope(ACCOUNT);
    await importLocalProfileInto(ACCOUNT);
    const afterFirst = {
      mem: await readMem(ACCOUNT, SUI),
      chat: await readMem(ACCOUNT, SUI, 'chat.jsonl'),
      cfg: await readCfg(ACCOUNT),
    };

    // Second run: nothing left to import.
    const second = await importLocalProfileInto(ACCOUNT);
    expect(second.imported).toEqual([]);
    expect((await peekLocalProfile()).hasData).toBe(false);

    // A re-run over the same leftovers (a crash after the merge, before the
    // local copy was cleared) adds nothing either.
    await localSui();
    await importLocalProfileInto(ACCOUNT);
    const memory = await readMem(ACCOUNT, SUI);
    expect(memory).toBe(afterFirst.mem);
    expect(countOf(memory, 'local sui memory')).toBe(1);
    expect(await readMem(ACCOUNT, SUI, 'chat.jsonl')).toBe(afterFirst.chat);
    expect((await readCfg(ACCOUNT)).added_world_ids).toEqual(afterFirst.cfg.added_world_ids);
  });
});
