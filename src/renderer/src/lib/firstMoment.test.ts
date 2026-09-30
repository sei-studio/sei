/**
 * The guided first moment's pure trigger rules (260926): who gets it, which
 * game leads, and which buttons the card shows.
 */
import { describe, it, expect } from 'vitest';
import { firstMomentButtons, firstMomentCompanion, planFirstMoment } from './firstMoment';

const SUI = 'sui-uuid';

describe('firstMomentCompanion', () => {
  it('returning sign-ins never get it (tutorial:false), with or without a companion', () => {
    expect(firstMomentCompanion({ tutorial: false, characterId: null }, SUI)).toBeNull();
    expect(firstMomentCompanion({ tutorial: false, characterId: 'gen-1' }, SUI)).toBeNull();
  });

  it('a new player with a generated companion gets that companion', () => {
    expect(firstMomentCompanion({ tutorial: true, characterId: 'gen-1' }, SUI)).toBe('gen-1');
  });

  it('a new player whose generation was skipped or failed gets Sui', () => {
    expect(firstMomentCompanion({ tutorial: true, characterId: null }, SUI)).toBe(SUI);
  });
});

describe('planFirstMoment', () => {
  it('chess leads and Minecraft is hidden when there is no Minecraft at all', () => {
    expect(planFirstMoment({ lanOpen: false, mcInstalled: false })).toEqual({ primary: 'chess', minecraft: false });
  });

  it('an installed Minecraft is offered second, chess still leads', () => {
    expect(planFirstMoment({ lanOpen: false, mcInstalled: true })).toEqual({ primary: 'chess', minecraft: true });
  });

  it('an open LAN world makes Minecraft the lead, even when the install probe missed it', () => {
    expect(planFirstMoment({ lanOpen: true, mcInstalled: false })).toEqual({ primary: 'minecraft', minecraft: true });
    expect(planFirstMoment({ lanOpen: true, mcInstalled: true })).toEqual({ primary: 'minecraft', minecraft: true });
  });
});

describe('firstMomentButtons', () => {
  it('chess only, then the call', () => {
    expect(firstMomentButtons({ primary: 'chess', minecraft: false })).toEqual(['chess', 'call']);
  });

  it('chess first, Minecraft second, then the call', () => {
    expect(firstMomentButtons({ primary: 'chess', minecraft: true })).toEqual(['chess', 'minecraft', 'call']);
  });

  it('Minecraft first when it leads', () => {
    expect(firstMomentButtons({ primary: 'minecraft', minecraft: true })).toEqual(['minecraft', 'chess', 'call']);
  });

  it('the call is always offered and always last', () => {
    for (const plan of [
      { primary: 'chess' as const, minecraft: false },
      { primary: 'chess' as const, minecraft: true },
      { primary: 'minecraft' as const, minecraft: true },
    ]) {
      const b = firstMomentButtons(plan);
      expect(b[b.length - 1]).toBe('call');
      expect(b[0]).toBe(plan.primary);
    }
  });
});
