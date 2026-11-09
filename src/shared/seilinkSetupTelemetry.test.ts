import { describe, expect, it } from 'vitest';
import { isSeilinkSetupEvent, sanitizeSeilinkSetupTrack } from './seilinkSetupTelemetry';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('seilinkSetupTelemetry (261110)', () => {
  it('owns its four events only', () => {
    for (const e of ['seilink_setup_call', 'seilink_live_hint', 'seilink_minimize_windows', 'seilink_placement_guide']) expect(isSeilinkSetupEvent(e)).toBe(true);
    expect(isSeilinkSetupEvent('seilink_setup')).toBe(false);
  });
  it('keeps closed shapes and drops anything else', () => {
    expect(sanitizeSeilinkSetupTrack('seilink_setup_call', { character_id: ID, outcome: 'started', guided: true, gate: 'ready', text: 'hi' })).toEqual({
      character_id: ID,
      outcome: 'started',
      guided: true,
      gate: 'ready',
    });
    expect(sanitizeSeilinkSetupTrack('seilink_setup_call', { character_id: 'me@x.com', outcome: 'whatever' })).toEqual({ character_id: null, outcome: 'error', guided: false });
    expect(sanitizeSeilinkSetupTrack('seilink_live_hint', { character_id: ID, action: 'dismissed', surface: 'app_window', os: 'windows', path: 'C:/x' })).toEqual({
      character_id: ID,
      action: 'dismissed',
      surface: 'app_window',
      os: 'windows',
    });
    expect(sanitizeSeilinkSetupTrack('seilink_minimize_windows', { outcome: 'ok', windows: 400, surface: 'live_card', os: 'mac', titles: ['a'] })).toEqual({
      outcome: 'ok',
      windows: 50,
      surface: 'live_card',
      os: 'mac',
    });
    expect(sanitizeSeilinkSetupTrack('seilink_placement_guide', { cls: 'surface', placed: true, x: 3 })).toEqual({ mode: 'outline', cls: 'surface', placed: true });
    expect(sanitizeSeilinkSetupTrack('other', { a: 1 })).toEqual({});
  });
});
