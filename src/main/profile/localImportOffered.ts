/**
 * Which accounts were already offered the own-key (local profile) import on
 * this device (261023).
 *
 * The offer also runs once at boot for an account that signed in on an older
 * build (it was only offered on a sign-in, so that group's local companions
 * were stranded). Recording the choice here keeps "Not now" from asking again
 * at every launch; Settings keeps a row for doing it later.
 *
 * Device-global (`<userData>/local-import-offered.json`), keyed by account id:
 * the local profile it is about belongs to the device, not to any account.
 * Holds account ids and timestamps only.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { paths, SCOPE_LOCAL } from '../paths';
import { atomicWrite } from '../../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../../bot/brain/storage/fileLock.js';

interface OfferedFile {
  version: 1;
  /** account id -> ISO time the player answered the offer. */
  accounts: Record<string, string>;
}

async function readOffered(): Promise<OfferedFile> {
  try {
    const parsed = JSON.parse(await readFile(paths.localImportOfferedPath(), 'utf8')) as Partial<OfferedFile>;
    if (parsed && parsed.accounts && typeof parsed.accounts === 'object' && !Array.isArray(parsed.accounts)) {
      return { version: 1, accounts: { ...parsed.accounts } };
    }
  } catch { /* missing or corrupt: nothing offered yet */ }
  return { version: 1, accounts: {} };
}

/** Whether `account` already answered the import offer on this device. */
export async function wasLocalImportOffered(account: string): Promise<boolean> {
  // Signed out there is no account to offer to: report "offered" so nothing asks.
  if (!account || account === SCOPE_LOCAL) return true;
  return typeof (await readOffered()).accounts[account.toLowerCase()] === 'string';
}

/** Record that `account` answered the import offer (either button). */
export async function markLocalImportOffered(account: string, now: Date = new Date()): Promise<void> {
  if (!account || account === SCOPE_LOCAL) return;
  const file = paths.localImportOfferedPath();
  await mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, async () => {
    const cur = await readOffered();
    const key = account.toLowerCase();
    if (cur.accounts[key]) return;
    cur.accounts[key] = now.toISOString();
    await atomicWrite(file, JSON.stringify(cur, null, 2) + '\n');
  });
}




