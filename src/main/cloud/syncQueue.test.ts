/**
 * Tests for src/main/cloud/syncQueue.ts.
 *
 * Sources:
 *   - 11-08-PLAN <behavior> bullets (9 covered behaviors)
 *   - 11-RESEARCH §Pattern 4 (queue shape + backoff schedule)
 *   - sessionStore.test.ts (tmpdir + _setUserDataOverride pattern)
 *
 * Mocking strategy: every cross-module dependency the drainer touches is
 * lazy-imported inside processNext(), so vi.mock() of the bare specifier
 * intercepts the dynamic import at module-resolution time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// electron is imported by paths.ts; stub before importing anything that touches paths.
vi.mock('electron', () => ({
  app: { getPath: (_: string) => tmpdir() },
}));

// ---- Mocks for dynamic imports inside processNext --------------------------

const isCloudWriteAllowedMock = vi.fn(async () => true);
vi.mock('../auth/authState', () => ({
  isCloudWriteAllowed: isCloudWriteAllowedMock,
}));

const upsertCharacterMock = vi.fn(async (_c: unknown, _o: string) => undefined);
const deleteCharacterMock = vi.fn(async (_u: string) => undefined);
const uploadSkinMock = vi.fn(async (_u: string, _b: Buffer, _jwt: string) => undefined);
const uploadPortraitMock = vi.fn(async (_u: string, _b: Buffer, _f: string, _jwt: string) => undefined);
const deleteStorageObjectsMock = vi.fn(async (_p: unknown) => undefined);
vi.mock('./cloudCharacterClient', () => ({
  upsertCharacter: upsertCharacterMock,
  deleteCharacter: deleteCharacterMock,
  uploadSkin: uploadSkinMock,
  uploadPortrait: uploadPortraitMock,
  deleteStorageObjects: deleteStorageObjectsMock,
}));

const getSessionMock = vi.fn(async () => ({
  data: { session: { user: { id: 'owner-uuid-1' }, access_token: 'jwt-token' } },
}));
vi.mock('../auth/supabaseClient', () => ({
  getClient: () => ({ auth: { getSession: getSessionMock } }),
}));

const getCharacterMock = vi.fn(async (_uuid: string) => ({
  id: 'abc',
  name: 'Test',
  persona: { source: 'hi', expanded: 'world' },
  skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: '2026-05-21T00:00:00Z' },
  username: null,
} as unknown));
const resolveSkinPngMock = vi.fn(async (_c: unknown) => null as Buffer | null);
vi.mock('../characterStore', () => ({
  getCharacter: getCharacterMock,
}));
vi.mock('../skinStore', () => ({
  resolveSkinPng: resolveSkinPngMock,
}));

// ---- After mocks, import the module under test + helpers -------------------

import { paths, _setUserDataOverride } from '../paths';
import {
  enqueueUpsert,
  enqueueDelete,
  processNext,
  getStatus,
  retry,
  subscribeStatusChange,
  type SyncOp,
} from './syncQueue';

// ---- Test fixture lifecycle ------------------------------------------------

let tmp: string;

async function readQueueFile(): Promise<SyncOp[]> {
  try {
    const raw = await readFile(paths.syncQueuePath(), 'utf8');
    return JSON.parse(raw) as SyncOp[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-syncq-'));
  _setUserDataOverride(tmp);
  // 260603 partition: the sync queue now lives under <userData>/profiles/<scope>/.
  // Pre-seeding tests write the queue file directly, so ensure the (default
  // 'local') profile root exists first.
  await mkdir(paths.profileRoot(), { recursive: true });
  // Reset mocks each test
  isCloudWriteAllowedMock.mockReset();
  isCloudWriteAllowedMock.mockResolvedValue(true);
  upsertCharacterMock.mockReset();
  upsertCharacterMock.mockResolvedValue(undefined);
  deleteCharacterMock.mockReset();
  deleteCharacterMock.mockResolvedValue(undefined);
  uploadSkinMock.mockReset();
  uploadSkinMock.mockResolvedValue(undefined);
  uploadPortraitMock.mockReset();
  uploadPortraitMock.mockResolvedValue(undefined);
  deleteStorageObjectsMock.mockReset();
  deleteStorageObjectsMock.mockResolvedValue(undefined);
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue({
    data: { session: { user: { id: 'owner-uuid-1' }, access_token: 'jwt-token' } },
  });
  getCharacterMock.mockReset();
  getCharacterMock.mockResolvedValue({
    id: 'abc',
    name: 'Test',
    persona: { source: 'hi', expanded: 'world' },
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: '2026-05-21T00:00:00Z' },
    username: null,
  } as unknown);
  resolveSkinPngMock.mockReset();
  resolveSkinPngMock.mockResolvedValue(null);
});

afterEach(async () => {
  _setUserDataOverride(null);
  await rm(tmp, { recursive: true, force: true });
});

describe('syncQueue', () => {
  it('enqueueUpsert persists a single op with attempts=0 and now-ish nextAttemptAt', async () => {
    await enqueueUpsert('abc');
    const q = await readQueueFile();
    expect(q).toHaveLength(1);
    expect(q[0].kind).toBe('upsert');
    expect(q[0].uuid).toBe('abc');
    expect(q[0].attempts).toBe(0);
    expect(new Date(q[0].nextAttemptAt).getTime()).toBeLessThanOrEqual(Date.now() + 100);
  });

  it('enqueueUpsert called twice for same uuid collapses to ONE entry (idempotent)', async () => {
    await enqueueUpsert('abc');
    await enqueueUpsert('abc');
    await enqueueUpsert('abc');
    const q = await readQueueFile();
    expect(q).toHaveLength(1);
    expect(q[0].uuid).toBe('abc');
  });

  it('enqueueDelete stores full storagePaths array', async () => {
    const sp = [
      { bucket: 'skins' as const, name: 'owner/abc.png' },
      { bucket: 'portraits' as const, name: 'owner/abc.png' },
    ];
    await enqueueDelete('abc', sp);
    const q = await readQueueFile();
    expect(q).toHaveLength(1);
    expect(q[0].kind).toBe('delete');
    if (q[0].kind === 'delete') {
      expect(q[0].storagePaths).toEqual(sp);
    }
  });

  it('enqueueDelete supersedes a pending upsert for the same uuid', async () => {
    await enqueueUpsert('abc');
    await enqueueDelete('abc', [{ bucket: 'skins', name: 'owner/abc.png' }]);
    const q = await readQueueFile();
    expect(q).toHaveLength(1);
    expect(q[0].kind).toBe('delete');
  });

  it('processNext on an empty queue is a no-op', async () => {
    await processNext();
    expect(upsertCharacterMock).not.toHaveBeenCalled();
    expect(deleteCharacterMock).not.toHaveBeenCalled();
  });

  it('processNext drains a pending upsert via cloudCharacterClient and removes from queue', async () => {
    await enqueueUpsert('abc');
    await processNext();
    // Drainer fans out into setImmediate to drain next op — wait one tick so the
    // recursive call completes before we read the queue.
    await new Promise(r => setImmediate(r));
    expect(upsertCharacterMock).toHaveBeenCalledTimes(1);
    expect(upsertCharacterMock.mock.calls[0][1]).toBe('owner-uuid-1');
    const q = await readQueueFile();
    expect(q).toHaveLength(0);
  });

  it('processNext on a delete calls deleteCharacter + deleteStorageObjects', async () => {
    const sp = [{ bucket: 'skins' as const, name: 'owner/abc.png' }];
    await enqueueDelete('abc', sp);
    await processNext();
    await new Promise(r => setImmediate(r));
    expect(deleteCharacterMock).toHaveBeenCalledWith('abc');
    expect(deleteStorageObjectsMock).toHaveBeenCalledWith(sp);
    const q = await readQueueFile();
    expect(q).toHaveLength(0);
  });

  it('processNext when isCloudWriteAllowed is false reschedules WITHOUT incrementing attempts', async () => {
    isCloudWriteAllowedMock.mockResolvedValue(false);
    await enqueueUpsert('abc');
    const before = await readQueueFile();
    await processNext();
    const after = await readQueueFile();
    expect(after).toHaveLength(1);
    expect(after[0].attempts).toBe(0);
    expect(new Date(after[0].nextAttemptAt).getTime()).toBeGreaterThan(
      new Date(before[0].nextAttemptAt).getTime(),
    );
    expect(upsertCharacterMock).not.toHaveBeenCalled();
  });

  it('processNext on cloud failure increments attempts and schedules backoff', async () => {
    upsertCharacterMock.mockRejectedValueOnce(new Error('network down'));
    await enqueueUpsert('abc');
    const start = Date.now();
    await processNext();
    const q = await readQueueFile();
    expect(q).toHaveLength(1);
    expect(q[0].attempts).toBe(1);
    expect(q[0].lastError).toBe('network down');
    // First-failure backoff: 5s (BACKOFF_MS[1] after attempts=1)
    const next = new Date(q[0].nextAttemptAt).getTime();
    expect(next - start).toBeGreaterThanOrEqual(4_500);
    expect(next - start).toBeLessThanOrEqual(7_000);
  });

  it('processNext marks failedAt after MAX_ATTEMPTS=6 failures', async () => {
    upsertCharacterMock.mockRejectedValue(new Error('always fails'));
    // Pre-seed the queue with attempts=5 so the next processNext is attempt #6
    const target = paths.syncQueuePath();
    await writeFile(
      target,
      JSON.stringify([
        {
          kind: 'upsert',
          uuid: 'abc',
          queuedAt: new Date().toISOString(),
          attempts: 5,
          nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
        },
      ], null, 2),
    );
    await processNext();
    const q = await readQueueFile();
    expect(q).toHaveLength(1);
    expect(q[0].attempts).toBe(6);
    expect(q[0].failedAt).toBeTruthy();
  });

  it('getStatus reports pending count + failed list separately', async () => {
    await enqueueUpsert('abc');
    await enqueueUpsert('def');
    // Mark one as failed manually via the queue file
    const target = paths.syncQueuePath();
    const q = await readQueueFile();
    q[0].failedAt = new Date().toISOString();
    await writeFile(target, JSON.stringify(q, null, 2));

    const status = await getStatus();
    expect(status.pending).toBe(1);
    expect(status.failed).toHaveLength(1);
    expect(status.pendingByUuid['abc']).toBe('failed');
    expect(status.pendingByUuid['def']).toBe('syncing');
  });

  it('retry(uuid) resets attempts + failedAt and re-runs the op', async () => {
    upsertCharacterMock.mockResolvedValue(undefined);
    // Seed a failed op
    const target = paths.syncQueuePath();
    await writeFile(
      target,
      JSON.stringify([
        {
          kind: 'upsert',
          uuid: 'abc',
          queuedAt: new Date().toISOString(),
          attempts: 6,
          nextAttemptAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          failedAt: new Date().toISOString(),
          lastError: 'old',
        },
      ], null, 2),
    );
    await retry('abc');
    await new Promise(r => setImmediate(r));
    const q = await readQueueFile();
    expect(q).toHaveLength(0); // succeeded + removed
    expect(upsertCharacterMock).toHaveBeenCalled();
  });

  it('readQueue defensively returns [] when the file is corrupt (does NOT throw)', async () => {
    const target = paths.syncQueuePath();
    // Ensure dir exists, then write garbage
    await import('node:fs/promises').then(m => m.mkdir(path.dirname(target), { recursive: true }));
    await writeFile(target, 'this is not json {{{');
    // enqueueUpsert reads then writes — if readQueue threw, this would throw
    await expect(enqueueUpsert('abc')).resolves.toBeUndefined();
    const q = await readQueueFile();
    expect(q).toHaveLength(1);
    expect(q[0].uuid).toBe('abc');
  });

  it('subscribeStatusChange notifies on enqueueUpsert and processNext', async () => {
    const fn = vi.fn();
    const unsub = subscribeStatusChange(fn);
    await enqueueUpsert('abc');
    expect(fn).toHaveBeenCalled();
    fn.mockClear();
    await processNext();
    await new Promise(r => setImmediate(r));
    expect(fn).toHaveBeenCalled();
    unsub();
  });

  it('processNext skips ops whose nextAttemptAt is in the future', async () => {
    const target = paths.syncQueuePath();
    const future = new Date(Date.now() + 60_000).toISOString();
    await import('node:fs/promises').then(m => m.mkdir(path.dirname(target), { recursive: true }));
    await writeFile(
      target,
      JSON.stringify([
        {
          kind: 'upsert',
          uuid: 'abc',
          queuedAt: new Date().toISOString(),
          attempts: 1,
          nextAttemptAt: future,
        },
      ], null, 2),
    );
    await processNext();
    expect(upsertCharacterMock).not.toHaveBeenCalled();
    const q = await readQueueFile();
    expect(q).toHaveLength(1);
  });
});
