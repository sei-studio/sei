/**
 * The first-link intro, the guide's SeiLink tour and the entry clicks
 * (261105, T337): main rebuilds every renderer-sent prop from closed enums,
 * so nothing free-form (a name, a path) can ride along, and a junk value
 * falls back to a known one or is dropped.
 */
import { describe, expect, it } from 'vitest';
import {
  ENTRY_SOURCES,
  INTRO_MOOD,
  INTRO_STYLE,
  SEILINK_SETUP_EVENT,
  SEILINK_SETUP_STEP_EVENT,
  SETUP_OPENED_FROM,
  SEILINK_ENTRY_EVENT,
  SEILINK_INTRO_EVENT,
  SEILINK_INTRO_LINK_EVENT,
  SEILINK_TOUR_EVENT,
  introDurationBucket,
  isSeilinkIntroEvent,
  sanitizeSeilinkIntroTrack,
} from './seilinkIntroTelemetry';
import { EDITOR_OPENED_FROM, sanitizeSeilinkTrack } from './seilinkTelemetry';

const CID = '0b9c4e7a-1f2d-4c3b-9a8e-7d6c5b4a3f21';

describe('isSeilinkIntroEvent', () => {
  it('owns exactly its three events', () => {
    expect(isSeilinkIntroEvent(SEILINK_INTRO_EVENT)).toBe(true);
    expect(isSeilinkIntroEvent(SEILINK_TOUR_EVENT)).toBe(true);
    expect(isSeilinkIntroEvent(SEILINK_ENTRY_EVENT)).toBe(true);
    expect(isSeilinkIntroEvent(SEILINK_INTRO_LINK_EVENT)).toBe(true);
    expect(isSeilinkIntroEvent('seilink_movein_sheet')).toBe(false);
  });
});

describe('introDurationBucket', () => {
  it('buckets by the edges', () => {
    expect(introDurationBucket(0)).toBe('lt3s');
    expect(introDurationBucket(2999)).toBe('lt3s');
    expect(introDurationBucket(3000)).toBe('3_6s');
    expect(introDurationBucket(8000)).toBe('6_9s');
    expect(introDurationBucket(10_600)).toBe('9_12s');
    expect(introDurationBucket(15_000)).toBe('12_20s');
    expect(introDurationBucket(60_000)).toBe('gt20s');
    expect(introDurationBucket(Number.NaN)).toBe('lt3s');
  });
});

describe('seilink_intro', () => {
  it('keeps the closed shape and drops anything else', () => {
    const out = sanitizeSeilinkIntroTrack(SEILINK_INTRO_EVENT, {
      character_id: CID,
      action: 'skipped',
      trigger: 'first_link',
      style: 'aurora',
      mood: 'eclipse',
      end_on: 'plain_light',
      reduced_motion: true,
      entry: 'tour',
      beat: 'link',
      duration_bucket: '3_6s',
      host: 'ok',
      name: 'Sui',
      path: '/Users/x',
    });
    expect(out).toEqual({
      character_id: CID,
      action: 'skipped',
      trigger: 'first_link',
      style: 'aurora',
      mood: 'eclipse',
      end_on: 'plain_light',
      reduced_motion: true,
      entry: 'tour',
      beat: 'link',
      duration_bucket: '3_6s',
      host: 'ok',
    });
  });

  it('drops the retired moods (eclipse is the only one since 261106 v4)', () => {
    for (const mood of ['accretion', 'nebula']) expect(sanitizeSeilinkIntroTrack(SEILINK_INTRO_EVENT, { mood }).mood).toBeNull();
    expect(sanitizeSeilinkIntroTrack(SEILINK_INTRO_EVENT, { mood: INTRO_MOOD, style: INTRO_STYLE })).toMatchObject({ mood: 'eclipse', style: 'aurora' });
  });

  it('falls back on junk', () => {
    const out = sanitizeSeilinkIntroTrack(SEILINK_INTRO_EVENT, { character_id: 'not a uuid', action: 'exploded', beat: 'nope', reduced_motion: 'yes' });
    expect(out.action).toBe('shown');
    expect(out.trigger).toBe('first_link');
    expect(out.reduced_motion).toBe(false);
    expect(out).not.toHaveProperty('beat');
    expect(out.character_id).not.toBe('not a uuid');
  });
});

describe('seilink_intro_link (261106 v6)', () => {
  it('keeps the line timings, the slowest milestone and the outcome, never an id or text', () => {
    const out = sanitizeSeilinkIntroTrack(SEILINK_INTRO_LINK_EVENT, {
      outcome: 'failed',
      failure: 'timeout',
      trigger: 'first_link',
      reduced_motion: false,
      lines_shown: 7,
      line_1_ms: 2800.4,
      line_7_ms: 99_000_000,
      line_10_ms: 5,
      total_ms: 210_000,
      slowest: 'running',
      slowest_ms: 150_000,
      anima_start: 'queued',
      character_id: CID,
      text: 'Sending signal to World 123456…',
    });
    expect(out).toEqual({
      outcome: 'failed',
      failure: 'timeout',
      trigger: 'first_link',
      reduced_motion: false,
      lines_shown: 7,
      line_1_ms: 2800,
      line_7_ms: 30 * 60_000,
      total_ms: 210_000,
      slowest: 'running',
      slowest_ms: 150_000,
      anima_start: 'queued',
    });
  });

  it('falls back on junk', () => {
    const out = sanitizeSeilinkIntroTrack(SEILINK_INTRO_LINK_EVENT, { outcome: 'great', failure: 'gremlins', slowest: 'nope', slowest_ms: 5, lines_shown: 40 });
    expect(out).toEqual({ outcome: 'abandoned', trigger: 'first_link', reduced_motion: false, lines_shown: 9 });
  });
});

