/**
 * 260817 (china-compat W10) — the pack download seam BETWEEN surfaces.
 *
 * Settings (W5 DownloadConfirmModal) and onboarding (W6 PackDownloadPanel)
 * both drive speech:pack-download for the same pack ids. The store's
 * single-flight map is what makes a concurrent double-request (two surfaces,
 * or a double-click) share ONE network job instead of interleaving writes.
 * These tests pin that: two concurrent downloadPack calls produce one fetch
 * sequence (mirror then origin on failure), and a failed job leaves the pack
 * 'absent' so a retry starts a genuinely new job.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
}));

import { _setUserDataOverride, setActiveScope } from './../paths';
import { downloadPack, packStatus } from './packStore';

let tmp: string;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-packstore-test-'));
  _setUserDataOverride(tmp);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('downloadPack single-flight (W10)', () => {
  it('two concurrent requests for the same pack share one job (one fetch sequence)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline test: no network');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Start BOTH before awaiting either — the Settings + onboarding shape.
    const a = downloadPack('tts-en');
    const b = downloadPack('tts-en');
    const [ra, rb] = await Promise.allSettled([a, b]);

    // Both callers see the same outcome...
    expect(ra.status).toBe('rejected');
    expect(rb.status).toBe('rejected');
    expect(String((ra as PromiseRejectedResult).reason)).toMatch(/SPEECH_DOWNLOAD_FAILED/);
    // ...and the job ran ONCE: one source loop = 2 fetch attempts
    // (mirror, then origin), not 4.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a failed download leaves the pack absent and a retry starts a new job', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline test: no network');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(downloadPack('tts-en')).rejects.toThrow(/SPEECH_DOWNLOAD_FAILED/);
    const states = await packStatus();
    expect(states['tts-en'].state).toBe('absent');

    // The inflight slot was released: a retry is a NEW job (fetches again).
    await expect(downloadPack('tts-en')).rejects.toThrow(/SPEECH_DOWNLOAD_FAILED/);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
