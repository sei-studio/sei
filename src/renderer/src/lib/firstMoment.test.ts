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
  const env = (o: Partial<{ lanOpen: boolean; mcInstalled: boolean; backseatOk: boolean }>) => ({
    lanOpen: false,
    mcInstalled: false,
    backseatOk: true,
    ...o,
  });

  it('Backseat leads and Minecraft is hidden when there is no Minecraft at all', () => {
    expect(planFirstMoment(env({}))).toEqual({ primary: 'backseat', minecraft: false, backseat: true });
  });

  it('an installed Minecraft is offered, Backseat still leads', () => {
    expect(planFirstMoment(env({ mcInstalled: true }))).toEqual({ primary: 'backseat', minecraft: true, backseat: true });
  });

  it('an open LAN world makes Minecraft the lead, even when the install probe missed it', () => {
    expect(planFirstMoment(env({ lanOpen: true }))).toEqual({ primary: 'minecraft', minecraft: true, backseat: true });
    expect(planFirstMoment(env({ lanOpen: true, mcInstalled: true }))).toEqual({
      primary: 'minecraft',
      minecraft: true,
      backseat: true,
    });
  });

  it('a model that cannot see images drops Backseat and chess leads', () => {
    expect(planFirstMoment(env({ backseatOk: false }))).toEqual({ primary: 'chess', minecraft: false, backseat: false });
    expect(planFirstMoment(env({ backseatOk: false, mcInstalled: true }))).toEqual({
      primary: 'chess',
      minecraft: true,
      backseat: false,
    });
    expect(planFirstMoment(env({ backseatOk: false, lanOpen: true }))).toEqual({
      primary: 'minecraft',
      minecraft: true,
      backseat: false,
    });
  });
});

describe('firstMomentButtons', () => {
  it('Backseat first, then chess, then the call', () => {
    expect(firstMomentButtons({ primary: 'backseat', minecraft: false, backseat: true })).toEqual([
      'backseat',
      'chess',
      'call',
    ]);
  });

  it('Backseat first, Minecraft second when installed', () => {
    expect(firstMomentButtons({ primary: 'backseat', minecraft: true, backseat: true })).toEqual([
      'backseat',
      'minecraft',
      'chess',
      'call',
    ]);
  });

  it('Minecraft first when it leads, Backseat next', () => {
    expect(firstMomentButtons({ primary: 'minecraft', minecraft: true, backseat: true })).toEqual([
      'minecraft',
      'backseat',
      'chess',
      'call',
    ]);
  });

  it('without Backseat: chess only, or chess then Minecraft', () => {
    expect(firstMomentButtons({ primary: 'chess', minecraft: false, backseat: false })).toEqual(['chess', 'call']);
    expect(firstMomentButtons({ primary: 'chess', minecraft: true, backseat: false })).toEqual([
      'chess',
      'minecraft',
      'call',
    ]);
    expect(firstMomentButtons({ primary: 'minecraft', minecraft: true, backseat: false })).toEqual([
      'minecraft',
      'chess',
      'call',
    ]);
  });

  it('the primary leads, nothing repeats, chess and the call are always offered and the call is last', () => {
    for (const lanOpen of [false, true])
      for (const mcInstalled of [false, true])
        for (const backseatOk of [false, true]) {
          const plan = planFirstMoment({ lanOpen, mcInstalled, backseatOk });
          const b = firstMomentButtons(plan);
          expect(b[0]).toBe(plan.primary);
          expect(b[b.length - 1]).toBe('call');
          expect(b).toContain('chess');
          expect(new Set(b).size).toBe(b.length);
          expect(b.includes('backseat')).toBe(plan.backseat);
          expect(b.includes('minecraft')).toBe(plan.minecraft);
        }
  });
});




