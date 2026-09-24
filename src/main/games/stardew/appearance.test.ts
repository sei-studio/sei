/** Stardew appearance (260921): the one-off derivation with a stubbed LLM. */
import { describe, it, expect, vi } from 'vitest';
import {
  APPEARANCE_CLOUD_WAIT_WITH_LOCAL_MS,
  APPEARANCE_SUMMON_WAIT_MS,
  appearanceForSummon,
  buildAppearanceMessage,
  clearAppearance,
  gatherAppearanceText,
  getOrDeriveAppearance,
  readStoredAppearance,
  sniffImageType,
  type AppearanceDeps,
  type DeriveArgs,
} from './appearance';
import {
  STARDEW_APPEARANCE_VERSION,
  STARDEW_ACCESSORY_LEGEND,
  STARDEW_DEFAULT_APPEARANCE,
  STARDEW_HAIR_GROUPS,
  STARDEW_HAIR_LEGEND,
  STARDEW_PANTS_LEGEND,
  STARDEW_SHIRT_LEGEND,
  STARDEW_SKIN_LEGEND,
  StardewAppearanceSchema,
  coerceStardewAppearance,
  renderStardewAppearanceMenu,
} from '../../../shared/stardewAppearance';
import type { GameProfile, GameProfileRead } from '../../cloud/gameProfileClient';
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
    expect(d.cfg.stardew_appearance).toEqual({ c1: { ...LYRA, hairColor: '#c0c8ff', source: 'auto', version: STARDEW_APPEARANCE_VERSION } });
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
      stardew_appearance: { c1: { ...LYRA, hairColor: '#c0c8ff', source: 'auto', version: STARDEW_APPEARANCE_VERSION } },
    } as Partial<UserConfig>);
    expect((await appearanceForSummon('c1', { waitMs: 5, deps: d })).appearance.shirt).toBe(1016);
  });
});

// 260925, v0.6.5-beta.2 playtest: Sui came out with wild blue spikes (hair 8,
// #4a90e2) and a bright purple shirt (1046). Her default row has no
// description and no sheet, so the only text was the personality blurb; the
// portrait (long silver hair, navy coat) never reached the model.
const PNG = { mediaType: 'image/png' as const, base64: 'iVBORw0KGgo=' };
const SUI_V1 = { gender: 'female', skin: 2, hair: 8, hairColor: '#4a90e2', eyeColor: '#00ff00', shirt: 1046, pants: 1, pantsColor: '#333333', accessory: -1 };
const SUI_V2 = { gender: 'female', skin: 23, hair: 100, hairColor: '#c8c8e0', eyeColor: '#6e6a8a', shirt: 1082, pants: 2, pantsColor: '#2a3050', accessory: -1 };

function profile(data: unknown, over: Partial<GameProfile> = {}): GameProfile {
  return { characterId: 'sui', game: 'stardew', kind: 'appearance', data, source: 'auto', version: STARDEW_APPEARANCE_VERSION, ...over };
}

function suiDeps(over: Partial<AppearanceDeps> = {}, initial: Partial<UserConfig> = {}) {
  const writeCloud = vi.fn(async (a: { characterId: string; version: number; data: unknown }) => ({
    ok: true as const,
    won: true,
    profile: profile(a.data, { version: a.version }),
  }));
  const d = deps(
    {
      getCharacter: async () => ({
        name: 'Sui',
        description: null as unknown as string,
        persona: { source: 'tomboy gremlin who teases the player', expanded: '' },
        metadata: {},
        portrait_image: 'https://example.invalid/sui.png',
      }),
      readPortrait: async () => PNG,
      canSee: async () => true,
      readCloud: async (): Promise<GameProfileRead> => ({ ok: true, profile: null }),
      writeCloud,
      derive: async () => SUI_V2,
      ...over,
    },
    initial,
  );
  return { d, writeCloud };
}