describe('seilink_tour', () => {
  it('keeps action, audience, offer number, snooze and step', () => {
    expect(sanitizeSeilinkIntroTrack(SEILINK_TOUR_EVENT, { action: 'not_now', audience: 'existing', offer_n: 1, snoozed: true, extra: 'x' })).toEqual({
      action: 'not_now',
      audience: 'existing',
      offer_n: 1,
      snoozed: true,
    });
    expect(sanitizeSeilinkIntroTrack(SEILINK_TOUR_EVENT, { action: 'dropped', audience: 'new', offer_n: 2, step: 'button' })).toEqual({
      action: 'dropped',
      audience: 'new',
      offer_n: 2,
      step: 'button',
    });
  });

  it('drops a bad step and caps the offer number', () => {
    const out = sanitizeSeilinkIntroTrack(SEILINK_TOUR_EVENT, { action: 'sure', audience: 'x', offer_n: 4000, step: 'settings' });
    expect(out).toEqual({ action: 'sure', audience: 'existing', offer_n: 9 });
  });
});

describe('seilink_entry', () => {
  it('records the source of every entry click', () => {
    for (const source of ENTRY_SOURCES) {
      expect(sanitizeSeilinkIntroTrack(SEILINK_ENTRY_EVENT, { character_id: CID, source, action: 'sheet' })).toEqual({
        character_id: CID,
        source,
        action: 'sheet',
      });
    }
    expect(sanitizeSeilinkIntroTrack(SEILINK_ENTRY_EVENT, { source: 'labs', action: 'toggle' })).toMatchObject({ source: 'button', action: 'sheet' });
  });
});

describe('how the person entered, on the older SeiLink events', () => {
  it('the move-in sheet keeps an entry source', () => {
    const out = sanitizeSeilinkTrack('seilink_movein_sheet', { action: 'shown', reason: 'first_room', entry: 'button' });
    expect(out.entry).toBe('button');
    expect(sanitizeSeilinkTrack('seilink_movein_sheet', { action: 'shown', entry: 'settings' })).not.toHaveProperty('entry');
  });

  it('the editor knows the new entry points', () => {
    expect(EDITOR_OPENED_FROM).toEqual(expect.arrayContaining(['button', 'tour', 'gear', 'dock']));
    expect(sanitizeSeilinkTrack('seilink_editor_error', { kind: 'load_failed', opened_from: 'tour' }).opened_from).toBe('tour');
  });
});

describe('the guided setup (261106)', () => {
  it('seilink_setup keeps the closed shape', () => {
    expect(isSeilinkIntroEvent(SEILINK_SETUP_EVENT)).toBe(true);
    const out = sanitizeSeilinkIntroTrack(SEILINK_SETUP_EVENT, {
      character_id: CID,
      action: 'abandoned',
      step: 'furniture',
      surface: 'desktop',
      plain: false,
      steps_completed: 2,
      steps_skipped: 1,
      steps_total: 4,
      ms_open: 42_000,
      opened_from: 'offer',
      name: 'Sui',
    });
    expect(out).toEqual({
      character_id: CID,
      action: 'abandoned',
      step: 'furniture',
      surface: 'desktop',
      plain: false,
      steps_completed: 2,
      steps_skipped: 1,
      steps_total: 4,
      ms_open: 42_000,
      opened_from: 'offer',
    });
  });

  it('seilink_setup falls back on junk', () => {
    const out = sanitizeSeilinkIntroTrack(SEILINK_SETUP_EVENT, { action: 'nope', step: 'attic', plain: 'yes', steps_total: -1, opened_from: 'email' });
    expect(out.action).toBe('started');
    expect(out.plain).toBe(false);
    expect(out.step ?? null).toBeNull();
    expect(out).not.toHaveProperty('steps_total');
    expect(out).not.toHaveProperty('opened_from');
  });

  it('seilink_setup_step keeps the closed shape', () => {
    expect(isSeilinkIntroEvent(SEILINK_SETUP_STEP_EVENT)).toBe(true);
    expect(sanitizeSeilinkIntroTrack(SEILINK_SETUP_STEP_EVENT, { character_id: CID, step: 'colours', action: 'skipped', resumed: true, changed: false, index: 1, hex: '#fff' })).toEqual({
      character_id: CID,
      step: 'colours',
      action: 'skipped',
      resumed: true,
      changed: false,
      index: 1,
    });
    const junk = sanitizeSeilinkIntroTrack(SEILINK_SETUP_STEP_EVENT, { step: 'x', action: 'y', changed: 'no' });
    expect(junk).toMatchObject({ step: 'room', action: 'shown', resumed: false });
    expect(junk).not.toHaveProperty('changed');
  });

  it('seilink_setup_step carries the login step answer (261107), and only there', () => {
    expect(sanitizeSeilinkIntroTrack(SEILINK_SETUP_STEP_EVENT, { character_id: CID, step: 'login', action: 'completed', resumed: false, enabled: true, kept_default: true, ok: true, path: '/x' })).toEqual({
      character_id: CID,
      step: 'login',
      action: 'completed',
      resumed: false,
      enabled: true,
      kept_default: true,
      ok: true,
    });
    expect(sanitizeSeilinkIntroTrack(SEILINK_SETUP_STEP_EVENT, { step: 'login', action: 'closed' })).toMatchObject({ step: 'login', action: 'closed' });
    expect(sanitizeSeilinkIntroTrack(SEILINK_SETUP_STEP_EVENT, { step: 'room', action: 'completed', enabled: true, kept_default: false })).not.toHaveProperty('enabled');
  });

  it('opened_from matches the editor session list', () => {
    expect([...SETUP_OPENED_FROM]).toEqual([...EDITOR_OPENED_FROM]);
  });
});
