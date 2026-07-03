/**
 * Tests for runtime profile-scope switching (260603).
 *
 * Surface:
 *   - switchScopeForAuth re-points the data scope, stops the bot, seeds the new
 *     profile, and pushes app:scope-changed.
 *   - No-op when the scope is unchanged (token refresh / INITIAL_SESSION).
 *   - reason is derived correctly (sign-in / sign-out / switch).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
}));

// Avoid dragging in characterStore → personaExpansion → apiKeyStore: stub the
// seeder. We only assert that it's invoked for a fresh profile.
const seedDefaultCharactersMock = vi.fn(async () => {});
vi.mock('../defaultCharacters', () => ({
  seedDefaultCharacters: seedDefaultCharactersMock,
}));

import { paths, _setUserDataOverride, setActiveScope, getActiveScope } from '../paths';
import { IpcChannel } from '../../shared/ipc';
import { initProfileScope, switchScopeForAuth, _resetForTests } from './profileScope';

const UUID_A = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';
const UUID_B = 'e4511df2-fd20-470b-9131-f8f9968e1c01';

let tmp: string;
let stopMock: ReturnType<typeof vi.fn>;
let sendMock: ReturnType<typeof vi.fn>;

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-scope-test-'));
  _setUserDataOverride(tmp);
  setActiveScope('local');
  seedDefaultCharactersMock.mockClear();
  stopMock = vi.fn(async () => {});
  sendMock = vi.fn();
  const supervisor = { stop: stopMock } as unknown as Parameters<typeof initProfileScope>[0]['supervisor'];
  const win = { isDestroyed: () => false, webContents: { send: sendMock } } as unknown as Electron.BrowserWindow;
  initProfileScope({ supervisor, getMainWindow: () => win });
});

afterEach(async () => {
  _resetForTests();
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('switchScopeForAuth', () => {
  it('signs in: stops bot, re-points scope, seeds + pushes scope-changed (sign-in)', async () => {
    await switchScopeForAuth(UUID_A);

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(getActiveScope()).toBe(UUID_A);
    expect(seedDefaultCharactersMock).toHaveBeenCalledTimes(1);
    expect(await exists(paths.profileRoot())).toBe(true);
    expect(sendMock).toHaveBeenCalledWith(IpcChannel.app.scopeChanged, { scope: UUID_A, reason: 'sign-in' });
  });

  it('signs in: defaults the freshly-scoped profile to cloud-proxy billing', async () => {
    await switchScopeForAuth(UUID_A);
    const { getAiBackendKind } = await import('../apiKeyStore');
    expect(await getAiBackendKind()).toBe('cloud-proxy');
  });

  it('re-flips a DEFAULT-sourced local profile to cloud-proxy on a fresh sign-in', async () => {
    // A 'local' that came from a default write (a pre-source-field config, or a
    // build that never wrote the cloud default) is re-asserted to cloud on
    // every genuine sign-in transition — it was never a deliberate BYOK choice.
    await switchScopeForAuth(UUID_A);
    const { setAiBackendKind, getAiBackendKind } = await import('../apiKeyStore');
    await setAiBackendKind('local', 'default'); // schema-default-flavored local
    await switchScopeForAuth(null); // sign out
    await switchScopeForAuth(UUID_A); // sign back in
    expect(await getAiBackendKind()).toBe('cloud-proxy');
  });

  it('keeps an EXPLICIT user choice of local across sign-out/sign-in (260703)', async () => {
    // The user flipped ACCOUNT MODE to BYOK themselves (proxy:configure →
    // setAiBackendKind, default source 'user'). Re-login must NOT stomp it back
    // to cloud billing — that silently moved their calls onto paid credits.
    await switchScopeForAuth(UUID_A);
    const { setAiBackendKind, getAiBackendKind } = await import('../apiKeyStore');
    await setAiBackendKind('local'); // source defaults to 'user' (explicit)
    await switchScopeForAuth(null); // sign out
    await switchScopeForAuth(UUID_A); // sign back in
    expect(await getAiBackendKind()).toBe('local');
  });

  it('is a no-op when the scope is unchanged', async () => {
    await switchScopeForAuth(UUID_A);
    stopMock.mockClear();
    sendMock.mockClear();
    seedDefaultCharactersMock.mockClear();

    await switchScopeForAuth(UUID_A); // same user again (token refresh)

    expect(stopMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(seedDefaultCharactersMock).not.toHaveBeenCalled();
    expect(getActiveScope()).toBe(UUID_A);
  });

  it('signs out: scope → local, reason sign-out', async () => {
    await switchScopeForAuth(UUID_A);
    sendMock.mockClear();

    await switchScopeForAuth(null);

    expect(getActiveScope()).toBe('local');
    expect(sendMock).toHaveBeenCalledWith(IpcChannel.app.scopeChanged, { scope: 'local', reason: 'sign-out' });
  });

  it('account swap: A → B, reason switch', async () => {
    await switchScopeForAuth(UUID_A);
    sendMock.mockClear();

    await switchScopeForAuth(UUID_B);

    expect(getActiveScope()).toBe(UUID_B);
    expect(sendMock).toHaveBeenCalledWith(IpcChannel.app.scopeChanged, { scope: UUID_B, reason: 'switch' });
  });
});
