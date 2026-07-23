import { describe, it, expect } from 'vitest';
import { CharacterSchema, UserConfigSchema } from './characterSchema';

/**
 * Plan 11-03 Task 1 — Schema contract tests for the UUID identity model,
 * the public/private flag (D-16), the slug carry-over field (D-23), and
 * the metadata escape hatch (D-24). See 11-03-PLAN.md `behavior` block.
 */

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Sui',
    persona: { source: 'a curious helper', expanded: '' },
    created: '2026-05-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('CharacterSchema — UUID identity (D-23)', () => {
  it('accepts a valid UUID v4 id', () => {
    const parsed = CharacterSchema.parse(baseRow());
    expect(parsed.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('rejects a legacy slug-style id with a clear error', () => {
    const result = CharacterSchema.safeParse(baseRow({ id: 'sui' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod's uuid validator surfaces the message in the issues array.
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/uuid|UUID/i);
    }
  });
});

describe('CharacterSchema — shared flag default (D-16)', () => {
  it('defaults `shared` to true when omitted', () => {
    const parsed = CharacterSchema.parse(baseRow());
    expect(parsed.shared).toBe(true);
  });

  it('respects an explicit `shared: false`', () => {
    const parsed = CharacterSchema.parse(baseRow({ shared: false }));
    expect(parsed.shared).toBe(false);
  });
});

describe('CharacterSchema — slug carry-over (D-23)', () => {
  it('defaults `slug` to null when omitted', () => {
    const parsed = CharacterSchema.parse(baseRow());
    expect(parsed.slug).toBeNull();
  });

  it('preserves an explicit slug value', () => {
    const parsed = CharacterSchema.parse(baseRow({ slug: 'sui' }));
    expect(parsed.slug).toBe('sui');
  });
});

describe('CharacterSchema — metadata escape hatch (D-24)', () => {
  it('defaults `metadata` to an empty object when omitted', () => {
    const parsed = CharacterSchema.parse(baseRow());
    expect(parsed.metadata).toEqual({});
  });

  it('preserves arbitrary metadata values', () => {
    const parsed = CharacterSchema.parse(
      baseRow({ metadata: { future_field: 'value', count: 3 } }),
    );
    expect(parsed.metadata).toEqual({ future_field: 'value', count: 3 });
  });
});

describe('CharacterSchema — portrait_image is a permissive path-or-null (D-28)', () => {
  it('accepts a path-reference string', () => {
    const parsed = CharacterSchema.parse(
      baseRow({ portrait_image: 'portraits/abc/def.png' }),
    );
    expect(parsed.portrait_image).toBe('portraits/abc/def.png');
  });

  it('accepts null', () => {
    const parsed = CharacterSchema.parse(baseRow({ portrait_image: null }));
    expect(parsed.portrait_image).toBeNull();
  });
});

/**
 * Runtime parse-gate for the user-facing Looking (vision) mode (vision_mode:
 * 'off' | 'on-demand' | 'continuous'). tsc proves the FIELD exists; only a
 * .parse() exercise proves the RUNTIME default, the legacy-value migration, and
 * the rejection behavior the Settings write-through and the botSupervisor
 * bridge depend on.
 */
describe('UserConfigSchema — vision_mode', () => {
  it('defaults to on-demand when omitted', () => {
    // A minimal valid UserConfig — every other field has its own .default(),
    // so an empty object round-trips. The default matches the bot
    // config.vision default (mode 'on-demand') and the fresh-install onboarding.
    const parsed = UserConfigSchema.parse({});
    expect(parsed.vision_mode).toBe('on-demand');
  });

  it('round-trips every explicit mode', () => {
    for (const mode of ['off', 'on-demand', 'continuous'] as const) {
      const parsed = UserConfigSchema.parse({ vision_mode: mode });
      expect(parsed.vision_mode).toBe(mode);
    }
  });

  it('migrates the legacy pre-simplification values to continuous', () => {
    // 'passive' and 'active' both streamed automatic views, so they collapse to
    // 'continuous'. The remap must survive .parse() (configStore throws on an
    // unknown enum), so an existing config.json keeps loading.
    expect(UserConfigSchema.parse({ vision_mode: 'passive' }).vision_mode).toBe('continuous');
    expect(UserConfigSchema.parse({ vision_mode: 'active' }).vision_mode).toBe('continuous');
  });

  it('rejects an unknown mode', () => {
    expect(UserConfigSchema.safeParse({ vision_mode: 'sometimes' }).success).toBe(false);
  });

  it('preserves a pre-existing config.json that omits the vision field (backward compat)', () => {
    // A config object shaped like an older install (no vision field at all)
    // must still parse cleanly and pick up the default.
    const parsed = UserConfigSchema.parse({
      mc_username: 'Steve',
      preferred_name: 'Shawn',
      provider: 'anthropic',
      ai_backend_kind: 'local',
      dev_console_visible: false,
    });
    expect(parsed.vision_mode).toBe('on-demand');
  });

  it('defaults advanced_updates to false — a normal user is never on the beta channel', () => {
    // Safety-critical: an absent field (fresh install or any pre-existing
    // config.json) must resolve to the STABLE channel, never beta.
    expect(UserConfigSchema.parse({}).advanced_updates).toBe(false);
    expect(
      UserConfigSchema.parse({ mc_username: 'Steve', provider: 'anthropic' }).advanced_updates,
    ).toBe(false);
    // And it round-trips when explicitly opted in.
    expect(UserConfigSchema.parse({ advanced_updates: true }).advanced_updates).toBe(true);
  });
});