describe('the menu the model picks from', () => {
  it('lists every legend option once, hair grouped by length', () => {
    const menu = renderStardewAppearanceMenu();
    for (const rows of [STARDEW_HAIR_LEGEND, STARDEW_SKIN_LEGEND, STARDEW_SHIRT_LEGEND, STARDEW_PANTS_LEGEND, STARDEW_ACCESSORY_LEGEND]) {
      for (const r of rows) expect(menu).toContain(`${r.id} = ${r.look}`);
    }
    for (const r of STARDEW_HAIR_LEGEND) expect(STARDEW_HAIR_GROUPS).toContain(r.group);
    expect(menu.indexOf('long, worn loose')).toBeGreaterThan(menu.indexOf('  short:'));
    // Long hair is not filed under short (the Sui failure).
    const shortBlock = menu.slice(menu.indexOf('  short:'), menu.indexOf('  chin to shoulder length:'));
    expect(shortBlock).toContain('8 = wild spikes');
    expect(shortBlock).not.toContain('100 = ');
  });

  it('puts the portrait first, then the character text, then the menu', () => {
    const msg = buildAppearanceMessage({ name: 'Sui', text: 'Persona: tomboy gremlin', image: PNG });
    const [img, txt] = msg.content as Array<Record<string, any>>;
    expect(img).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.base64 } });
    expect(txt.text).toMatch(/^The picture above is Sui's portrait\./);
    expect(txt.text.indexOf('<character>')).toBeLessThan(txt.text.indexOf('HAIR (field "hair")'));
    const blind = buildAppearanceMessage({ name: 'Sui', text: 'x' });
    expect(blind.content).toHaveLength(1);
    expect((blind.content[0] as { text: string }).text).toContain('There is no picture of Sui');
  });

  it('sniffs image types by magic bytes', () => {
    expect(sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<html>'))).toBeNull();
  });
});

