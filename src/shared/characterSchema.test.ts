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
 * Phase 15 — Plan 15-03 Task 1 (Warning 8): runtime parse-gate for the
 * user-facing vision auto-render toggle. tsc proves the FIELD exists; only a
 * .parse() exercise proves the RUNTIME default + coercion behavior the Settings
 * write-through (15-05) and the botSupervisor bridge depend on. See 15-03-PLAN.md
 * Task 1 (c).
 */
describe('UserConfigSchema — vision_auto_render (D-05)', () => {
  it('defaults vision_auto_render to false when omitted', () => {
    // A minimal valid UserConfig — every other field has its own .default(),
    // so an empty object round-trips. vision_auto_render must default to false
    // (auto-render OFF / VIS-04), matching the bot config.vision.auto_render default.
    const parsed = UserConfigSchema.parse({});
    expect(parsed.vision_auto_render).toBe(false);
  });

  it('round-trips an explicit vision_auto_render: true', () => {
    const parsed = UserConfigSchema.parse({ vision_auto_render: true });
    expect(parsed.vision_auto_render).toBe(true);
  });

  it('rejects a non-boolean vision_auto_render', () => {
    const result = UserConfigSchema.safeParse({ vision_auto_render: 'yes' });
    expect(result.success).toBe(false);
  });

  it('preserves a pre-existing config.json that omits vision_auto_render (backward compat)', () => {
    // A config object shaped like a pre-Phase-15 install (no vision field at all)
    // must still parse cleanly and pick up the false default.
    const parsed = UserConfigSchema.parse({
      mc_username: 'Steve',
      preferred_name: 'Shawn',
      provider: 'anthropic',
      ai_backend_kind: 'local',
      dev_console_visible: false,
    });
    expect(parsed.vision_auto_render).toBe(false);
  });
});
