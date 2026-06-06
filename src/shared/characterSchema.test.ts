import { describe, it, expect } from 'vitest';
import { CharacterSchema } from './characterSchema';

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
