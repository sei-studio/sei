/**
 * Config write race (260929): every main-process writer of the profile's
 * config.json goes through updateConfig's locked read-modify-write and sets
 * only the keys it owns.
 *
 * Before, apiKeyStore, backgroundStore, userProfile and the library handlers
 * read the whole config, awaited, and wrote the whole thing back without the
 * lock. A game ending in that gap (chess difficulty, the Draw! intro, the
 * playtime fold) had its key reverted by the stale copy.
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
import { addPlaytimeMs, loadConfig, saveConfig, saveConfigFromRenderer, updateConfig } from './configStore';
import { setAiBackendKind } from './apiKeyStore';
import { removeBackgroundImage } from './backgroundStore';
import { removeUserProfilePicture } from './userProfile';
import { recordChessOutcome } from './chess/chessDifficulty';
import type { ChessProfile } from './chess/chessProfile';

const PROFILE: ChessProfile = { elo: 1200, styleNote: '', source: 'auto' };

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-cfg-race-'));
  _setUserDataOverride(tmp);
});
afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  await rm(tmp, { recursive: true, force: true });
});

describe('concurrent config writers', () => {
  it('a main-owned key update racing the older whole-config writers is never lost', async () => {
    await saveConfig({
      ...(await loadConfig()),
      background_image: 'background.png',
      profile_picture: 'user.png',
    });

    const chars = Array.from({ length: 8 }, (_, i) => `char-${i}`);
    await Promise.all([
      setAiBackendKind('cloud-proxy'),
      ...chars.map((id) => recordChessOutcome(id, PROFILE, 'player')),
      removeBackgroundImage(),
      updateConfig((cfg) => ({ ...cfg, draw_intro_done: true })),
      removeUserProfilePicture(),
      addPlaytimeMs(1000),
      setAiBackendKind('cloud-proxy', 'user'),
      addPlaytimeMs(500),
    ]);

    const cfg = await loadConfig();
    expect(Object.keys(cfg.chess_elo_offsets ?? {}).sort()).toEqual(chars);
    expect(cfg.draw_intro_done).toBe(true);
    expect(cfg.total_playtime_ms).toBe(1500);
    expect(cfg.ai_backend_kind).toBe('cloud-proxy');
    expect(cfg.ai_backend_kind_source).toBe('user');
    expect(cfg.background_image).toBeNull();
    expect(cfg.profile_picture).toBeNull();
  });

  it('a renderer save racing a game end does not revert the keys main wrote', async () => {
    const stale = await loadConfig(); // the Settings screen's copy, taken at mount
    await Promise.all([
      recordChessOutcome('sui', PROFILE, 'player'),
      updateConfig((cfg) => ({ ...cfg, draw_intro_done: true })),
      saveConfigFromRenderer({ ...stale, theme_mode: 'mint' }),
      saveConfigFromRenderer({ ...stale, theme_mode: 'mint', realistic_typing: false }),
    ]);
    const cfg = await loadConfig();
    expect(cfg.chess_elo_offsets?.sui).toBeTypeOf('number');
    expect(cfg.draw_intro_done).toBe(true);
    expect(cfg.theme_mode).toBe('mint');
  });
});
