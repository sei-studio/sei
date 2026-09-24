/** Game-adapters M2 (260908): the one-off survivor pick with a stubbed LLM. */
import { describe, it, expect, vi } from 'vitest';
import { getOrPickSurvivor, setSurvivor, readStoredPick, type SurvivorPickDeps } from './survivorPick';
import type { UserConfig } from '../../../shared/characterSchema';

function deps(overrides: Partial<SurvivorPickDeps> = {}, initial: Partial<UserConfig> = {}): SurvivorPickDeps & { cfg: UserConfig } {
  const state = { cfg: initial as UserConfig };
  const d: SurvivorPickDeps & { cfg: UserConfig } = {
    get cfg() {
      return state.cfg;
    },
    getCharacter: async () => ({ name: 'Marv', persona: { expanded: 'A loud warrior who eats only steak and sings.' } }),
    loadConfig: async () => state.cfg,
    updateConfig: async (mutate) => {
      state.cfg = mutate(state.cfg);
      return state.cfg;
    },
    pick: async () => ({ prefab: 'wigfrid', reason: 'Meat, songs, and a good fight. Obviously.' }),
    log: () => {},
    ...overrides,
  };
  return d;
}

describe('getOrPickSurvivor', () => {
  it('derives once from the persona + roster, persists sparse, and reads the stored pick afterwards', async () => {
    const pick = vi.fn(async (args: { name: string; persona: string; roster: string }) => {
      expect(args.name).toBe('Marv');
      expect(args.roster).toMatch(/^- wilson \(Wilson\)/m);
      expect(args.roster).toMatch(/wigfrid \(Wigfrid\) health 200, hunger 120, sanity 120/);
      return { prefab: 'Wigfrid ', reason: 'Meat.' };
    });
    const d = deps({ pick });
    expect(await getOrPickSurvivor('c1', d)).toEqual({ prefab: 'wigfrid', source: 'auto', reason: 'Meat.' });
    expect(d.cfg.dst_survivor).toEqual({ c1: { prefab: 'wigfrid', source: 'auto', reason: 'Meat.' } });
    expect(await getOrPickSurvivor('c1', d)).toEqual({ prefab: 'wigfrid', source: 'auto', reason: 'Meat.' });
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('falls back to Wilson when the LLM fails, returns an ineligible prefab, or the character is gone', async () => {
    expect(await getOrPickSurvivor('c1', deps({ pick: async () => { throw new Error('boom'); } }))).toEqual({ prefab: 'wilson', source: 'auto', reason: '' });
    expect(await getOrPickSurvivor('c1', deps({ pick: async () => ({ prefab: 'wes', reason: 'mime' }) }))).toMatchObject({ prefab: 'wilson' });
    expect(await getOrPickSurvivor('c1', deps({ getCharacter: async () => null }))).toMatchObject({ prefab: 'wilson' });
  });

  it('re-derives a stored pick whose prefab is no longer eligible', async () => {
    const d = deps({}, { dst_survivor: { c1: { prefab: 'woodie', source: 'auto' } } } as Partial<UserConfig>);
    expect(readStoredPick(d.cfg, 'c1')).toBeNull();
    expect(await getOrPickSurvivor('c1', d)).toMatchObject({ prefab: 'wigfrid' });
  });
});

describe('setSurvivor', () => {
  it('records a user override, rejects junk, and null forgets it so the character picks again', async () => {
    const pick = vi.fn(async () => ({ prefab: 'wortox', reason: 'Souls!' }));
    const d = deps({ pick });
    expect(await setSurvivor('c1', 'wurt', d)).toEqual({ prefab: 'wurt', source: 'user', reason: '' });
    expect(await getOrPickSurvivor('c1', d)).toEqual({ prefab: 'wurt', source: 'user', reason: '' });
    await expect(setSurvivor('c1', 'wonkey', d)).rejects.toThrow(/not an eligible survivor/);
    expect(await setSurvivor('c1', null, d)).toEqual({ prefab: 'wortox', source: 'auto', reason: 'Souls!' });
    expect(pick).toHaveBeenCalledTimes(1);
    // Forgetting the last entry drops the map entirely (sparse: absent == none).
    await setSurvivor('c1', null, deps({ pick: async () => { throw new Error('no'); } }, { dst_survivor: { c1: { prefab: 'wurt', source: 'user' } } } as Partial<UserConfig>));
  });
});
