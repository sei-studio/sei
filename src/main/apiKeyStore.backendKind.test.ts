/**
 * ai_backend_kind change notification (260721).
 *
 * Analytics stamps a cached backend kind on every event; the cache is fed by
 * onAiBackendKindChanged. These tests pin that EVERY writer of ai_backend_kind
 * fires the listener, because the live bug was exactly one writer
 * (applyCloudDefaultForSignIn, the first-sign-in cloud default) persisting the
 * flip without telling analytics — a brand-new cloud user's whole first
 * session shipped stamped backend:'local'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { _setUserDataOverride, setActiveScope } from './paths';
import {
  setAiBackendKind,
  getAiBackendKind,
  applyCloudDefaultForSignIn,
  ensureCloudDefaultForSignedIn,
  onAiBackendKindChanged,
  _resetAiBackendKindListenersForTests,
} from './apiKeyStore';

let tmp: string;
let seen: string[];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-backendkind-test-'));
  _setUserDataOverride(tmp);
  _resetAiBackendKindListenersForTests();
  seen = [];
  onAiBackendKindChanged((kind) => seen.push(kind));
});

afterEach(async () => {
  _resetAiBackendKindListenersForTests();
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('onAiBackendKindChanged', () => {
  it('fires on the explicit switch (setAiBackendKind)', async () => {
    await setAiBackendKind('cloud-proxy');
    expect(seen).toEqual(['cloud-proxy']);
    await setAiBackendKind('local');
    expect(seen).toEqual(['cloud-proxy', 'local']);
  });

  it('fires when the sign-in cloud default actually writes', async () => {
    await applyCloudDefaultForSignIn();
    expect(seen).toEqual(['cloud-proxy']);
    expect(await getAiBackendKind()).toBe('cloud-proxy');
    // Idempotent: already cloud-proxy → no write, no notification.
    await applyCloudDefaultForSignIn();
    expect(seen).toEqual(['cloud-proxy']);
  });

  it('does not fire when an explicit user choice blocks the sign-in default', async () => {
    await setAiBackendKind('local', 'user');
    seen.length = 0;
    await applyCloudDefaultForSignIn();
    expect(seen).toEqual([]);
    expect(await getAiBackendKind()).toBe('local');
  });

  it('fires when the boot self-heal writes for a signed-in scope', async () => {
    setActiveScope('11111111-1111-4111-8111-111111111111');
    await ensureCloudDefaultForSignedIn();
    expect(seen).toEqual(['cloud-proxy']);
  });

  it('a throwing listener never breaks the config write', async () => {
    onAiBackendKindChanged(() => {
      throw new Error('boom');
    });
    await setAiBackendKind('cloud-proxy');
    expect(await getAiBackendKind()).toBe('cloud-proxy');
    expect(seen).toEqual(['cloud-proxy']);
  });
});
