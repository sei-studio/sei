/**
 * 260929 — bot_session_ended.reason mapping (see sessionEnd.ts).
 */
import { describe, it, expect } from 'vitest';
import { sessionEndProps, isSessionFailure } from './sessionEnd';

const id = 'char-a';

describe('sessionEndProps', () => {
  it('passes an idle status end reason through', () => {
    expect(sessionEndProps({ kind: 'idle', characterId: id, endReason: 'user_stop' })).toEqual({ reason: 'user_stop' });
    expect(sessionEndProps({ kind: 'idle', characterId: id, endReason: 'companion_quit' })).toEqual({
      reason: 'companion_quit',
    });
  });

  it('reports unknown for an idle with no (or a bogus) reason', () => {
    expect(sessionEndProps({ kind: 'idle', characterId: id })).toEqual({ reason: 'unknown' });
    expect(
      sessionEndProps({ kind: 'idle', characterId: id, endReason: 'nonsense' as never }),
    ).toEqual({ reason: 'unknown' });
  });

  it('an account teardown overrides a plain stop but not an error', () => {
    expect(
      sessionEndProps({ kind: 'idle', characterId: id, endReason: 'user_stop' }, { accountTeardown: true }),
    ).toEqual({ reason: 'account_switch' });
    expect(
      sessionEndProps(
        { kind: 'error', characterId: id, error: 'BOT_CRASH', message: 'x', midSession: true },
        { accountTeardown: true },
      ).reason,
    ).toBe('crash');
  });

  it('uses the bot-provided reason and kick code on an error', () => {
    expect(
      sessionEndProps({
        kind: 'error',
        characterId: id,
        error: 'LAN_NOT_OPEN',
        message: 'The world kept kicking Sei (Kicked: bye Bob)',
        endReason: 'kicked',
        kickCode: 'kicked',
      }),
    ).toEqual({ reason: 'kicked', error_class: 'LAN_NOT_OPEN', kick_code: 'kicked' });
    expect(
      sessionEndProps({
        kind: 'error',
        characterId: id,
        error: 'LAN_NOT_OPEN',
        message: 'Lost connection',
        endReason: 'world_closed',
      }),
    ).toEqual({ reason: 'world_closed', error_class: 'LAN_NOT_OPEN' });
  });

  it('never ships the message and drops a malformed kick code', () => {
    const props = sessionEndProps({
      kind: 'error',
      characterId: id,
      error: 'LAN_NOT_OPEN',
      message: 'secret text',
      endReason: 'kicked',
      kickCode: 'Bye Jenny Smith',
    });
    expect(props).toEqual({ reason: 'kicked', error_class: 'LAN_NOT_OPEN' });
    expect(JSON.stringify(props)).not.toContain('secret');
  });

  it('falls back on the error class when the bot gave no reason', () => {
    const r = (error: string, midSession?: true) =>
      sessionEndProps({ kind: 'error', characterId: id, error: error as never, message: '', midSession });
    expect(r('CLOUD_CREDITS_DEPLETED').reason).toBe('credits_depleted');
    expect(r('DAILY_LIMIT_REACHED').reason).toBe('rate_limited');
    expect(r('MODDED_HOST_REJECTED')).toEqual({ reason: 'kicked', error_class: 'MODDED_HOST_REJECTED', kick_code: 'modded' });
    expect(r('ONLINE_MODE_REJECTED')).toEqual({
      reason: 'kicked',
      error_class: 'ONLINE_MODE_REJECTED',
      kick_code: 'unverified_username',
    });
    expect(r('LAN_NOT_OPEN').reason).toBe('disconnected');
    expect(r('BOT_CRASH').reason).toBe('crash');
    expect(r('INVALID_API_KEY').reason).toBe('error');
    expect(r('RATE_LIMITED', true).reason).toBe('crash');
  });
});

describe('isSessionFailure', () => {
  it('is true only for terminal errors', () => {
    expect(isSessionFailure({ kind: 'error', characterId: id, error: 'BOT_CRASH', message: '' })).toBe(true);
    expect(
      isSessionFailure({ kind: 'error', characterId: id, error: 'INVALID_API_KEY', message: '', transient: true }),
    ).toBe(false);
    expect(isSessionFailure({ kind: 'idle', characterId: id, endReason: 'user_stop' })).toBe(false);
  });
});
