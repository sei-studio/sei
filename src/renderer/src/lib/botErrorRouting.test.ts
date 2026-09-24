import { describe, it, expect } from 'vitest';
import { modalForBotStatus } from './botErrorRouting';

const err = (error: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'error', error, message: 'm', characterId: 'c1', ...extra }) as never;

describe('modalForBotStatus', () => {
  it('keeps the Minecraft table (unsupported version, LAN not open, modded host)', () => {
    expect(modalForBotStatus(err('UNSUPPORTED_MC_VERSION'))).toEqual({ kind: 'unsupported-version', characterId: 'c1', message: 'm' });
    expect(modalForBotStatus(err('LAN_NOT_OPEN', { game: 'minecraft' }))).toEqual({ kind: 'lan-not-open', characterId: 'c1' });
    expect(modalForBotStatus(err('MODDED_HOST_REJECTED'))).toEqual({ kind: 'modded-host', characterId: 'c1' });
  });

  it('opens the crash popup only for a mid-session death with no dedicated surface', () => {
    expect(modalForBotStatus(err('BOT_CRASH'))).toBeNull();
    expect(modalForBotStatus(err('BOT_CRASH', { midSession: true }))).toEqual({ kind: 'bot-crash', characterId: 'c1' });
    expect(modalForBotStatus(err('LAN_NOT_OPEN', { midSession: true }))).toEqual({ kind: 'lan-not-open', characterId: 'c1' });
    expect(modalForBotStatus(err('BOT_CRASH', { midSession: true, game: 'stardew' }))).toEqual({ kind: 'bot-crash', characterId: 'c1' });
  });

  it('routes the game-neutral classes to the generic modal for any game', () => {
    expect(modalForBotStatus(err('GAME_WORLD_NOT_OPEN', { game: 'stardew' }))).toEqual({
      kind: 'game-error', game: 'stardew', characterId: 'c1', error: 'GAME_WORLD_NOT_OPEN', message: 'm',
    });
    expect(modalForBotStatus(err('GAME_PACK_DOWNLOAD_FAILED', { game: 'minecraft' }))).toMatchObject({ kind: 'game-error', game: 'minecraft' });
  });

  it('ignores non-error statuses', () => {
    expect(modalForBotStatus({ kind: 'online', characterId: 'c1', uptimeMs: 0, startedAtMs: 0 })).toBeNull();
  });
});
