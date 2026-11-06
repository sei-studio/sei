import { describe, expect, it } from 'vitest';
import { defaultRoomState } from '@shared/seilinkRoom';
import { SETUP_COPY, SETUP_PANEL, markDone, nextStep, opensGuided, prevStep, resumeStep, setupSteps, withoutSetup } from './roomSetup';

describe('guided room setup helpers', () => {
  const all = setupSteps({ fabrics: true, furniture: true, items: true });

  it('lists the steps in order and leaves out what the room has nothing for', () => {
    expect(all).toEqual(['room', 'colours', 'furniture', 'extras']);
    expect(setupSteps({ fabrics: false, furniture: true, items: false })).toEqual(['room', 'furniture']);
    expect(setupSteps({ fabrics: false, furniture: false, items: false })).toEqual(['room']);
  });

  it('maps every step to a panel and gives it copy without em dashes', () => {
    for (const s of all) {
      expect(SETUP_PANEL[s]).toBeTruthy();
      expect(SETUP_COPY[s].title).not.toContain('—');
      expect(SETUP_COPY[s].hint).not.toContain('—');
    }
  });

  it('opens guided while she is plain or a run is unfinished, else the normal editor', () => {
    expect(opensGuided({ plain: true })).toBe(true);
    expect(opensGuided({ setup: { done: ['room'] } })).toBe(true);
    expect(opensGuided({})).toBe(false);
    expect(opensGuided(null)).toBe(false);
  });

  it('resumes at the first step not done (the room step while plain)', () => {
    expect(resumeStep(all, [], false)).toBe('room');
    expect(resumeStep(all, ['room'], false)).toBe('colours');
    expect(resumeStep(all, ['room', 'furniture'], false)).toBe('colours');
    expect(resumeStep(all, ['room', 'colours', 'furniture', 'extras'], false)).toBe('extras');
    expect(resumeStep(all, ['room', 'colours'], true)).toBe('room');
  });

  it('steps forward and back within the list', () => {
    expect(nextStep(all, 'room')).toBe('colours');
    expect(nextStep(all, 'extras')).toBeNull();
    expect(prevStep(all, 'room')).toBeNull();
    expect(prevStep(all, 'furniture')).toBe('colours');
    expect(nextStep(['room', 'furniture'], 'room')).toBe('furniture');
  });

  it('marks steps done in step order, once', () => {
    expect(markDone(['furniture'], 'room')).toEqual(['room', 'furniture']);
    expect(markDone(['room'], 'room')).toEqual(['room']);
  });

  it('drops the setup marker and keeps the rest', () => {
    const s = { ...defaultRoomState('cozy'), setup: { done: ['room' as const] } };
    expect(withoutSetup(s)).toEqual(defaultRoomState('cozy'));
    const plain = defaultRoomState('cozy');
    expect(withoutSetup(plain)).toBe(plain);
  });
});
