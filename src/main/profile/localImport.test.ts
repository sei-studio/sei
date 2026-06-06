/**
 * Tests for the anonymous(local) → account on-device profile import (260603).
 *
 * Surface:
 *   - peekLocalProfile reports user-created characters + onboarding answers,
 *     excluding bundled defaults.
 *   - importLocalProfileInto MOVES user characters (+ memory/skins/portraits)
 *     into the active account profile, stamps owner, copies onboarding answers
 *     into an account that lacks them, leaves the local profile clean, and
 *     never moves bundled defaults.
 *   - Guards: refuses to import into 'local'; refuses when active scope != target.
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

// Keep saveCharacter's cloud-mirror enqueue out of this test (saveCharacterRaw
// doesn't enqueue, but configStore/characterStore drag the module in).
vi.mock('../cloud/syncQueue', () => ({
  enqueueUpsert: vi.fn(async () => {}),
  enqueueDelete: vi.fn(async () => {}),
  processNext: vi.fn(async () => {}),
}));

import { paths, _setUserDataOverride, setActiveScope, profileRootFor, getActiveScope } from '../paths';
import { peekLocalProfile, importLocalProfileInto } from './localImport';
import { DEFAULT_CHARACTER_UUIDS } from '../defaultCharacters';

const UUID_USER = '11111111-1111-4111-8111-111111111111';
const UUID_USER2 = '22222222-2222-4222-8222-222222222222';
const UUID_ACCOUNT = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';
const SUI = DEFAULT_CHARACTER_UUIDS.sui;

let tmp: string;

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

function charObj(id: string, isDefault = false): Record<string, unknown> {
  return {
    id,
    name: `C-${id.slice(0, 4)}`,
    persona: { source: 'a companion', expanded: 'expanded text' },
    is_default: isDefault,
    shared: false,
    slug: null,
    metadata: {},
    created: '2026-01-01T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
  };
}

/** Write a character into the LOCAL profile + append to the local index. */
async function seedLocalChar(id: string, opts: { isDefault?: boolean; withAssets?: boolean } = {}): Promise<void> {
  const root = profileRootFor('local');
  await mkdir(path.join(root, 'characters'), { recursive: true });
  await writeFile(path.join(root, 'characters', `${id}.json`), JSON.stringify(charObj(id, opts.isDefault), null, 2), 'utf8');
  const idxPath = path.join(root, 'characters', 'index.json');
  let order: string[] = [];
  try { order = JSON.parse(await readFile(idxPath, 'utf8')).order ?? []; } catch { /* fresh */ }
  if (!order.includes(id)) order.push(id);
  await writeFile(idxPath, JSON.stringify({ version: 1, order }, null, 2), 'utf8');
  if (opts.withAssets) {
    await mkdir(path.join(root, 'memory', id), { recursive: true });
    await writeFile(path.join(root, 'memory', id, 'MEMORY.md'), `# Memory ${id}\n`, 'utf8');
    await mkdir(path.join(root, 'skins'), { recursive: true });
    await writeFile(path.join(root, 'skins', `${id}.png`), Buffer.from([0x89, 0x50]));
    await mkdir(path.join(root, 'portraits'), { recursive: true });
    await writeFile(path.join(root, 'portraits', `${id}.png`), Buffer.from([0x89, 0x50]));
  }
}

async function seedLocalConfig(mc: string, pref: string): Promise<void> {
  const root = profileRootFor('local');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ mc_username: mc, preferred_name: pref }, null, 2), 'utf8');
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-import-test-'));
  _setUserDataOverride(tmp);
  setActiveScope('local');
});

afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('peekLocalProfile', () => {
  it('reports user-created characters + onboarding, excluding defaults', async () => {
    await seedLocalChar(UUID_USER);
    await seedLocalChar(UUID_USER2);
    await seedLocalChar(SUI, { isDefault: true });
    await seedLocalConfig('Steve', 'Boss');

    const peek = await peekLocalProfile();

    expect(peek.migratableCharacterIds.sort()).toEqual([UUID_USER, UUID_USER2].sort());
    expect(peek.migratableCharacterIds).not.toContain(SUI);
    expect(peek.mcUsername).toBe('Steve');
    expect(peek.preferredName).toBe('Boss');
    expect(peek.hasData).toBe(true);
  });

  it('hasData false on an empty local profile', async () => {
    const peek = await peekLocalProfile();
    expect(peek.hasData).toBe(false);
    expect(peek.migratableCharacterIds).toEqual([]);
  });
});

describe('importLocalProfileInto', () => {
  it('moves user characters + assets into the account, stamps owner, copies onboarding, leaves local clean', async () => {
    await seedLocalChar(UUID_USER, { withAssets: true });
    await seedLocalChar(SUI, { isDefault: true });
    await seedLocalConfig('Steve', 'Boss');

    // Caller switches scope to the account before importing.
    setActiveScope(UUID_ACCOUNT);
    const res = await importLocalProfileInto(UUID_ACCOUNT);

    expect(res.imported).toEqual([UUID_USER]);
    expect(res.failed).toEqual([]);
    expect(res.copiedOnboarding).toBe(true);

    // Character + assets now under the account profile (active scope helpers).
    expect(await exists(paths.characterPath(UUID_USER))).toBe(true);
    const moved = JSON.parse(await readFile(paths.characterPath(UUID_USER), 'utf8'));
    expect(moved.owner).toBe(UUID_ACCOUNT);
    expect(await exists(path.join(paths.memoryDir(UUID_USER), 'MEMORY.md'))).toBe(true);
    expect(await exists(paths.skinPngPath(UUID_USER))).toBe(true);
    expect(await exists(paths.portraitPath(UUID_USER))).toBe(true);
    // Account index lists the imported character.
    const acctIdx = JSON.parse(await readFile(paths.indexPath(), 'utf8'));
    expect(acctIdx.order).toContain(UUID_USER);
    // Onboarding answers copied into the account config.
    const acctCfg = JSON.parse(await readFile(paths.configPath(), 'utf8'));
    expect(acctCfg.mc_username).toBe('Steve');
    expect(acctCfg.preferred_name).toBe('Boss');

    // Local profile is left clean: user char gone, default untouched.
    const localRoot = profileRootFor('local');
    expect(await exists(path.join(localRoot, 'characters', `${UUID_USER}.json`))).toBe(false);
    expect(await exists(path.join(localRoot, 'characters', `${SUI}.json`))).toBe(true);
    const localIdx = JSON.parse(await readFile(path.join(localRoot, 'characters', 'index.json'), 'utf8'));
    expect(localIdx.order).not.toContain(UUID_USER);
    expect(localIdx.order).toContain(SUI);
  });

  it('does not overwrite onboarding answers the account already has', async () => {
    await seedLocalChar(UUID_USER);
    await seedLocalConfig('LocalName', 'LocalPref');
    setActiveScope(UUID_ACCOUNT);
    // Pre-existing account config with its own onboarding answers.
    await mkdir(paths.profileRoot(), { recursive: true });
    await writeFile(paths.configPath(), JSON.stringify({ mc_username: 'AcctName', preferred_name: 'AcctPref' }, null, 2), 'utf8');

    const res = await importLocalProfileInto(UUID_ACCOUNT);

    expect(res.copiedOnboarding).toBe(false);
    const acctCfg = JSON.parse(await readFile(paths.configPath(), 'utf8'));
    expect(acctCfg.mc_username).toBe('AcctName');
    expect(acctCfg.preferred_name).toBe('AcctPref');
  });

  it('refuses to import into the local scope', async () => {
    await expect(importLocalProfileInto('local')).rejects.toThrow();
  });

  it('refuses when the active scope is not the target', async () => {
    setActiveScope('local'); // active != target
    await expect(importLocalProfileInto(UUID_ACCOUNT)).rejects.toThrow();
    expect(getActiveScope()).toBe('local');
  });
});
