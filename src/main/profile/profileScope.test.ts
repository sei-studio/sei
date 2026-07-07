/**
 * Tests for runtime profile-scope switching (260603).
 *
 * Surface:
 *   - switchScopeForAuth re-points the data scope, stops the bot, mkdirs the new
 *     profile root, and pushes app:scope-changed.
 *   - No-op when the scope is unchanged (token refresh / INITIAL_SESSION).
 *   - reason is derived correctly (sign-in / sign-out / switch).
 *
 * 260706: scope switching no longer seeds bundled defaults (the defaults come
 * from the World/cloud path now), so the old seed-invocation assertions are gone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
}));

import { writeFile } from 'node:fs/promises';
import { paths, _setUserDataOverride, setActiveScope, getActiveScope } from '../paths';
import { IpcChannel } from '../../shared/ipc';
import { initProfileScope, switchScopeForAuth, _resetForTests } from './profileScope';
import { DEFAULT_CHARACTER_UUIDS, DEFAULT_CHARACTERS_OWNER } from '../defaultCharacters';

// UUID_A doubles as Sui's frozen default UUID so the sign-in heal test can seed
// a stale is_default copy of a real bundled default under the signed-in profile.
const UUID_A = DEFAULT_CHARACTER_UUIDS.sui; // 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586'
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
  it('signs in: stops bot, re-points scope, mkdirs profile + pushes scope-changed (sign-in)', async () => {
    await switchScopeForAuth(UUID_A);

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(getActiveScope()).toBe(UUID_A);
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

  it('signs in: heals a legacy is_default default left in the signed-in profile', async () => {
    // Repro of the 0.3.x→0.4.0 upgrade gap: the boot-time defaults heal ran only
    // against the boot scope ('local' on a session-restore launch), so a
    // signed-in profile that still holds a pre-0.4.0 is_default copy of a bundled
    // default was never converted. Seed that stale copy into UUID_A's profile,
    // then simulate boot-landed-on-local and sign in — the switch must heal it.
    const { mkdir } = await import('node:fs/promises');
    setActiveScope(UUID_A);
    await mkdir(paths.charactersDir(), { recursive: true });
    await writeFile(
      paths.characterPath(UUID_A),
      JSON.stringify({
        id: UUID_A,
        slug: 'sui',
        name: 'Sui',
        persona: { source: 'Sui persona.', expanded: '' },
        is_default: true, // ← the stale pre-0.4.0 shape
        shared: true,
        owner: null,
        // kind/public_id omitted like the real pre-0.4.0 files (schema defaults
        // kind→'custom', public_id→null); the heal fires on is_default:true.
        created: '2026-05-21T00:00:00.000Z',
        last_launched: null,
        playtime_ms: 0,
        cloud_updated_at: '2026-05-21T00:00:00.000Z',
        portrait_image: './img/sui.png',
        skin: { source: 'bundled', mojang_username: null, png_sha256: null, applied_at: null },
        username: 'Sui',
      }, null, 2),
      'utf8',
    );
    await writeFile(
      paths.indexPath(),
      JSON.stringify({ version: 1, order: [UUID_A] }, null, 2),
      'utf8',
    );
    // Boot resolved the scope to 'local' (empty session at getSession() time).
    setActiveScope('local');

    await switchScopeForAuth(UUID_A);

    const { listCharacters } = await import('../characterStore');
    const sui = (await listCharacters()).find((c) => c.id === UUID_A)!;
    expect(sui.is_default).toBe(false);
    expect(sui.owner).toBe(DEFAULT_CHARACTERS_OWNER);
    expect(sui.kind).toBe('custom');
  });

  it('is a no-op when the scope is unchanged', async () => {
    await switchScopeForAuth(UUID_A);
    stopMock.mockClear();
    sendMock.mockClear();

    await switchScopeForAuth(UUID_A); // same user again (token refresh)

    expect(stopMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
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
