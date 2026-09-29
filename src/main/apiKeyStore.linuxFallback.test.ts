/**
 * Linux basic_text safeStorage fallback (260930, experimental AppImage).
 * Without a desktop secret store Electron picks `basic_text` and refuses to
 * encrypt until the app opts in, so neither a BYOK key nor a cloud session
 * could be saved. The opt-in must happen on Linux + basic_text only.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { enableLinuxPlainTextFallback } from './apiKeyStore';

function fake(backend: string | (() => string)) {
  const setUsePlainTextEncryption = vi.fn();
  const getSelectedStorageBackend = typeof backend === 'function' ? backend : () => backend;
  return {
    ss: { getSelectedStorageBackend, setUsePlainTextEncryption } as never,
    setUsePlainTextEncryption,
  };
}

describe('enableLinuxPlainTextFallback', () => {
  it('opts in on linux with the basic_text backend', () => {
    const f = fake('basic_text');
    expect(enableLinuxPlainTextFallback(f.ss, 'linux')).toBe(true);
    expect(f.setUsePlainTextEncryption).toHaveBeenCalledWith(true);
  });

  it('leaves a real secret store alone', () => {
    for (const b of ['gnome_libsecret', 'kwallet5', 'kwallet6', 'unknown']) {
      const f = fake(b);
      expect(enableLinuxPlainTextFallback(f.ss, 'linux')).toBe(false);
      expect(f.setUsePlainTextEncryption).not.toHaveBeenCalled();
    }
  });

  it('never runs on mac or windows', () => {
    for (const p of ['darwin', 'win32'] as const) {
      const f = fake('basic_text');
      expect(enableLinuxPlainTextFallback(f.ss, p)).toBe(false);
      expect(f.setUsePlainTextEncryption).not.toHaveBeenCalled();
    }
  });

  it('a throwing backend query is a no-op', () => {
    const f = fake(() => {
      throw new Error('boom');
    });
    expect(enableLinuxPlainTextFallback(f.ss, 'linux')).toBe(false);
    expect(f.setUsePlainTextEncryption).not.toHaveBeenCalled();
  });
});
