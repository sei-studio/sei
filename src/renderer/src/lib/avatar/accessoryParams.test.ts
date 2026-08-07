/** accessoryParams (260806) — exp3 parsing + absolute target math. */
import { describe, it, expect } from 'vitest';
import { parseExpressionParams, computeAccessoryTargets } from './accessoryParams';

describe('parseExpressionParams', () => {
  it('parses the real hat-toggle shape (Blend Add)', () => {
    // The Snow Bear Girl "1 帽" expression: hat off, crown on.
    const exp = {
      Type: 'Live2D Expression',
      Parameters: [
        { Id: 'Key1', Value: -1.0, Blend: 'Add' },
        { Id: 'Key22', Value: 1.0, Blend: 'Add' },
      ],
    };
    expect(parseExpressionParams(exp)).toEqual([
      { id: 'Key1', value: -1, blend: 'Add' },
      { id: 'Key22', value: 1, blend: 'Add' },
    ]);
  });

  it('defaults missing/unknown Blend to Add and drops malformed entries', () => {
    const exp = {
      Parameters: [
        { Id: 'A', Value: 0.5 },
        { Id: 'B', Value: 2, Blend: 'Multiply' },
        { Id: 'C', Value: 0, Blend: 'Overwrite' },
        { Id: 'D' },
        { Value: 1 },
        { Id: 'E', Value: Number.NaN },
        null,
      ],
    };
    expect(parseExpressionParams(exp)).toEqual([
      { id: 'A', value: 0.5, blend: 'Add' },
      { id: 'B', value: 2, blend: 'Multiply' },
      { id: 'C', value: 0, blend: 'Overwrite' },
    ]);
  });

  it('returns [] on junk input', () => {
    expect(parseExpressionParams(null)).toEqual([]);
    expect(parseExpressionParams('nope')).toEqual([]);
    expect(parseExpressionParams({ Parameters: 'nope' })).toEqual([]);
  });
});

describe('computeAccessoryTargets', () => {
  const defaults = (id: string): number => (id === 'Key1' ? 1 : 0);

  it('applies Add deltas against parameter defaults', () => {
    const targets = computeAccessoryTargets(
      [
        [
          { id: 'Key1', value: -1, blend: 'Add' },
          { id: 'Key22', value: 1, blend: 'Add' },
        ],
      ],
      defaults,
    );
    expect(targets.get('Key1')).toBe(0); // hat: default 1, -1 → hidden
    expect(targets.get('Key22')).toBe(1); // crown: default 0, +1 → shown
  });

  it('composes multiple accessory sets over the same parameter in order', () => {
    const targets = computeAccessoryTargets(
      [
        [{ id: 'X', value: 0.5, blend: 'Add' }],
        [{ id: 'X', value: 2, blend: 'Multiply' }],
        [{ id: 'Y', value: 3, blend: 'Overwrite' }],
      ],
      () => 1,
    );
    expect(targets.get('X')).toBe(3); // (1 + 0.5) * 2
    expect(targets.get('Y')).toBe(3);
  });

  it('is empty with no enabled accessories', () => {
    expect(computeAccessoryTargets([], defaults).size).toBe(0);
  });
});
