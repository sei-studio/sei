/**
 * Crash-safe file replacement (261031, T277).
 *
 * `atomicWrite` (src/bot/brain/storage/atomicWrite.js) writes a temp file and
 * renames it over the target, which protects against a torn write but not
 * against power loss: without an fsync the rename can reach the disk before
 * the data, and the file comes back empty or full of zeros after a reboot
 * (the classic ext4 / NTFS delayed-allocation case). Settings files and the
 * boot-failure counter must survive exactly that, so this helper:
 *
 *   1. writes `<target>.<pid>.<rand>.tmp` in the same directory,
 *   2. fsyncs the temp file,
 *   3. renames it over the target, retrying briefly on Windows when antivirus
 *      or the search indexer holds the target open (EPERM / EBUSY / EACCES),
 *   4. fsyncs the directory on POSIX so the rename itself is durable.
 *
 * A failure removes the temp file and rethrows. Directory fsync failures are
 * ignored (some filesystems refuse it; the data fsync already happened).
 *
 * The sync variant is for the boot guard, which must record a start attempt
 * before anything else runs and cannot await.
 */
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Rename errors worth retrying: Windows reports a briefly-locked target this way. */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Waits between rename attempts (ms). Total worst case about 0.75 s. */
export const RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200, 400];

function tmpPathFor(target: string): string {
  return `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

function isRetryable(err: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

function sleepSync(ms: number): void {
  // Atomics.wait blocks this thread without spinning. Only used for a few
  // hundred ms at most, on the Windows retry path.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Rename with the Windows lock retry. Exported for tests. */
export function renameWithRetrySync(
  from: string,
  to: string,
  deps: { rename?: (a: string, b: string) => void; platform?: NodeJS.Platform; sleep?: (ms: number) => void } = {},
): void {
  const doRename = deps.rename ?? renameSync;
  const platform = deps.platform ?? process.platform;
  const sleep = deps.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt++) {
    try {
      doRename(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isRetryable(err, platform)) throw err;
      sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Async rename with the Windows lock retry. Exported for tests. */
export async function renameWithRetry(
  from: string,
  to: string,
  deps: { rename?: (a: string, b: string) => Promise<void>; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const doRename = deps.rename ?? rename;
  const platform = deps.platform ?? process.platform;
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isRetryable(err, platform)) throw err;
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function fsyncDirSync(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* not supported here; the file data is already on disk */
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const fh = await open(dir, 'r');
    try { await fh.sync(); } finally { await fh.close(); }
  } catch {
    /* not supported here; the file data is already on disk */
  }
}

/** Synchronously and durably replace `target` with `data`. Throws on failure. */
export function writeFileDurableSync(target: string, data: string | Uint8Array): void {
  const tmp = tmpPathFor(target);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameWithRetrySync(tmp, target);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  fsyncDirSync(path.dirname(target));
}

/** Durably replace `target` with `data`. Throws on failure. */
export async function writeFileDurable(target: string, data: string | Uint8Array): Promise<void> {
  const tmp = tmpPathFor(target);
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await renameWithRetry(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch { /* already gone */ }
    throw err;
  }
  await fsyncDir(path.dirname(target));
}
