/**
 * Sign-in reconcile sweep: the added_world_ids write and the account scope
 * (260929).
 *
 * The sweep awaits the cloud once per character. It used to write back the
 * added_world_ids snapshot it took at the start, which dropped any add made
 * while it waited; now it removes only its evictions, under the config lock,
 * in the profile it started in. It also stops when the account changes under
 * it, since every local delete resolves against the ACTIVE profile.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

type Char = { id: string; is_default: boolean; owner: string | null };
type CloudRow = { owner: string; shared: boolean } | null;

const state = vi.hoisted(() => ({
  chars: [] as Char[],
  cloud: new Map<string, () => Promise<CloudRow>>(),
}));

vi.mock('../characterStore', () => ({
  listCharacters: async () => state.chars,
  saveCharacterRaw: async () => {},
}));
vi.mock('./cloudCharacterClient', () => ({
  downloadCharacter: async (id: string) => (state.cloud.get(id) ?? (async () => null))(),
}));
vi.mock('./syncQueue', () => ({ dropOpsForUuid: async () => {} }));
vi.mock('./librarySync', () => ({ syncLibraryRoster: async () => {} }));

import { _setUserDataOverride, setActiveScope, paths } from '../paths';
import { loadConfig, updateConfig } from '../configStore';
import { reconcileLocalOwnershipOnSignIn } from './reconcileLocalOwnership';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const X = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const Y = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const Z = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN = '99999999-9999-4999-8999-999999999999';

async function writeCharFile(id: string): Promise<void> {
  await mkdir(paths.charactersDir(), { recursive: true });
  await writeFile(paths.characterPath(id), '{}');
}
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-reconcile-'));
  _setUserDataOverride(tmp);
  setActiveScope(USER_A);
  state.chars = [];
  state.cloud.clear();
});
afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  await rm(tmp, { recursive: true, force: true });
});

describe('reconcileLocalOwnershipOnSignIn', () => {
  it('removes only the evicted ids: an add made while the sweep waits survives', async () => {
    await updateConfig((cfg) => ({ ...cfg, added_world_ids: [X, Y] }));
    await writeCharFile(X);
    await writeCharFile(Y);
    state.chars = [
      { id: X, is_default: false, owner: FOREIGN },
      { id: Y, is_default: false, owner: FOREIGN },
    ];
    // X was unshared by its author. While the sweep waits on the cloud for
    // it, the user adds Z from the World tab.
    state.cloud.set(X, async () => {
      await updateConfig((cfg) => ({ ...cfg, added_world_ids: [...(cfg.added_world_ids ?? []), Z] }));
      return null;
    });
    state.cloud.set(Y, async () => ({ owner: FOREIGN, shared: true }));

    await reconcileLocalOwnershipOnSignIn(USER_A);

    expect((await loadConfig()).added_world_ids).toEqual([Y, Z]);
    expect(await exists(paths.characterPath(X))).toBe(false);
    expect(await exists(paths.characterPath(Y))).toBe(true);
  });

  it('stops when the account changes mid-sweep and never touches the next profile', async () => {
    await updateConfig((cfg) => ({ ...cfg, added_world_ids: [X] }));
    await writeCharFile(X);
    // B happens to hold a local copy of Y, a character B owns.
    setActiveScope(USER_B);
    await writeCharFile(Y);
    await updateConfig((cfg) => ({ ...cfg, added_world_ids: [X] }));
    setActiveScope(USER_A);

    state.chars = [
      { id: X, is_default: false, owner: FOREIGN },
      { id: Y, is_default: false, owner: USER_B },
    ];
    // The switch to B lands while the sweep waits on X's row.
    state.cloud.set(X, async () => {
      setActiveScope(USER_B);
      return null;
    });
    // Were the sweep to carry on in B, Y (not owned by A) would be deleted.
    state.cloud.set(Y, async () => ({ owner: USER_B, shared: false }));

    await reconcileLocalOwnershipOnSignIn(USER_A);

    // B: its file and its library are untouched.
    expect(await exists(paths.characterPath(Y))).toBe(true);
    expect((await loadConfig()).added_world_ids).toEqual([X]);
    // A: nothing was evicted before the switch, so A's list stands too.
    setActiveScope(USER_A);
    expect((await loadConfig()).added_world_ids).toEqual([X]);
    expect(await exists(paths.characterPath(X))).toBe(true);
  });
});
