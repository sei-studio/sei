/** Stardew appearance (260921): the one-off derivation with a stubbed LLM. */
import { describe, it, expect, vi } from 'vitest';
import {
  appearanceForSummon,
  clearAppearance,
  gatherAppearanceText,
  getOrDeriveAppearance,
  readStoredAppearance,
  type AppearanceDeps,
} from './appearance';
import {
  STARDEW_DEFAULT_APPEARANCE,
  STARDEW_HAIR_LEGEND,
  STARDEW_SHIRT_LEGEND,
  StardewAppearanceSchema,
  coerceStardewAppearance,
} from '../../../shared/stardewAppearance';
import { UserConfigSchema, type UserConfig } from '../../../shared/characterSchema';

const LYRA = {
  gender: 'female',
  skin: 23,
  hair: 26,
  hairColor: '#C0C8FF',
  eyeColor: '#6a4cff',
  shirt: 1016,
  pants: 2,
  pantsColor: '#1b1b3a',
  accessory: -1,
};

function deps(overrides: Partial<AppearanceDeps> = {}, initial: Partial<UserConfig> = {}): AppearanceDeps & { cfg: UserConfig } {
  const state = { cfg: initial as UserConfig };
  return {
    get cfg() {
      return state.cfg;
    },
    getCharacter: async () => ({
      name: 'Lyra',
      description: 'A stargazer with waist-length silver hair.',
      persona: { source: 'Quiet astronomer in a midnight dress.', expanded: 'LONG RULES' },
      metadata: {},
    }),
    loadConfig: async () => state.cfg,
    updateConfig: async (mutate) => {
      state.cfg = mutate(state.cfg);
      return state.cfg;
    },
    derive: async () => LYRA,
    log: () => {},
    ...overrides,
  } as AppearanceDeps & { cfg: UserConfig };
}

