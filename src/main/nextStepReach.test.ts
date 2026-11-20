import { describe, expect, it } from 'vitest';
import { gameEndRoute, mainClosedCallRoute } from './nextStepReach';
import { sessionEndProps } from './sessionEnd';

describe('gameEndRoute', () => {
  it('runs the check for a Stop, a closed world and a disconnect', () => {
    for (const reason of ['user_stop', 'world_closed', 'disconnected']) {
      expect(gameEndRoute({ reason, companionGoodbye: false })).toEqual({ kind: 'check' });
      // The existing rule: a player Stop after a goodbye line still checks.
      expect(gameEndRoute({ reason, companionGoodbye: true })).toEqual({ kind: 'check' });
    }
  });

  it('a Stardew or DST game closed by the player now arrives as world_closed and is checked', () => {
    const props = sessionEndProps({
      kind: 'error',
      characterId: 'c',
      error: 'GAME_WORLD_NOT_OPEN',
      message: 'GAME_WORLD_NOT_OPEN: Lost the farm',
      midSession: true,
      endReason: 'world_closed',
    } as never);
    expect(props.reason).toBe('world_closed');
    expect(gameEndRoute({ reason: props.reason, companionGoodbye: false })).toEqual({ kind: 'check' });
    // Before 261107 the adapters sent no endReason, and the same end read as an error.
    const old = sessionEndProps({ kind: 'error', characterId: 'c', error: 'GAME_WORLD_NOT_OPEN', message: '' } as never);
    expect(old.reason).toBe('error');
    expect(gameEndRoute({ reason: old.reason, companionGoodbye: false })).toEqual({ kind: 'report', outcome: 'not_covered' });
  });

  it('a companion goodbye is reported as one, even at app quit', () => {
    expect(gameEndRoute({ reason: 'companion_quit', companionGoodbye: true })).toEqual({ kind: 'report', outcome: 'goodbye' });
    expect(gameEndRoute({ reason: 'app_quit', companionGoodbye: true })).toEqual({ kind: 'report', outcome: 'goodbye' });
  });

  it('an app quit without a goodbye is kept for the next launch', () => {
    expect(gameEndRoute({ reason: 'app_quit', companionGoodbye: false })).toEqual({ kind: 'persist' });
  });

  it('every other end is reported as not covered', () => {
    for (const reason of ['kicked', 'crash', 'error', 'credits_depleted', 'rate_limited', 'account_switch', 'bot_exit', 'unknown', 'companion_quit']) {
      expect(gameEndRoute({ reason, companionGoodbye: false })).toEqual({ kind: 'report', outcome: 'not_covered' });
    }
  });
});

describe('mainClosedCallRoute', () => {
  const base = { companionEnded: false, inGame: false };

  it('a window close runs the check now on macOS (the app stays up) and keeps it for the next launch elsewhere', () => {
    expect(mainClosedCallRoute({ ...base, reason: 'window_closed', platform: 'darwin' })).toEqual({ kind: 'check' });
    expect(mainClosedCallRoute({ ...base, reason: 'window_closed', platform: 'win32' })).toEqual({ kind: 'persist' });
    expect(mainClosedCallRoute({ ...base, reason: 'window_closed', platform: 'linux' })).toEqual({ kind: 'persist' });
  });

  it('an app quit was already kept by persistCallsForQuit', () => {
    expect(mainClosedCallRoute({ ...base, reason: 'app_quit', platform: 'win32' })).toEqual({ kind: 'none' });
    expect(mainClosedCallRoute({ ...base, inGame: true, reason: 'app_quit', platform: 'darwin' })).toEqual({ kind: 'none' });
  });

  it('a companion hang-up whose report had not arrived is a goodbye', () => {
    for (const reason of ['window_closed', 'app_quit', 'account_switch']) {
      expect(mainClosedCallRoute({ ...base, companionEnded: true, reason, platform: 'darwin' })).toEqual({ kind: 'report', outcome: 'goodbye' });
    }
  });

  it('an in-game call is covered by the game', () => {
    expect(mainClosedCallRoute({ ...base, inGame: true, reason: 'window_closed', platform: 'darwin' })).toEqual({ kind: 'report', outcome: 'in_game' });
  });

  it('an account switch, renderer crash or reload is not the player leaving', () => {
    for (const reason of ['account_switch', 'renderer_gone', 'renderer_reload']) {
      expect(mainClosedCallRoute({ ...base, reason, platform: 'darwin' })).toEqual({ kind: 'report', outcome: 'not_covered' });
    }
  });
});
