/**
 * API key persistence via Electron safeStorage.
 *
 * Sources:
 *   - PATTERNS §src/main/apiKeyStore.ts
 *   - RESEARCH §Pattern 4 + Pitfall 3 (Linux basic_text fallback)
 *   - CONTEXT D-13
 *
 * SECURITY: This module is main-process only. The renderer NEVER imports
 * from here. Plaintext crosses to utilityProcess via MessagePortMain only.
 */
import { safeStorage } from 'electron';
import { readFile, writeFile, access, mkdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths';

/**
 * Persist plaintext API key encrypted by OS keychain.
 * Note: We use raw fs.writeFile (with a tmp+rename to keep it atomic) instead
 * of the brain's atomicWrite helper because that helper writes utf8 strings —
 * the encrypted blob is binary and must be written as Buffer.
 */
export async function saveApiKey(plaintext: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('KEYCHAIN_UNAVAILABLE');
  }
  const buf = safeStorage.encryptString(plaintext);
  const target = paths.apiKeyPath();
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}`);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(tmp, buf);
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

export async function hasApiKey(): Promise<boolean> {
  try { await access(paths.apiKeyPath()); return true; }
  catch { return false; }
}

/**
 * Decrypt and return the plaintext API key. Throws if the file is missing
 * or decrypt fails (e.g., user is locked out of Keychain). Caller maps to
 * the `KEYCHAIN_LOCKED` ErrorClass.
 */
export async function loadApiKey(): Promise<string> {
  const buf = await readFile(paths.apiKeyPath());
  return safeStorage.decryptString(buf);
}

/**
 * Returns the safeStorage backend name. On Linux without a desktop secret
 * store this returns `'basic_text'`, signalling that encryption is using a
 * hardcoded key (effectively plaintext) — surfaced to the user as the
 * KEYCHAIN_FALLBACK_PLAINTEXT warning per RESEARCH Pitfall 3.
 *
 * Possible values: 'kwallet' | 'kwallet5' | 'kwallet6' | 'gnome_libsecret' |
 *                  'basic_text' | 'unknown' (older Electron without API)
 */
export function backendKind(): string {
  const fn = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend;
  if (typeof fn !== 'function') return 'unknown';
  try { return fn.call(safeStorage); }
  catch { return 'unknown'; }
}