describe('the shared legend', () => {
  it('has a valid default and no duplicate ids', () => {
    expect(StardewAppearanceSchema.safeParse(STARDEW_DEFAULT_APPEARANCE).success).toBe(true);
    for (const legend of [STARDEW_HAIR_LEGEND, STARDEW_SHIRT_LEGEND]) {
      const ids = legend.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('stays inside what the game accepts (1.6.15: hair 0..55 + 100..122, creator shirts 1000..1111)', () => {
    for (const { id } of STARDEW_HAIR_LEGEND) expect((id >= 0 && id <= 55) || (id >= 100 && id <= 122)).toBe(true);
    for (const { id } of STARDEW_SHIRT_LEGEND) expect(id >= 1000 && id <= 1111).toBe(true);
  });

  it('has no em dash in any legend line (the lines are model-facing, but keep the house style)', () => {
    for (const row of [...STARDEW_HAIR_LEGEND, ...STARDEW_SHIRT_LEGEND]) expect(row.look).not.toMatch(/—/);
  });

  it('salvages field by field: a bad field takes the default, the rest survive', () => {
    const { appearance, salvaged } = coerceStardewAppearance({ ...LYRA, shirt: 4242, hair: '26', eyeColor: 'purple' });
    expect(salvaged).toBe(7);
    expect(appearance.shirt).toBe(STARDEW_DEFAULT_APPEARANCE.shirt);
    expect(appearance.eyeColor).toBe(STARDEW_DEFAULT_APPEARANCE.eyeColor);
    expect(appearance.hair).toBe(26);
    expect(appearance.hairColor).toBe('#c0c8ff');
    expect(coerceStardewAppearance(null).salvaged).toBe(0);
  });
});

describe('gatherAppearanceText', () => {
  it('leads with the soulcaster sheet, then the description, and prefers the persona source over the expansion', () => {
    const text = gatherAppearanceText({
      name: 'Anaya',
      description: 'A wolf-eared ranger.',
      persona: { source: 'Gruff but kind.', expanded: 'LONG RULES' },
      metadata: {
        soulcaster_sheet: {
          gender: 'female',
          background: 'beastkin',
          appearance: { hair: 'short grey hair', eyes: 'amber', outfit: 'green cloak', accessories: ['round glasses'] },
          image_prompt: 'a wolf-eared woman in a green cloak',
        },
      },
    } as never);
    expect(text.indexOf('Hair: short grey hair')).toBeLessThan(text.indexOf('Description:'));
    expect(text).toContain('Accessories: round glasses');
    expect(text).toContain('Persona: Gruff but kind.');
    expect(text).not.toContain('LONG RULES');
  });

  it('falls back to the expanded persona and returns empty when there is nothing', () => {
    expect(gatherAppearanceText({ name: 'X', description: '', persona: { source: '', expanded: 'Tall.' }, metadata: {} } as never)).toBe('Persona: Tall.');
    expect(gatherAppearanceText({ name: 'X', description: '', persona: { source: '', expanded: '' }, metadata: {} } as never)).toBe('');
  });
});

describe('getOrDeriveAppearance', () => {
  it('derives once, persists sparse in a shape the config schema accepts, and reads the stored row afterwards', async () => {
    const derive = vi.fn(async (args: { name: string; text: string }) => {
      expect(args.name).toBe('Lyra');
      expect(args.text).toContain('waist-length silver hair');
      return LYRA;
    });
    const d = deps({ derive });
    const first = await getOrDeriveAppearance('c1', d);
    expect(first).toEqual({ appearance: { ...LYRA, hairColor: '#c0c8ff' }, source: 'auto' });
    expect(d.cfg.stardew_appearance).toEqual({ c1: { ...LYRA, hairColor: '#c0c8ff', source: 'auto' } });
    expect(UserConfigSchema.shape.stardew_appearance.safeParse(d.cfg.stardew_appearance).success).toBe(true);
    expect(await getOrDeriveAppearance('c1', d)).toEqual(first);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('never throws and never persists a failure, so the next summon tries again', async () => {
    const boom = deps({ derive: async () => { throw new Error('boom'); } });
    expect(await getOrDeriveAppearance('c1', boom)).toEqual({ appearance: STARDEW_DEFAULT_APPEARANCE, source: 'default' });
    expect(boom.cfg.stardew_appearance).toBeUndefined();

    const junk = deps({ derive: async () => ({ gender: 'robot', skin: 99 }) });
    expect((await getOrDeriveAppearance('c1', junk)).source).toBe('default');
    expect(junk.cfg.stardew_appearance).toBeUndefined();

    expect((await getOrDeriveAppearance('c1', deps({ derive: async () => null }))).source).toBe('default');
    expect((await getOrDeriveAppearance('c1', deps({ getCharacter: async () => null }))).source).toBe('default');
  });

  it('joins a derivation already in flight instead of paying for a second call', async () => {
    let release: (v: unknown) => void = () => {};
    const derive = vi.fn(() => new Promise<unknown>((r) => { release = r; }));
    const d = deps({ derive });
    const a = getOrDeriveAppearance('c1', d);
    const b = getOrDeriveAppearance('c1', d);
    await new Promise((r) => setTimeout(r, 0));
    release(LYRA);
    expect(await a).toEqual(await b);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('re-derives a stored row that no longer validates, and clearAppearance forgets one', async () => {
    const stale = { c1: { ...LYRA, hair: 2, source: 'auto' as const } }; // 2 is a real hairstyle with no legend line
    const d = deps({}, { stardew_appearance: stale } as Partial<UserConfig>);
    expect(readStoredAppearance(d.cfg, 'c1')).toBeNull();
    expect((await getOrDeriveAppearance('c1', d)).appearance.hair).toBe(26);
    await clearAppearance('c1', d);
    expect(d.cfg.stardew_appearance).toBeUndefined();
  });

  it('keeps a user-sourced row as it is', async () => {
    const d = deps({ derive: async () => { throw new Error('must not be called'); } }, {
      stardew_appearance: { c1: { ...LYRA, hairColor: '#c0c8ff', source: 'user' } },
    } as Partial<UserConfig>);
    expect((await getOrDeriveAppearance('c1', d)).source).toBe('user');
  });
});

describe('appearanceForSummon', () => {
  it('ships the default when the derivation outlasts the wait, and the derivation still lands for next time', async () => {
    let release: (v: unknown) => void = () => {};
    const d = deps({ derive: () => new Promise<unknown>((r) => { release = r; }) });
    const shipped = await appearanceForSummon('slow', { waitMs: 20, deps: d });
    expect(shipped).toEqual({ appearance: STARDEW_DEFAULT_APPEARANCE, source: 'default' });
    release(LYRA);
    await new Promise((r) => setTimeout(r, 10));
    expect(d.cfg.stardew_appearance?.slow?.hair).toBe(26);
    expect((await appearanceForSummon('slow', { waitMs: 20, deps: d })).source).toBe('auto');
  });

  it('returns a stored look without waiting on anything', async () => {
    const d = deps({ derive: async () => { throw new Error('must not be called'); } }, {
      stardew_appearance: { c1: { ...LYRA, hairColor: '#c0c8ff', source: 'auto' } },
    } as Partial<UserConfig>);
    expect((await appearanceForSummon('c1', { waitMs: 5, deps: d })).appearance.shirt).toBe(1016);
  });
});
