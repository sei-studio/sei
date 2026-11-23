/**
 * Downloading a Velopack Setup.exe named by setup.<channel>.json, shared by
 * the NSIS migration (velopackMigration.ts) and the self-repair
 * (velopackRepair.ts): size and sha256 checked while it streams, and a
 * re-check of the same bytes before a retried start.
 */
import { net } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream, statSync, statfsSync, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { SetupManifest } from './velopackMigrationPolicy';

const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;

/** Free bytes on the volume holding `dir`, or null when unknown. */
export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Downloads to `dest`, checking size and sha256. Throws on any mismatch. */
export async function downloadSetup(
  url: string,
  dest: string,
  m: SetupManifest,
  onProgress?: (bytes: number) => void,
): Promise<void> {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const hash = createHash('sha256');
  const out = createWriteStream(dest);
  // A write error (disk full, antivirus locking the new .exe) must reject this
  // download: with no listener it is an uncaught exception in main, and the
  // drain wait below would never resolve.
  const failed: { error: Error | null } = { error: null };
  out.on('error', (err) => {
    failed.error = err;
  });
  let size = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      if (failed.error) throw failed.error;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > m.size) throw new Error('larger than the manifest says');
      hash.update(value);
      onProgress?.(size);
      if (!out.write(value)) {
        await new Promise<void>((r) => {
          out.once('drain', () => r());
          out.once('error', () => r());
        });
      }
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  } finally {
    if (!out.destroyed) {
      await new Promise<void>((r) => {
        out.once('error', () => r());
        out.end(() => r());
      });
    }
    // end()'s callback fires on 'finish', BEFORE the stream closes its file
    // handle (that runs on the thread pool, and an antivirus scanning on
    // close slows it). Windows will not start an image while a write handle
    // is open on it: Setup started a moment later failed with spawn EBUSY
    // (velopack-update.yml migrate, 261031 and 261101). Wait for the close.
    if (!out.closed) await new Promise<void>((r) => out.once('close', () => r()));
  }
  if (failed.error) throw failed.error;
  if (size !== m.size) throw new Error(`size ${size}, expected ${m.size}`);
  const digest = hash.digest('hex');
  if (digest !== m.sha256) throw new Error(`sha256 ${digest.slice(0, 12)}, expected ${m.sha256.slice(0, 12)}`);
}

/**
 * Before a RETRIED Setup start: null when `file` still holds the bytes that
 * were checked (their sha256 matched the feed, and on a signed build those
 * same bytes passed the Authenticode check, so an equal hash needs no second
 * PowerShell run), else why not. Hashes through one handle, then checks the
 * file did not change during the hash and that the path still names that
 * same file, so a swap or a rewrite while it was busy is caught. The last
 * check is a synchronous stat, and spawnWhenFree starts Setup in the same
 * turn this resolves in.
 */
export async function setupUnchanged(file: string, m: SetupManifest): Promise<string | null> {
  let fh: FileHandle | null = null;
  let before: BigIntStats;
  let after: BigIntStats;
  const hash = createHash('sha256');
  try {
    fh = await open(file, 'r');
    before = await fh.stat({ bigint: true });
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
    after = await fh.stat({ bigint: true });
  } catch (err) {
    return `setup unreadable after its check: ${(err as Error).message}`;
  } finally {
    // Closed before the start: a read handle would not block it, but the
    // path check below must be the last thing before spawn.
    await fh?.close().catch(() => {});
  }
  if (hash.digest('hex') !== m.sha256 || after.size !== BigInt(m.size)) return 'setup changed after its check';
  let named: BigIntStats;
  try {
    named = statSync(file, { bigint: true });
  } catch (err) {
    return `setup unreadable after its check: ${(err as Error).message}`;
  }
  const same =
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    named.ino === after.ino &&
    named.dev === after.dev &&
    named.size === after.size &&
    named.mtimeNs === after.mtimeNs;
  return same ? null : 'setup changed after its check';
}
