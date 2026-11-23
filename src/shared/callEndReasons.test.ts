import { describe, expect, it } from 'vitest';
import {
  BACKSEAT_END_REASONS,
  CALL_END_REASONS,
  backseatReasonForCallEnd,
  captureErrorClass,
  normalizeCaptureFailDetail,
  isCallEndReason,
  isPlayerEndedReason,
  normalizeBackseatEndReason,
} from './callEndReasons';
import { shouldRetryOpening } from './backseatIpc';

describe('backseatReasonForCallEnd', () => {
  it('names the hang-up button for what the player did', () => {
    expect(backseatReasonForCallEnd('user_hangup')).toBe('user_hangup');
  });

  it('every other call end is call_ended:<why>', () => {
    expect(backseatReasonForCallEnd('companion_hangup')).toBe('call_ended:companion_hangup');
    expect(backseatReasonForCallEnd('inactivity')).toBe('call_ended:inactivity');
    expect(backseatReasonForCallEnd('credits_depleted')).toBe('call_ended:credits_depleted');
  });

  it('whatever it maps to survives main validation', () => {
    for (const r of CALL_END_REASONS) {
      expect(normalizeBackseatEndReason(backseatReasonForCallEnd(r))).toBe(backseatReasonForCallEnd(r));
    }
  });
});

describe('normalizeBackseatEndReason', () => {
  it('keeps every renderer reason', () => {
    for (const r of BACKSEAT_END_REASONS) expect(normalizeBackseatEndReason(r)).toBe(r);
  });

  it('keeps a known capture failure class', () => {
    expect(normalizeBackseatEndReason('capture_failed:permission')).toBe('capture_failed:permission');
  });

  it('turns anything else into unspecified', () => {
    expect(normalizeBackseatEndReason(undefined)).toBe('unspecified');
    expect(normalizeBackseatEndReason(42)).toBe('unspecified');
    expect(normalizeBackseatEndReason('app_quit')).toBe('unspecified'); // main's own, not the renderer's
    expect(normalizeBackseatEndReason('call_ended:whatever')).toBe('unspecified');
    expect(normalizeBackseatEndReason('capture_failed:Some error text')).toBe('unspecified');
    expect(normalizeBackseatEndReason('x'.repeat(100))).toBe('unspecified');
  });
});

describe('isPlayerEndedReason', () => {
  it('only the stop toggle and the hang-up button are the player ending it', () => {
    expect(isPlayerEndedReason('user_stop')).toBe(true);
    expect(isPlayerEndedReason('user_hangup')).toBe(true);
    for (const r of ['capture_lost', 'capture_failed:permission', 'call_ended:inactivity', 'game_launch', 'unspecified']) {
      expect(isPlayerEndedReason(r)).toBe(false);
    }
  });
});

describe('isCallEndReason', () => {
  it('accepts the renderer vocabulary only', () => {
    expect(isCallEndReason('user_hangup')).toBe(true);
    expect(isCallEndReason('app_quit')).toBe(false);
    expect(isCallEndReason(undefined)).toBe(false);
  });
});

describe('captureErrorClass', () => {
  const named = (name: string, message = ''): Error => Object.assign(new Error(message), { name });
  it('maps getUserMedia DOMException names', () => {
    expect(captureErrorClass(named('NotAllowedError'))).toBe('permission');
    expect(captureErrorClass(named('NotFoundError'))).toBe('not_found');
    expect(captureErrorClass(named('NotReadableError'))).toBe('busy');
    expect(captureErrorClass(new Error('The shared window produced no video.'))).toBe('no_video');
    expect(captureErrorClass(new Error('anything'))).toBe('other');
    expect(captureErrorClass(null)).toBe('other');
  });
});

describe('normalizeCaptureFailDetail', () => {
  it('keeps known shape values as capture_* props', () => {
    expect(
      normalizeCaptureFailDetail({ source_kind: 'window', first_class: 'busy', retry: 'failed', minimized: 'yes' }),
    ).toEqual({
      capture_source_kind: 'window',
      capture_first_class: 'busy',
      capture_retry: 'failed',
      capture_minimized: 'yes',
    });
  });

  it('drops unknown keys, unknown values and free text', () => {
    expect(
      normalizeCaptureFailDetail({ source_kind: 'Roblox', first_class: 'busy', title: 'My secret window', retry: 3 }),
    ).toEqual({ capture_first_class: 'busy' });
    expect(normalizeCaptureFailDetail(null)).toEqual({});
    expect(normalizeCaptureFailDetail('busy')).toEqual({});
  });
});

describe('shouldRetryOpening', () => {
  it('retries a failed or empty opening look once', () => {
    expect(shouldRetryOpening('failed', 0)).toBe(true);
    expect(shouldRetryOpening('silent', 0)).toBe(true);
    expect(shouldRetryOpening('failed', 1)).toBe(false);
  });

  it('never retries a look that spoke, was superseded, or hit the credit wall', () => {
    for (const o of ['spoke', 'dropped', 'aborted', 'credit_wall', undefined] as const) {
      expect(shouldRetryOpening(o, 0)).toBe(false);
    }
  });
});
