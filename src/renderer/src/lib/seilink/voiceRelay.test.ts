import { describe, expect, it } from 'vitest';
import type { SeilinkHostStatus } from '@shared/seilinkHost';
import { desktopResident, residentSpeaking } from './voiceRelay';
import { relaysLevelFor, setAvatarLevelTapEnabled, setDesktopLevelResident } from '../voice/avatarLevelTap';

const status = (state: SeilinkHostStatus['state'], characterId: string | null): SeilinkHostStatus => ({
  state,
  characterId,
  covered: false,
  paused: false,
  fps: 30,
});

describe('desktopResident (261110)', () => {
  it('is her id while her room is up or coming up', () => {
    expect(desktopResident(status('running', 'sui'))).toBe('sui');
    expect(desktopResident(status('starting', 'sui'))).toBe('sui');
    expect(desktopResident(status('restarting', 'sui'))).toBe('sui');
  });

  it('is null when off, failed or unknown', () => {
    expect(desktopResident(status('off', null))).toBeNull();
    expect(desktopResident(status('failed', 'sui'))).toBeNull();
    expect(desktopResident(null)).toBeNull();
  });
});

describe('residentSpeaking (261110)', () => {
  it('only her own voice moves her mouth', () => {
    expect(residentSpeaking('sui', 'sui')).toBe(true);
    expect(residentSpeaking('sui', 'lyra')).toBe(false);
    expect(residentSpeaking('sui', null)).toBe(false);
    expect(residentSpeaking(null, null)).toBe(false);
  });
});

describe('relaysLevelFor (261110)', () => {
  it("relays the desktop resident's clips without the overlay tap", () => {
    setAvatarLevelTapEnabled(false);
    setDesktopLevelResident('sui');
    expect(relaysLevelFor('sui')).toBe(true);
    expect(relaysLevelFor('lyra')).toBe(false);
    setDesktopLevelResident(null);
    expect(relaysLevelFor('sui')).toBe(false);
  });

  it('the overlay tap still relays everyone', () => {
    setAvatarLevelTapEnabled(true);
    expect(relaysLevelFor('lyra')).toBe(true);
    setAvatarLevelTapEnabled(false);
  });
});
