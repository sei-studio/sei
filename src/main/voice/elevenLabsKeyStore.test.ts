/**
 * BYOK ElevenLabs key store (260725) — persistence + resolution precedence.
 *
 * Pins:
 *   - set/get round-trips through the (mocked) safeStorage blob; trim on set;
 *     empty string rejected; null clears; hasElevenLabsKey tracks presence.
 *   - resolveElevenLabsKey precedence: SEI_TTS_DEV_KEY env beats the stored
 *     key; the stored key resolves ONLY under the 'local' (BYOK) backend;
 *     cloud-proxy resolves null even with a key on disk.
 *   - resolveElevenLabsRoute: direct with a key, unconfigured for key-less
 *     BYOK, proxy for cloud.
 * Mirrors the apiKeyStore.backendKind.test.ts harness (electron mock +
 * _setUserDataOverride tmp profile).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

import { _setUserDataOverride, setActiveScope } from '../paths';
import { setAiBackendKind, _resetAiBackendKindListenersForTests } from '../apiKeyStore';
import {
  setElevenLabsKey,
  getElevenLabsKey,
  hasElevenLabsKey,
  resolveElevenLabsKey,
  resolveElevenLabsRoute,
} from './elevenLabsKeyStore';

let tmp: string;
const savedEnvKey = process.env.SEI_TTS_DEV_KEY;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-elevenkey-test-'));
  _setUserDataOverride(tmp);
  _resetAiBackendKindListenersForTests();
  delete process.env.SEI_TTS_DEV_KEY;
});

afterEach(async () => {
  _resetAiBackendKindListenersForTests();
  _setUserDataOverride(null);
  setActiveScope('local');
  if (savedEnvKey === undefined) delete process.env.SEI_TTS_DEV_KEY;
  else process.env.SEI_TTS_DEV_KEY = savedEnvKey;
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('setElevenLabsKey / getElevenLabsKey / hasElevenLabsKey', () => {
  it('round-trips a key and reports presence', async () => {
    expect(await hasElevenLabsKey()).toBe(false);
    expect(await getElevenLabsKey()).toBeNull();
    await setElevenLabsKey('sk-eleven-abc123');
    expect(await hasElevenLabsKey()).toBe(true);
    expect(await getElevenLabsKey()).toBe('sk-eleven-abc123');
  });

  it('trims the key on set', async () => {
    await setElevenLabsKey('  sk-eleven-abc123  \n');
    expect(await getElevenLabsKey()).toBe('sk-eleven-abc123');
  });

  it('rejects empty / whitespace-only strings (null is the clear signal)', async () => {
    await expect(setElevenLabsKey('')).rejects.toThrow('ELEVEN_KEY_EMPTY');
    await expect(setElevenLabsKey('   ')).rejects.toThrow('ELEVEN_KEY_EMPTY');
    expect(await hasElevenLabsKey()).toBe(false);
  });

  it('null clears the stored key (ENOENT-tolerant when nothing is stored)', async () => {
    await setElevenLabsKey('sk-eleven-abc123');
    await setElevenLabsKey(null);
    expect(await hasElevenLabsKey()).toBe(false);
    expect(await getElevenLabsKey()).toBeNull();
    await expect(setElevenLabsKey(null)).resolves.toBeUndefined(); // already clear
  });
});

describe('resolveElevenLabsKey precedence', () => {
  it('SEI_TTS_DEV_KEY env beats the stored key', async () => {
    await setAiBackendKind('local');
    await setElevenLabsKey('stored-key-123');
    process.env.SEI_TTS_DEV_KEY = 'env-key-456';
    expect(await resolveElevenLabsKey()).toBe('env-key-456');
  });

  it('stored key resolves under the local (BYOK) backend', async () => {
    await setAiBackendKind('local');
    await setElevenLabsKey('stored-key-123');
    expect(await resolveElevenLabsKey()).toBe('stored-key-123');
  });

  it('stored key does NOT resolve under cloud-proxy (voice stays metered via the proxy)', async () => {
    await setAiBackendKind('cloud-proxy');
    await setElevenLabsKey('stored-key-123');
    expect(await resolveElevenLabsKey()).toBeNull();
    // ...but the env key still wins even on cloud-proxy.
    process.env.SEI_TTS_DEV_KEY = 'env-key-456';
    expect(await resolveElevenLabsKey()).toBe('env-key-456');
  });

  it('local backend with no stored key resolves null', async () => {
    await setAiBackendKind('local');
    expect(await resolveElevenLabsKey()).toBeNull();
  });
});

describe('resolveElevenLabsRoute', () => {
  it('direct with a resolved key', async () => {
    await setAiBackendKind('local');
    await setElevenLabsKey('stored-key-123');
    expect(await resolveElevenLabsRoute()).toEqual({ kind: 'direct', key: 'stored-key-123' });
  });

  it('unconfigured for key-less BYOK (never falls through to the proxy)', async () => {
    await setAiBackendKind('local');
    expect(await resolveElevenLabsRoute()).toEqual({ kind: 'unconfigured' });
  });

  it('proxy for cloud-proxy without an env key', async () => {
    await setAiBackendKind('cloud-proxy');
    expect(await resolveElevenLabsRoute()).toEqual({ kind: 'proxy' });
  });
});
