/**
 * portraitProtocol.readPortraitWithRetry — first-load 404 race fix.
 *
 * A `sei-portrait://` request can arrive in the window between a character's
 * `portrait_image` ref becoming visible and the async writer (cache-on-demand
 * download → atomicWrite rename) landing the PNG on disk. A plain readFile
 * throws ENOENT → the handler 404s → PixelPortrait pins to the procedural
 * sprite for good. readPortraitWithRetry rides out that window: it retries on
 * ENOENT and resolves the instant the rename lands, while still failing fast on
 * a genuinely-absent file and on non-ENOENT (hard) errors.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// electron isn't available in the node-test env. portraitProtocol imports
// `protocol` from electron at module load (and `paths`, which pulls in `app`),
// so stub both to inert shapes. We only exercise readPortraitWithRetry, which
// touches neither.
vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  app: { getPath: () => '/tmp/sei-default' },
}));

import { readPortraitWithRetry } from './portraitProtocol';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-portrait-proto-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('readPortraitWithRetry', () => {
  it('returns bytes immediately when the file already exists', async () => {
    const target = path.join(tmp, 'a.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(target, bytes);

    const read = await readPortraitWithRetry(target, 3, 5);
    expect(read.equals(bytes)).toBe(true);
  });

  it('rides out the write race: resolves once a file that was missing at first read lands', async () => {
    const target = path.join(tmp, 'race.png');
    const bytes = Buffer.from([1, 2, 3, 4, 5]);

    // Kick off the read while the target does NOT yet exist, then land the
    // file (via rename, mirroring atomicWrite) after a couple of retry ticks.
    const readPromise = readPortraitWithRetry(target, 20, 10);
    setTimeout(() => {
      const tmpFile = `${target}.tmp`;
      void writeFile(tmpFile, bytes).then(() => rename(tmpFile, target));
    }, 35);

    const read = await readPromise;
    expect(read.equals(bytes)).toBe(true);
  });

  it('rejects with ENOENT after the retry budget when the file never appears', async () => {
    const target = path.join(tmp, 'never.png');
    await expect(readPortraitWithRetry(target, 3, 5)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not retry non-ENOENT errors (a directory path → EISDIR surfaces at once)', async () => {
    // The temp dir itself is a directory; reading it as a file throws EISDIR,
    // which must NOT be retried. Assert it rejects fast (well under the budget).
    const started = Date.now();
    await expect(readPortraitWithRetry(tmp, 50, 100)).rejects.toBeTruthy();
    // 50 retries × 100ms = 5s budget; a non-retried hard error returns promptly.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
