/**
 * 261017 (issue #46, review round 2): an undecryptable ChatGPT vault is moved
 * aside to a .bak before the session treats it as empty, so the next save
 * (a fresh sign-in) never overwrites the only copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const crypto = { broken: false, available: true, denied: false };
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => crypto.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (crypto.denied) throw new Error('Keychain access denied');
      if (crypto.broken || !s.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return s.slice(4);
    },
  },
}));

import { _setUserDataOverride, paths, setActiveScope } from '../paths';
import { _resetVaultLocks, electronVault } from './store';
import { emptyVault } from './session';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-chatgpt-vault-test-'));
  _setUserDataOverride(tmp);
  crypto.broken = false;
  crypto.available = true;
  crypto.denied = false;
  _resetVaultLocks();
});

afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('electronVault', () => {
  it('round-trips a saved vault', async () => {
    const d = { ...emptyVault(), welcomeSeen: true };
    await electronVault.save(d);
    expect((await electronVault.load()).welcomeSeen).toBe(true);
  });

  it('an undecryptable vault is kept as a .bak and a later save does not overwrite it', async () => {
    const file = paths.chatgptAccountsPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from('ciphertext-from-another-keychain'));
    const loaded = await electronVault.load();
    expect(loaded.accounts).toEqual([]);
    const dir = await readdir(path.dirname(file));
    const bak = dir.find((n) => n.startsWith('chatgpt_accounts.bin.unreadable-') && n.endsWith('.bak'));
    expect(bak).toBeTruthy();
    await electronVault.save({ ...emptyVault(), welcomeSeen: true });
    expect((await readFile(path.join(path.dirname(file), bak!))).toString()).toBe('ciphertext-from-another-keychain');
    expect((await electronVault.load()).welcomeSeen).toBe(true);
  });

  for (const mode of ['encryption unavailable', 'keychain denied'] as const) {
    it(`${mode}: the vault is neither moved aside nor written over`, async () => {
      await electronVault.save({ ...emptyVault(), welcomeSeen: true });
      const file = paths.chatgptAccountsPath();
      const before = await readFile(file);
      if (mode === 'encryption unavailable') crypto.available = false;
      else crypto.denied = true;
      expect((await electronVault.load()).accounts).toEqual([]);
      expect((await readdir(path.dirname(file))).some((n) => n.endsWith('.bak'))).toBe(false);
      crypto.available = true;
      await expect(electronVault.save({ ...emptyVault() })).rejects.toThrow('KEYCHAIN_UNAVAILABLE');
      expect(await readFile(file)).toEqual(before);
    });
  }
});




