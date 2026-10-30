/**
 * 261029 review: the network steps of a profile move are bounded. The cloud
 * name backfill reads the session first (a token refresh, ~25 s or more
 * offline) and the own-character pull talks to the cloud; a hung one held the
 * move, so the renderer's scope-changed push, and every switch queued behind
 * it, waited on the network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
}));
// Hung network calls, released after each test (a pull still running is a
// tracked scoped write, which the next switch would wait out).
let releases: Array<() => void> = [];
const hung = <T,>(value: T) => (): Promise<T> => new Promise<T>((r) => releases.push(() => r(value)));
const fetchMyProfileName = vi.fn(hung<string | null>(null));
const cacheMyCloudCharacters = vi.fn((_scope: string) => hung<void>(undefined)());
vi.mock('../cloud/cloudCharacterClient', async (orig) => ({
  ...(await orig<typeof import('../cloud/cloudCharacterClient')>()),
  fetchMyProfileName: () => fetchMyProfileName(),
}));
vi.mock('../cloud/cacheOnDemand', async (orig) => ({
  ...(await orig<typeof import('../cloud/cacheOnDemand')>()),
  cacheMyCloudCharacters: (s: string) => cacheMyCloudCharacters(s),
}));

import { _setUserDataOverride, setActiveScope, getActiveScope } from '../paths';
import { IpcChannel } from '../../shared/ipc';
import { initProfileScope, switchScopeForAuth, _resetForTests } from './profileScope';

const UUID = 'e4511df2-fd20-470b-9131-f8f9968e1c01';
let tmp: string;
let sendMock: ReturnType<typeof vi.fn>;

// The move imports most of main (ipc, migration, llm); load it once up front
// so a busy machine spends that time here, not inside a test's bound.
beforeAll(async () => {
  await Promise.all([import('../ipc'), import('../migration'), import('../llm/capability'), import('../apiKeyStore')]);
}, 60_000);

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-scope-timeout-'));
  _setUserDataOverride(tmp);
  setActiveScope('local');
  sendMock = vi.fn();
  const supervisor = { stop: vi.fn(async () => {}) } as unknown as Parameters<typeof initProfileScope>[0]['supervisor'];
  const win = { isDestroyed: () => false, webContents: { send: sendMock } } as unknown as Electron.BrowserWindow;
  initProfileScope({ supervisor, getMainWindow: () => win, stepTimeoutMs: 50 });
});

afterEach(async () => {
  for (const r of releases) r();
  releases = [];
  _resetForTests();
  _setUserDataOverride(null);
  setActiveScope('local');
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe('profile move network steps', { timeout: 20_000 }, () => {
  it('a hung name backfill and character pull do not hold the move', async () => {
    await switchScopeForAuth(UUID);
    // Both calls are still pending: the move finished on the bound.
    expect(releases).toHaveLength(2);
    expect(fetchMyProfileName).toHaveBeenCalled();
    expect(cacheMyCloudCharacters).toHaveBeenCalledWith(UUID);
    expect(getActiveScope()).toBe(UUID);
    expect(sendMock).toHaveBeenCalledWith(IpcChannel.app.scopeChanged, { scope: UUID, reason: 'sign-in' });
  });

  it('a step that answers in time is used', async () => {
    fetchMyProfileName.mockImplementationOnce(async () => 'Ann');
    cacheMyCloudCharacters.mockImplementationOnce(async (_scope: string) => undefined);
    await switchScopeForAuth(UUID);
    const { loadConfig } = await import('../configStore');
    expect((await loadConfig()).preferred_name).toBe('Ann');
  });
});
