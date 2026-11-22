/**
 * 261023 boot offer, main side: which local leftovers earn a prompt, and the
 * device-global "already offered" record.
 *
 * The first-run scene seeds Sui into the party, so almost every own-key
 * install has her in the local profile. Untouched (no memory entry, no
 * transcript row of the player's), she alone must not prompt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
}));

import { _setUserDataOverride, setActiveScope, profileRootFor, paths } from '../paths';
import { peekLocalProfile } from './localImport';
import { wasLocalImportOffered, markLocalImportOffered } from './localImportOffered';
import { DEFAULT_CHARACTER_UUIDS, DEFAULT_CHARACTERS_OWNER } from '../defaultCharacters';

const SUI = DEFAULT_CHARACTER_UUIDS.sui;
const OWN = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '7a1f3c55-9b2e-4d1a-8c3f-0e5d6b7a8c9d';
const ACCOUNT2 = '3c9e2a71-5d4b-4f8e-9a6c-1b2d3e4f5a6b';
const HEADER = '# Memory\n\nAppend-only record. One line per entry. Written via remember(); removed via forget().\n\n';

let tmp: string;

function charObj(id: string, owner: string | null): Record<string, unknown> {
  return {
    id,
    kind: 'custom',
    name: `C-${id.slice(0, 4)}`,
    persona: { source: 'a companion', expanded: 'expanded text' },
    is_default: false,
    shared: owner != null,
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

async function seedLocal(ids: Array<[string, string | null]>, addedWorld: string[]): Promise<void> {
  const root = profileRootFor('local');
  await mkdir(path.join(root, 'characters'), { recursive: true });
  for (const [id, owner] of ids) {
    await writeFile(path.join(root, 'characters', `${id}.json`), JSON.stringify(charObj(id, owner)), 'utf8');
    await mkdir(path.join(root, 'memory', id), { recursive: true });
  }
  await writeFile(
    path.join(root, 'characters', 'index.json'),
    JSON.stringify({ version: 1, order: ids.map(([id]) => id) }),
    'utf8',
  );
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ preferred_name: 'Boss', added_world_ids: addedWorld }), 'utf8');
}

async function seedMemory(id: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(profileRootFor('local'), 'memory', id);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body, 'utf8');
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-import-boot-'));
  _setUserDataOverride(tmp);
  setActiveScope('local');
});

afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('peekLocalProfile: the untouched seeded Sui', () => {
  it('flags Sui with no memory and only her own greeting as untouched', async () => {
    await seedLocal([[SUI, DEFAULT_CHARACTERS_OWNER]], [SUI]);
    await seedMemory(SUI, {
      'MEMORY.md': HEADER + '## World 1 â€” Base (Minecraft)\n',
      'chat.jsonl': JSON.stringify({ id: 'g', role: 'assistant', text: 'hi!', ts: 1 }) + '\n',
      'PLAYER.md': '# Player\n\nname: Boss\n',
    });
    const peek = await peekLocalProfile();
    expect(peek.migratableCharacterIds).toEqual([SUI]);
    expect(peek.untouchedSeedIds).toEqual([SUI]);
  });

  it('counts Sui as touched once the player wrote to her', async () => {
    await seedLocal([[SUI, DEFAULT_CHARACTERS_OWNER]], [SUI]);
    await seedMemory(SUI, { 'chat.jsonl': JSON.stringify({ id: 'u', role: 'user', text: 'yo', ts: 2 }) + '\n' });
    expect((await peekLocalProfile()).untouchedSeedIds).toEqual([]);
  });

  it('counts Sui as touched when she has a memory entry', async () => {
    await seedLocal([[SUI, DEFAULT_CHARACTERS_OWNER]], [SUI]);
    await seedMemory(SUI, { 'MEMORY.md': HEADER + '- [2026-10-01T00:00:00.000Z] Boss likes boats\n' });
    expect((await peekLocalProfile()).untouchedSeedIds).toEqual([]);
  });

  it('never flags the player\'s own companions, even empty ones', async () => {
    await seedLocal([[SUI, DEFAULT_CHARACTERS_OWNER], [OWN, null]], [SUI]);
    const peek = await peekLocalProfile();
    expect(peek.migratableCharacterIds).toEqual([SUI, OWN]);
    expect(peek.untouchedSeedIds).toEqual([SUI]);
  });
});

describe('localImportOffered (device-global, per account)', () => {
  it('records per account and survives a scope change', async () => {
    expect(await wasLocalImportOffered(ACCOUNT)).toBe(false);
    await markLocalImportOffered(ACCOUNT);
    setActiveScope(ACCOUNT2);
    expect(await wasLocalImportOffered(ACCOUNT)).toBe(true);
    expect(await wasLocalImportOffered(ACCOUNT2)).toBe(false);
    // Lives in the device tier, not under any profile.
    expect(path.dirname(paths.localImportOfferedPath())).toBe(tmp);
    const file = JSON.parse(await readFile(paths.localImportOfferedPath(), 'utf8'));
    expect(Object.keys(file.accounts)).toEqual([ACCOUNT]);
  });

  it('treats signed-out as already offered and records nothing for it', async () => {
    expect(await wasLocalImportOffered('local')).toBe(true);
    await markLocalImportOffered('local');
    expect(await wasLocalImportOffered(ACCOUNT)).toBe(false);
  });
});




