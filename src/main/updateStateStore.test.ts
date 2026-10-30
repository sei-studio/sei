import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('./paths', () => ({
  paths: {
    userData: () => h.userData,
    updateStatePath: () => path.join(h.userData, 'update-state.json'),
  },
}));

import { loadUpdateState, measuredInstallSeconds, saveUpdateState } from './updateStateStore';

describe('updateStateStore pending.brief', () => {
  beforeEach(async () => {
    h.userData = await mkdtemp(path.join(tmpdir(), 'sei-update-state-'));
  });
  afterEach(async () => {
    await rm(h.userData, { recursive: true, force: true });
  });

  it('round-trips brief: true for an accepted optional update', async () => {
    await saveUpdateState({
      version: 1,
      lastSeenVersion: '0.7.0',
      pending: { version: '0.8.0', changelog: '- New thing', brief: true },
    });
    const s = await loadUpdateState();
    expect(s.pending).toEqual({ version: '0.8.0', changelog: '- New thing', brief: true });
  });

  it('keeps mandatory stashes without the flag', async () => {
    await saveUpdateState({
      version: 1,
      lastSeenVersion: '0.7.0',
      pending: { version: '0.7.1', changelog: '- Fix' },
    });
    const s = await loadUpdateState();
    expect(s.pending).toEqual({ version: '0.7.1', changelog: '- Fix' });
    expect(s.pending && 'brief' in s.pending).toBe(false);
  });

  it('drops a non-boolean brief from an older or hand-edited file', async () => {
    await writeFile(
      path.join(h.userData, 'update-state.json'),
      JSON.stringify({ version: 1, lastSeenVersion: null, pending: { version: '1.0.0', changelog: '', brief: 'yes' } }),
    );
    const s = await loadUpdateState();
    expect(s.pending).toEqual({ version: '1.0.0', changelog: '' });
  });
});

describe('updateStateStore install timing (Windows progress window)', () => {
  beforeEach(async () => {
    h.userData = await mkdtemp(path.join(tmpdir(), 'sei-update-state-'));
  });
  afterEach(async () => {
    await rm(h.userData, { recursive: true, force: true });
  });

  it('round-trips installTiming and installSeconds', async () => {
    await saveUpdateState({
      version: 1,
      lastSeenVersion: '0.7.0',
      pending: null,
      installTiming: { startedAt: 1_000, fromVersion: '0.7.0' },
      installSeconds: [90, 104],
    });
    const s = await loadUpdateState();
    expect(s.installTiming).toEqual({ startedAt: 1_000, fromVersion: '0.7.0' });
    expect(s.installSeconds).toEqual([90, 104]);
  });

  it('omits both when absent, and an older file still loads', async () => {
    await writeFile(
      path.join(h.userData, 'update-state.json'),
      JSON.stringify({ version: 1, lastSeenVersion: '0.6.9', pending: null }),
    );
    const s = await loadUpdateState();
    expect(s).toEqual({ version: 1, lastSeenVersion: '0.6.9', pending: null });
  });

  it('drops malformed timing and junk samples, keeps the last five', async () => {
    await writeFile(
      path.join(h.userData, 'update-state.json'),
      JSON.stringify({
        version: 1,
        lastSeenVersion: null,
        pending: null,
        installTiming: { startedAt: 'soon', fromVersion: '0.7.0' },
        installSeconds: [1, 2, 'x', -5, 3, 4, 5, 6, null, 1e9],
      }),
    );
    const s = await loadUpdateState();
    expect(s.installTiming).toBeUndefined();
    expect(s.installSeconds).toEqual([2, 3, 4, 5, 6]);
  });

  it('measures only a changed version inside 30 minutes', () => {
    const t = { startedAt: 10_000, fromVersion: '0.7.0' };
    expect(measuredInstallSeconds(t, '0.7.1', 10_000 + 104_400)).toBe(104);
    expect(measuredInstallSeconds(t, '0.7.0', 10_000 + 104_000)).toBeNull();
    expect(measuredInstallSeconds(t, '0.7.1', 10_000 + 31 * 60_000)).toBeNull();
    expect(measuredInstallSeconds(t, '0.7.1', 5_000)).toBeNull();
    expect(measuredInstallSeconds(null, '0.7.1', 20_000)).toBeNull();
  });
});
