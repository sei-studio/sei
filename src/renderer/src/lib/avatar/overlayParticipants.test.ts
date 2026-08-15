/** computeAvatarIds (260804) — the avatar overlay's mode semantics. */
import { describe, it, expect } from 'vitest';
import { computeAvatarIds } from './overlayParticipants';

describe('computeAvatarIds', () => {
  it("'off' shows nothing regardless of activity", () => {
    expect(
      computeAvatarIds({
        mode: 'off',
        callParticipants: ['a'],
        activityIds: ['b'],
        lastInteractedId: 'c',
      }),
    ).toEqual([]);
  });

  it("'activity' shows call members first (join order), then other active ids, deduped", () => {
    expect(
      computeAvatarIds({
        mode: 'activity',
        callParticipants: ['a', 'b'],
        activityIds: ['b', 'c'],
        lastInteractedId: null,
      }),
    ).toEqual(['a', 'b', 'c']);
  });

  it("'activity' with nothing active shows nothing, even with a recent companion", () => {
    expect(
      computeAvatarIds({
        mode: 'activity',
        callParticipants: [],
        activityIds: [],
        lastInteractedId: 'c',
      }),
    ).toEqual([]);
  });

  it("'always' falls back to the last-interacted companion when nothing is active", () => {
    expect(
      computeAvatarIds({
        mode: 'always',
        callParticipants: [],
        activityIds: [],
        lastInteractedId: 'c',
      }),
    ).toEqual(['c']);
  });

  it("'always' prefers activity over the fallback, and shows nothing on a fresh install", () => {
    expect(
      computeAvatarIds({
        mode: 'always',
        callParticipants: [],
        activityIds: ['m'],
        lastInteractedId: 'c',
      }),
    ).toEqual(['m']);
    expect(
      computeAvatarIds({
        mode: 'always',
        callParticipants: [],
        activityIds: [],
        lastInteractedId: null,
      }),
    ).toEqual([]);
  });
});
