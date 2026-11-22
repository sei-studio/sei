import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({ packaged: false }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return m.packaged;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));
vi.mock('../paths', () => ({ paths: { fishKeyPath: () => '/nonexistent/sei-test/fish_audio_key.bin' } }));

import { resolveFishKey } from './fishKeyStore';

describe('resolveFishKey', () => {
  beforeEach(() => {
    process.env.SEI_FISH_DEV_KEY = 'dev-key';
  });
  afterEach(() => {
    delete process.env.SEI_FISH_DEV_KEY;
    m.packaged = false;
  });

  it('uses SEI_FISH_DEV_KEY in an unpackaged dev run', async () => {
    expect(await resolveFishKey()).toBe('dev-key');
  });

  it('ignores SEI_FISH_DEV_KEY in a packaged build', async () => {
    m.packaged = true;
    expect(await resolveFishKey()).toBe(null);
  });
});