describe('shared cloud looks + the portrait (260925)', () => {
  it('Sui: the portrait reaches the model, and the look is offered to the cloud once', async () => {
    const seen: DeriveArgs[] = [];
    const { d, writeCloud } = suiDeps({ derive: async (a) => { seen.push(a); return SUI_V2; } });
    const got = await getOrDeriveAppearance('sui', d);
    expect(seen[0].image).toEqual(PNG);
    expect(seen[0].text).toContain('tomboy gremlin');
    expect(got.appearance.hair).toBe(100);
    expect(writeCloud).toHaveBeenCalledWith({ characterId: 'sui', version: STARDEW_APPEARANCE_VERSION, data: expect.objectContaining({ hair: 100 }) });
    expect(d.cfg.stardew_appearance?.sui).toMatchObject({ hair: 100, source: 'auto', version: STARDEW_APPEARANCE_VERSION });
  });

  it('ignores the old text-only v1 row in the local config and redoes it', async () => {
    const { d, writeCloud } = suiDeps({}, { stardew_appearance: { sui: { ...SUI_V1, source: 'auto' } } } as Partial<UserConfig>);
    expect(readStoredAppearance(d.cfg, 'sui')).toBeNull();
    expect(readStoredAppearance(d.cfg, 'sui', { anyVersion: true })?.appearance.hair).toBe(8);
    expect((await getOrDeriveAppearance('sui', d)).appearance.hair).toBe(100);
    expect(writeCloud).toHaveBeenCalledTimes(1);
  });

  it('uses a current cloud row without deriving, and it replaces a different local auto copy', async () => {
    const derive = vi.fn(async () => SUI_V1);
    const { d, writeCloud } = suiDeps(
      { derive, readCloud: async () => ({ ok: true, profile: profile(SUI_V2) }) },
      { stardew_appearance: { sui: { ...SUI_V1, source: 'auto', version: STARDEW_APPEARANCE_VERSION } } } as Partial<UserConfig>,
    );
    expect((await getOrDeriveAppearance('sui', d)).appearance.hair).toBe(100);
    expect(derive).not.toHaveBeenCalled();
    expect(writeCloud).not.toHaveBeenCalled();
    expect(d.cfg.stardew_appearance?.sui?.hair).toBe(100);
  });

  it('redoes an outdated cloud auto row, but keeps the owner\'s cloud edit whatever its version', async () => {
    const stale = suiDeps({ readCloud: async () => ({ ok: true, profile: profile(SUI_V1, { version: 1 }) }) });
    expect((await getOrDeriveAppearance('sui', stale.d)).appearance.hair).toBe(100);
    expect(stale.writeCloud).toHaveBeenCalledTimes(1);

    const edited = suiDeps({ readCloud: async () => ({ ok: true, profile: profile(SUI_V1, { version: 1, source: 'user' }) }) });
    const got = await getOrDeriveAppearance('sui', edited.d);
    expect(got).toMatchObject({ source: 'user', appearance: { hair: 8 } });
    expect(edited.writeCloud).not.toHaveBeenCalled();
  });

  it('first write wins: a client that lost the race uses the stored look', async () => {
    const { d } = suiDeps({
      derive: async () => SUI_V1,
      writeCloud: async () => ({ ok: true, won: false, profile: profile(SUI_V2) }),
    });
    expect((await getOrDeriveAppearance('sui', d)).appearance.hair).toBe(100);
    expect(d.cfg.stardew_appearance?.sui?.hair).toBe(100);
  });

  it('a look guessed without seeing existing art stays local', async () => {
    const seen: DeriveArgs[] = [];
    const { d, writeCloud } = suiDeps({ canSee: async () => false, derive: async (a) => { seen.push(a); return SUI_V1; } });
    expect((await getOrDeriveAppearance('sui', d)).appearance.hair).toBe(8);
    expect(seen[0].image).toBeNull();
    expect(writeCloud).not.toHaveBeenCalled();
    expect(d.cfg.stardew_appearance?.sui?.hair).toBe(8);
  });

  it('a character with no art at all shares its text-only look', async () => {
    const { d, writeCloud } = suiDeps({
      getCharacter: async () => ({
        name: 'Sui',
        description: 'long silver hair, navy coat',
        persona: { source: 'tomboy gremlin', expanded: '' },
        metadata: {},
        portrait_image: null,
      }),
      readPortrait: async () => null,
      canSee: async () => false,
    });
    await getOrDeriveAppearance('sui', d);
    expect(writeCloud).toHaveBeenCalledTimes(1);
  });

  it('a portrait ref whose file cannot be read (not cached yet, too big) still keeps a text guess local', async () => {
    const seen: DeriveArgs[] = [];
    const { d, writeCloud } = suiDeps({
      readPortrait: async () => null,
      canSee: async () => true,
      derive: async (a) => { seen.push(a); return SUI_V1; },
    });
    expect((await getOrDeriveAppearance('sui', d)).appearance.hair).toBe(8);
    expect(seen[0].image).toBeNull();
    expect(writeCloud).not.toHaveBeenCalled();
    expect(d.cfg.stardew_appearance?.sui?.hair).toBe(8);
  });

  it('this user\'s own override beats the cloud row', async () => {
    const { d } = suiDeps(
      { readCloud: async () => ({ ok: true, profile: profile(SUI_V2) }) },
      { stardew_appearance: { sui: { ...SUI_V1, source: 'user' } } } as Partial<UserConfig>,
    );
    expect(await getOrDeriveAppearance('sui', d)).toMatchObject({ source: 'user', appearance: { hair: 8 } });
    // ...and a cloud read never overwrites it.
    expect(d.cfg.stardew_appearance?.sui?.source).toBe('user');
  });

  it('offline or not deployed: a current local copy is used, and a failed write keeps the look locally', async () => {
    const offline = suiDeps(
      { readCloud: async () => ({ ok: false, reason: 'relation "character_game_profiles" does not exist' }) },
      { stardew_appearance: { sui: { ...SUI_V2, source: 'auto', version: STARDEW_APPEARANCE_VERSION } } } as Partial<UserConfig>,
    );
    expect((await getOrDeriveAppearance('sui', offline.d)).appearance.hair).toBe(100);
    expect(offline.writeCloud).not.toHaveBeenCalled();

    const noRoute = suiDeps({
      readCloud: async () => ({ ok: false, reason: 'offline' }),
      writeCloud: vi.fn(async () => ({ ok: false as const, reason: 'http_404' })),
    });
    expect((await getOrDeriveAppearance('sui', noRoute.d)).appearance.hair).toBe(100);
    expect(noRoute.d.cfg.stardew_appearance?.sui).toMatchObject({ hair: 100, version: STARDEW_APPEARANCE_VERSION });
  });
});

