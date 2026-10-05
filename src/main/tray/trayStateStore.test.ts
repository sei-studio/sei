import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let file = '';
vi.mock('../paths', () => ({ paths: { traySettingsPath: () => file } }));

import {
  _resetTrayStateCacheForTest,
  coerceTrayState,
  DEFAULT_TRAY_STATE,
  getTrayState,
  updateTrayState,
} from './trayStateStore';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sei-tray-'));
  file = path.join(dir, 'tray-settings.json');
  _resetTrayStateCacheForTest();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('trayStateStore (261005)', () => {
  it('defaults to everything off', () => {
    expect(getTrayState()).toEqual(DEFAULT_TRAY_STATE);
    expect(DEFAULT_TRAY_STATE.enabled).toBe(false);
    expect(DEFAULT_TRAY_STATE.open_at_login).toBe(false);
  });

  it('reads a corrupt file as the defaults', () => {
    writeFileSync(file, '{not json');
    expect(getTrayState()).toEqual(DEFAULT_TRAY_STATE);
  });

  it('coerces bad values field by field', () => {
    expect(
      coerceTrayState({
        enabled: 'yes',
        open_at_login: true,
        wall_prompt_seen: true,
        wall: { user_id: 'u1', resets_at: '2026-10-08T00:00:00Z', plan: 'gold' },
        notified_for: 7,
        extra: 1,
      }),
    ).toEqual({
      enabled: false,
      open_at_login: true,
      wall_prompt_seen: true,
      login_item_registered: false,
      wall: { user_id: 'u1', resets_at: '2026-10-08T00:00:00Z' },
      notified_for: null,
    });
    expect(coerceTrayState({ login_item_registered: true }).login_item_registered).toBe(true);
    expect(coerceTrayState({ wall: { user_id: '', resets_at: 'x' } }).wall).toBeNull();
  });

  it('persists updates and reads them back after a restart', async () => {
    await updateTrayState((s) => ({ ...s, enabled: true }));
    await updateTrayState((s) => ({ ...s, wall_prompt_seen: true }));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ enabled: true, wall_prompt_seen: true });
    _resetTrayStateCacheForTest();
    expect(getTrayState()).toMatchObject({ enabled: true, wall_prompt_seen: true, open_at_login: false });
  });
});
