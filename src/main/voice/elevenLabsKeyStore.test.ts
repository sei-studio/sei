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
 *   - resolveTtsRoute (261020, T158): the per-voice table. Cloud + own voice
 *     + key -> direct; cloud + pool voice -> proxy even with a key; local
 *     unchanged for both. STT keeps resolveElevenLabsRoute (proxy on cloud).
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
  resolveOwnVoiceKey,
  resolveTtsRoute,
  resolveSpeakRoute,
  seiVoicesSelected,
} from './elevenLabsKeyStore';
import { updateConfig } from '../configStore';
import { SEI_VOICES_FOR_CHATGPT_ENABLED } from '../../shared/ttsEngine';

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

describe('resolveTtsRoute (261020, own voices on cloud)', () => {
  it('cloud + own voice + stored key -> direct with that key, flagged ownKeyOnCloud', async () => {
    await setAiBackendKind('cloud-proxy');
    await setElevenLabsKey('own-key-123');
    expect(await resolveTtsRoute({ own: true })).toEqual({
      route: { kind: 'direct', key: 'own-key-123' },
      ownKeyOnCloud: true,
    });
  });

  it('cloud + pool voice -> proxy even with a key stored (never bills the key for the pool)', async () => {
    await setAiBackendKind('cloud-proxy');
    await setElevenLabsKey('own-key-123');
    expect(await resolveTtsRoute({ own: false })).toEqual({ route: { kind: 'proxy' }, ownKeyOnCloud: false });
    // STT and anything else that asks the base route stay on the proxy too.
    expect(await resolveElevenLabsRoute()).toEqual({ kind: 'proxy' });
  });

  it('cloud + own voice + no key -> proxy (tts.ts swaps in the stand-in)', async () => {
    await setAiBackendKind('cloud-proxy');
    expect(await resolveTtsRoute({ own: true })).toEqual({ route: { kind: 'proxy' }, ownKeyOnCloud: false });
  });

  it('local is unchanged: the key decides for every voice, never ownKeyOnCloud', async () => {
    await setAiBackendKind('local');
    expect(await resolveTtsRoute({ own: true })).toEqual({ route: { kind: 'unconfigured' }, ownKeyOnCloud: false });
    expect(await resolveTtsRoute({ own: false })).toEqual({ route: { kind: 'unconfigured' }, ownKeyOnCloud: false });
    await setElevenLabsKey('byok-key');
    for (const own of [true, false]) {
      expect(await resolveTtsRoute({ own })).toEqual({
        route: { kind: 'direct', key: 'byok-key' },
        ownKeyOnCloud: false,
      });
    }
  });

  it('the dev env key still wins everywhere, without the cloud fallback flag', async () => {
    await setAiBackendKind('cloud-proxy');
    process.env.SEI_TTS_DEV_KEY = 'env-key-456';
    expect(await resolveTtsRoute({ own: true })).toEqual({
      route: { kind: 'direct', key: 'env-key-456' },
      ownKeyOnCloud: false,
    });
  });
});

describe('resolveOwnVoiceKey', () => {
  it('returns the stored key on either backend (it lists own voices), env first, null when none', async () => {
    await setAiBackendKind('cloud-proxy');
    expect(await resolveOwnVoiceKey()).toBeNull();
    await setElevenLabsKey('own-key-123');
    expect(await resolveOwnVoiceKey()).toBe('own-key-123');
    await setAiBackendKind('local');
    expect(await resolveOwnVoiceKey()).toBe('own-key-123');
    process.env.SEI_TTS_DEV_KEY = 'env-key-456';
    expect(await resolveOwnVoiceKey()).toBe('env-key-456');
  });
});

describe('Sei voices for ChatGPT-plan users stay off (review 261110)', () => {
  // The proxy does not meter voice yet, so a ChatGPT-plan user on the proxy
  // TTS route would get unlimited cloud speech at Sei's cost.
  const chatgptWithSeiVoices = async (): Promise<void> => {
    await setAiBackendKind('local');
    await updateConfig((c) => ({ ...c, provider: 'chatgpt', tts_engine: 'sei' }));
  };

  it('the flag ships false', () => {
    expect(SEI_VOICES_FOR_CHATGPT_ENABLED).toBe(false);
  });

  it('a saved tts_engine "sei" on the ChatGPT plan never resolves to the proxy', async () => {
    await chatgptWithSeiVoices();
    expect(await seiVoicesSelected()).toBe(false);
    expect(await resolveSpeakRoute()).toEqual({ kind: 'unconfigured' });
    for (const own of [false, true]) {
      const { route } = await resolveTtsRoute({ own });
      expect(route.kind).not.toBe('proxy');
    }
  });

  it('with an ElevenLabs key it speaks direct, never through the proxy', async () => {
    await chatgptWithSeiVoices();
    await setElevenLabsKey('sk-eleven-abc123');
    expect(await resolveSpeakRoute()).toEqual({ kind: 'direct', key: 'sk-eleven-abc123' });
  });

  it('the Sei (cloud) setup keeps its proxy route', async () => {
    await setAiBackendKind('cloud-proxy');
    expect(await resolveSpeakRoute()).toEqual({ kind: 'proxy' });
  });
});
