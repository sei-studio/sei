/**
 * 260817 (china-compat W10) — clearApiKey.
 *
 * The provider-switch key wipe must UNLINK the key file: hasApiKey() is
 * file-existence based, so storing an encrypted empty string would still read
 * as "a key is saved" and bypass the LOCAL_NO_API_KEY guard (sending the OLD
 * vendor's key to the new provider). These tests pin unlink semantics and
 * idempotency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));

import { _setUserDataOverride, setActiveScope } from './paths';
import { saveApiKey, loadApiKey, hasApiKey, clearApiKey } from './apiKeyStore';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-apikey-clear-test-'));
  _setUserDataOverride(tmp);
});

afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('clearApiKey (W10)', () => {
  it('removes a saved key so hasApiKey() flips false', async () => {
    await saveApiKey('sk-test-123');
    expect(await hasApiKey()).toBe(true);
    expect(await loadApiKey()).toBe('sk-test-123');

    await clearApiKey();
    expect(await hasApiKey()).toBe(false);
    await expect(loadApiKey()).rejects.toThrow(); // file gone, not empty
  });

  it('is idempotent: clearing with no key saved succeeds', async () => {
    expect(await hasApiKey()).toBe(false);
    await expect(clearApiKey()).resolves.toBeUndefined();
    expect(await hasApiKey()).toBe(false);
  });
});
