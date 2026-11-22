/**
 * 261017 (issue #46): storage for "Continue with ChatGPT".
 *
 * - The credential vault: every saved registration (issued client_id +
 *   verified subject) with its token set, the active account and the
 *   welcome-notice flag, as ONE safeStorage-encrypted blob at
 *   `<profile>/chatgpt_accounts.bin` (tmp + rename, mode 0600). Same
 *   protection as the BYOK key (apiKeyStore.ts); never logged, never sent to
 *   the renderer (it gets ChatgptStatus, which has no tokens).
 * - The host id (`ext_agent_host_id`): a urn:uuid:v4 created once per machine
 *   before the first sign-in, at `<userData>/chatgpt-host-id.json`. Opaque
 *   and not a secret, so plain JSON.
 */
import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../paths';
import type { ChatgptVault, VaultData } from './session';
import { emptyVault, parseVault } from './session';

async function atomicWrite(target: string, data: Buffer | string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}`);
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Rename an unreadable vault to `<name>.unreadable-<stamp>.bak`; never throws. */
export async function quarantineUnreadable(file: string): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${file}.unreadable-${stamp}.bak`;
  try {
    await rename(file, bak);
    return bak;
  } catch {
    return null;
  }
}

/**
 * A decrypt error that says the KEY is out of reach right now (keychain
 * locked or access denied), not that this ciphertext is foreign. Electron's
 * own wording for a wrong key is "Error while decrypting the ciphertext".
 */
function keychainOutOfReach(err: unknown): boolean {
  return /keychain|denied|not available|unavailable|user canceled|interaction is not allowed/i.test(String((err as Error)?.message ?? err));
}

/**
 * Vault files this process could not read because the keychain was out of
 * reach. They are never moved aside (the data is fine) and never written
 * over: save refuses until a restart reads them again.
 */
const unreadableHere = new Set<string>();

/** The safeStorage-backed vault for the ACTIVE profile (path read per call). */
export const electronVault: ChatgptVault = {
  key: () => paths.chatgptAccountsPath(),
  async load(): Promise<VaultData> {
    const file = paths.chatgptAccountsPath();
    let buf: Buffer;
    try {
      buf = await readFile(file);
    } catch {
      return emptyVault();
    }
    if (!safeStorage.isEncryptionAvailable()) {
      unreadableHere.add(file);
      return emptyVault();
    }
    let text: string;
    try {
      text = safeStorage.decryptString(buf);
    } catch (err) {
      if (keychainOutOfReach(err)) {
        unreadableHere.add(file);
        return emptyVault();
      }
      // A real decrypt failure (keychain reset, another machine's copy):
      // treat as no accounts rather than crashing every LLM call, but move
      // the file aside first so the next save never destroys it.
      await quarantineUnreadable(file);
      return emptyVault();
    }
    try {
      return parseVault(JSON.parse(text));
    } catch {
      await quarantineUnreadable(file);
      return emptyVault();
    }
  },
  async save(data: VaultData): Promise<void> {
    const file = paths.chatgptAccountsPath();
    if (!safeStorage.isEncryptionAvailable() || unreadableHere.has(file)) throw new Error('KEYCHAIN_UNAVAILABLE');
    await atomicWrite(file, safeStorage.encryptString(JSON.stringify(data)));
  },
};

/** Tests only. */
export function _resetVaultLocks(): void {
  unreadableHere.clear();
}

const HOST_ID_RE = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let hostIdPromise: Promise<string> | null = null;

/** The stable host id, created and persisted on first use. */
export function getChatgptHostId(): Promise<string> {
  if (!hostIdPromise) {
    hostIdPromise = (async () => {
      const p = paths.chatgptHostIdPath();
      try {
        const raw = JSON.parse(await readFile(p, 'utf8')) as { host_id?: unknown };
        if (typeof raw.host_id === 'string' && HOST_ID_RE.test(raw.host_id)) return raw.host_id;
      } catch { /* missing or junk: create */ }
      const id = `urn:uuid:${randomUUID()}`;
      await atomicWrite(p, JSON.stringify({ host_id: id, created_at: new Date().toISOString() }));
      return id;
    })().catch((err) => {
      hostIdPromise = null;
      throw err;
    });
  }
  return hostIdPromise;
}




