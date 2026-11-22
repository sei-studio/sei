/**
 * The WorldLink entrance gating (261119): which trigger plays her entrance,
 * when her look counts as on its way, and the closed shapes on the wire.
 */
import { describe, expect, it } from 'vitest';
import {
  ENTRANCE_TRIGGERS,
  EXPECTED_LINK_MS,
  LINK_TIMEOUT_MS,
  arrivalMode,
  lookPending,
  sanitizeArrival,
  sanitizeArrivedReport,
  settledLook,
} from './seilinkEntrance';

const base = { arrived: false, pending: false, skipped: false, revealed: false, waited: false };

describe('arrivalMode', () => {
  it('her entrance plays on every move-in and switch-in, once the app has stepped aside', () => {
    for (const trigger of ['move_in', 'switch'] as const) {
      expect(arrivalMode({ ...base, trigger })).toBe('hold');
      expect(arrivalMode({ ...base, trigger, revealed: true })).toBe('enter');
    }
  });

  it('a restore at app start does not replay a big entrance, unless she had to wait for her look', () => {
    expect(arrivalMode({ ...base, trigger: 'restore' })).toBe('show');
    expect(arrivalMode({ ...base, trigger: 'restore', revealed: true })).toBe('show');
    expect(arrivalMode({ ...base, trigger: 'restore', waited: true })).toBe('enter');
  });

  it('the first link: the intro shows her coming in; after a handoff the desktop does', () => {
    expect(arrivalMode({ ...base, trigger: 'first_link' })).toBe('show');
    expect(arrivalMode({ ...base, trigger: 'first_link', revealed: true, waited: true })).toBe('enter');
  });

  it('her look on its way means wait, for every trigger, until a skip', () => {
    for (const trigger of ENTRANCE_TRIGGERS) {
      expect(arrivalMode({ ...base, trigger, pending: true, revealed: true })).toBe('wait');
      expect(arrivalMode({ ...base, trigger, pending: true, skipped: true, revealed: true, waited: true })).toBe('enter');
    }
  });

  it('once she is in, she is just there', () => {
    for (const trigger of ENTRANCE_TRIGGERS) expect(arrivalMode({ ...base, trigger, arrived: true, pending: true })).toBe('show');
  });
});

describe('lookPending', () => {
  it('the bake and its download are pending; a face set on disk never is', () => {
    for (const stage of ['checking', 'requesting', 'queued', 'running', 'downloading'] as const) {
      expect(lookPending({ state: 'idle', stage })).toBe(true);
      // A re-check behind a face set already on disk: she shows with it.
      expect(lookPending({ state: 'ready', stage })).toBe(false);
    }
  });

  it('unavailable is pending only while her cut-out is still landing', () => {
    expect(lookPending({ state: 'idle', stage: 'unavailable' }, { inFlight: true })).toBe(true);
    expect(lookPending({ state: 'idle', stage: 'unavailable' }, { inFlight: false })).toBe(false);
  });

  it('settled stages, no status and her own model are not pending', () => {
    for (const stage of ['ready', 'failed', 'offline'] as const) expect(lookPending({ state: 'idle', stage }, { inFlight: true })).toBe(false);
    expect(lookPending(null)).toBe(false);
    expect(lookPending({ state: 'idle' })).toBe(false);
    expect(lookPending({ state: 'idle', stage: 'running' }, { imported: true })).toBe(false);
  });
});

describe('settledLook', () => {
  it('classes her look', () => {
    expect(settledLook({ state: 'ready', stage: 'ready' })).toBe('ready');
    expect(settledLook({ state: 'ready', stage: 'ready' }, { waited: true })).toBe('arrived');
    expect(settledLook({ state: 'idle', stage: 'unavailable' })).toBe('unavailable');
    expect(settledLook({ state: 'idle', stage: 'failed' })).toBe('failed');
    expect(settledLook({ state: 'idle', stage: 'offline' })).toBe('offline');
    expect(settledLook(null)).toBe('unavailable');
    expect(settledLook({ state: 'idle' }, { imported: true })).toBe('imported');
  });
});

describe('wire shapes', () => {
  it('sanitizeArrival keeps closed shapes only', () => {
    expect(sanitizeArrival({ mode: 'wait', trigger: 'move_in', quiet: true, text: 'x' })).toEqual({ mode: 'wait', trigger: 'move_in', quiet: true });
    expect(sanitizeArrival({ mode: 'enter', trigger: 'switch', quiet: true })).toEqual({ mode: 'enter', trigger: 'switch' });
    expect(sanitizeArrival({ mode: 'dance', trigger: 'move_in' })).toBeNull();
    expect(sanitizeArrival({ mode: 'show', trigger: 'login' })).toBeNull();
    expect(sanitizeArrival(null)).toBeNull();
  });

  it('sanitizeArrivedReport keeps booleans and known avatar kinds', () => {
    expect(sanitizeArrivedReport({ played: true, reduced: 'yes', kind: 'facepack' })).toEqual({ played: true, reduced: false, kind: 'facepack' });
    expect(sanitizeArrivedReport({ played: 1, kind: 'Amara.png' })).toEqual({ played: false, reduced: false, kind: null });
    expect(sanitizeArrivedReport(undefined)).toEqual({ played: false, reduced: false, kind: null });
  });
});

describe('timing', () => {
  it('waits long enough for a real bake (fast bake 49 to 63 s on 261119, slower on a fallback GPU or a queue)', () => {
    expect(EXPECTED_LINK_MS).toBeGreaterThanOrEqual(63_000);
    expect(LINK_TIMEOUT_MS).toBeGreaterThanOrEqual(3 * EXPECTED_LINK_MS);
    expect(LINK_TIMEOUT_MS).toBeGreaterThan(EXPECTED_LINK_MS);
  });
});




