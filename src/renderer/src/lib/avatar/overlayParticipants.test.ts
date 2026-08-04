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
        openChatId: 'c',
      }),
    ).toEqual([]);
  });

  it("'activity' shows call members first (join order), then other active ids, deduped", () => {
    expect(
      computeAvatarIds({
        mode: 'activity',
        callParticipants: ['a', 'b'],
        activityIds: ['b', 'c'],
        openChatId: null,
      }),
    ).toEqual(['a', 'b', 'c']);
  });

  it("'activity' with nothing active shows nothing, even with a chat open", () => {
    expect(
      computeAvatarIds({
        mode: 'activity',
        callParticipants: [],
        activityIds: [],
        openChatId: 'c',
      }),
    ).toEqual([]);
  });

  it("'always' falls back to the open chat's character when nothing is active", () => {
    expect(
      computeAvatarIds({
        mode: 'always',
        callParticipants: [],
        activityIds: [],
        openChatId: 'c',
      }),
    ).toEqual(['c']);
  });

  it("'always' prefers activity over the open chat, and shows nothing on e.g. Home", () => {
    expect(
      computeAvatarIds({
        mode: 'always',
        callParticipants: [],
        activityIds: ['m'],
        openChatId: 'c',
      }),
    ).toEqual(['m']);
    expect(
      computeAvatarIds({
        mode: 'always',
        callParticipants: [],
        activityIds: [],
        openChatId: null,
      }),
    ).toEqual([]);
  });
});
