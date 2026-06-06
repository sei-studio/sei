/**
 * Device-global device-id (anti-abuse / trial-claim hardening) tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// paths.ts imports electron's `app`; stub it (we override userData via
// _setUserDataOverride anyway, but the import must resolve).
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}));

import { paths, _setUserDataOverride } from '../paths';
import { getDeviceId, _resetDeviceIdCacheForTests } from './deviceId';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-devid-'));
  _setUserDataOverride(tmp);
  _resetDeviceIdCacheForTests();
});

afterEach(async () => {
  _setUserDataOverride(null);
  _resetDeviceIdCacheForTests();
  await rm(tmp, { recursive: true, force: true });
});

describe('deviceId', () => {
  it('creates a UUID on first call and persists it to device-id.json', async () => {
    const id = await getDeviceId();
    expect(id).toMatch(UUID_RE);
    const raw = await readFile(paths.deviceIdPath(), 'utf8');
    expect(JSON.parse(raw)).toEqual({ deviceId: id });
  });

  it('is stable across calls (cached, same value)', async () => {
    const a = await getDeviceId();
    const b = await getDeviceId();
    expect(b).toBe(a);
  });

  it('reads the persisted value on a fresh process (cache reset)', async () => {
    const first = await getDeviceId();
    _resetDeviceIdCacheForTests(); // simulate a new process
    const second = await getDeviceId();
    expect(second).toBe(first);
  });

  it('regenerates when the on-disk value is corrupt', async () => {
    await writeFile(paths.deviceIdPath(), 'not json', 'utf8');
    _resetDeviceIdCacheForTests();
    const id = await getDeviceId();
    expect(id).toMatch(UUID_RE);
  });

  it('regenerates when the on-disk value is not a UUID', async () => {
    await writeFile(paths.deviceIdPath(), JSON.stringify({ deviceId: 'nope' }), 'utf8');
    _resetDeviceIdCacheForTests();
    const id = await getDeviceId();
    expect(id).toMatch(UUID_RE);
    // and the bad value is replaced on disk
    const raw = JSON.parse(await readFile(paths.deviceIdPath(), 'utf8'));
    expect(raw.deviceId).toBe(id);
  });
});