// Review finding (260925): the cloud read may take up to its 5 s timeout and a
// summon waits 6 s in total, so a slow network could push a summon onto the
// default look while a good local copy sat on disk. Each test uses its own
// character id so a stuck single-flight in one cannot leak into the next.
describe('slow cloud reads (260925)', () => {
  const currentLocal = (id: string) =>
    ({ stardew_appearance: { [id]: { ...SUI_V2, source: 'auto', version: STARDEW_APPEARANCE_VERSION } } }) as Partial<UserConfig>;

  it('a current local copy ships once the cloud cap passes, and the late cloud row refreshes the cache', async () => {
    vi.useFakeTimers();
    try {
      let answer: (r: GameProfileRead) => void = () => {};
      const derive = vi.fn(async () => SUI_V1);
      const { d, writeCloud } = suiDeps(
        { derive, readCloud: () => new Promise<GameProfileRead>((r) => { answer = r; }) },
        currentLocal('sui-slow'),
      );
      let shipped: Awaited<ReturnType<typeof appearanceForSummon>> | null = null;
      void appearanceForSummon('sui-slow', { deps: d }).then((r) => { shipped = r; });

      await vi.advanceTimersByTimeAsync(APPEARANCE_CLOUD_WAIT_WITH_LOCAL_MS - 1);
      expect(shipped).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(shipped).toMatchObject({ source: 'auto', appearance: { hair: 100 } });
      expect(APPEARANCE_CLOUD_WAIT_WITH_LOCAL_MS).toBeLessThan(APPEARANCE_SUMMON_WAIT_MS);

      // The cloud answers later with a different current look: it lands in the cache for next time.
      answer({ ok: true, profile: profile({ ...SUI_V2, hair: 115 }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(d.cfg.stardew_appearance?.['sui-slow']).toMatchObject({ hair: 115, source: 'auto', version: STARDEW_APPEARANCE_VERSION });
      expect(derive).not.toHaveBeenCalled();
      expect(writeCloud).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cloud answer inside the cap still wins over the local copy', async () => {
    vi.useFakeTimers();
    try {
      const { d } = suiDeps(
        { readCloud: () => new Promise<GameProfileRead>((r) => setTimeout(() => r({ ok: true, profile: profile({ ...SUI_V2, hair: 115 }) }), 1_000)) },
        currentLocal('sui-fast'),
      );
      const pending = getOrDeriveAppearance('sui-fast', d);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).appearance.hair).toBe(115);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no local copy the cloud read is not capped (there is nothing better to use)', async () => {
    vi.useFakeTimers();
    try {
      const derive = vi.fn(async () => SUI_V1);
      const { d } = suiDeps({
        derive,
        readCloud: () => new Promise<GameProfileRead>((r) => setTimeout(() => r({ ok: true, profile: profile(SUI_V2) }), 3_000)),
      });
      const pending = getOrDeriveAppearance('sui-nolocal', d);
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await pending).appearance.hair).toBe(100);
      expect(derive).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
