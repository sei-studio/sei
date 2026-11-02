/**
 * The user's own Fish Audio API key (261103), persisted with Electron
 * safeStorage exactly like elevenLabsKeyStore.ts: encrypted by the OS
 * keychain, written atomically to `<profileRoot>/fish_audio_key.bin`, and
 * decrypted ONLY in main. The renderer can set/clear it and ask whether one
 * is stored; the key itself never crosses back.
 *
 * Fish runs with this key straight from main and never through the Sei
 * proxy: Fish's terms keep free use non-commercial and not for third
 * parties, and a user's own key on their own machine stays inside that.
 */
import { safeStorage } from 'electron';
import { readFile, writeFile, access, mkdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../paths';

/** Store (trimmed, encrypted) or, with null, delete the key. Empty throws FISH_KEY_EMPTY. */
export async function setFishKey(key: string | null): Promise<void> {
  if (key === null) {
    try {
      await unlink(paths.fishKeyPath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return;
  }
  const trimmed = key.trim();
  if (!trimmed) throw new Error('FISH_KEY_EMPTY');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('KEYCHAIN_UNAVAILABLE');
  const buf = safeStorage.encryptString(trimmed);
  const target = paths.fishKeyPath();
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

export async function hasFishKey(): Promise<boolean> {
  try { await access(paths.fishKeyPath()); return true; }
  catch { return false; }
}

/**
 * The stored key, or null when none is stored or it cannot be decrypted
 * (best-effort: a locked keychain reads as "no key", which falls back to the
 * Fast voices with the no-key notice). SEI_FISH_DEV_KEY (dev shells only,
 * never a committed file) wins.
 */
export async function resolveFishKey(): Promise<string | null> {
  const envKey = process.env.SEI_FISH_DEV_KEY;
  if (envKey) return envKey;
  try {
    const buf = await readFile(paths.fishKeyPath());
    const key = safeStorage.decryptString(buf).trim();
    return key || null;
  } catch {
    return null;
  }
}
