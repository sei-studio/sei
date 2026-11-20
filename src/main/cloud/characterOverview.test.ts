import { describe, it, expect, vi } from 'vitest';
import { characterOverviewInfo, type OverviewDeps } from './characterOverview';

const ME = '11111111-1111-4111-8111-111111111111';
const AUTHOR = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

function deps(over: Partial<OverviewDeps> & { character?: Record<string, unknown> | null } = {}): OverviewDeps {
  const { character = { id: ID, owner: AUTHOR, is_default: false }, ...rest } = over;
  return {
    getCharacter: async () => character as never,
    currentUserId: () => ME,
    profileNames: vi.fn(async () => new Map([[AUTHOR, 'kitsune']])),
    addCounts: async () => new Map([[ID, 72]]),
    sampleVoiceId: () => 'v-sarah',
    ...rest,
  };
}

describe('characterOverviewInfo (profile Overview, 261110)', () => {
  it("someone else's companion: the author's name and the add count", async () => {
    expect(await characterOverviewInfo(ID, deps())).toEqual({ creatorName: 'kitsune', addCount: 72, sampleVoiceId: 'v-sarah' });
  });

  it('no count read while the counts are hidden (addCounts null)', async () => {
    expect((await characterOverviewInfo(ID, deps({ addCounts: null }))).addCount).toBeNull();
  });

  it('no author name for your own companions or a built-in, and no lookup', async () => {
    const own = deps({ character: { id: ID, owner: ME, is_default: false } });
    expect((await characterOverviewInfo(ID, own)).creatorName).toBeNull();
    expect(own.profileNames).not.toHaveBeenCalled();
    const builtin = deps({ character: { id: ID, owner: AUTHOR, is_default: true } });
    expect((await characterOverviewInfo(ID, builtin)).creatorName).toBeNull();
  });

  it('never throws: failures read as unknown', async () => {
    const broken = deps({
      profileNames: async () => {
        throw new Error('offline');
      },
      addCounts: async () => {
        throw new Error('offline');
      },
      sampleVoiceId: () => {
        throw new Error('bad metadata');
      },
    });
    expect(await characterOverviewInfo(ID, broken)).toEqual({
      creatorName: null,
      addCount: null,
      sampleVoiceId: null,
    });
    expect(await characterOverviewInfo(ID, deps({ character: null }))).toEqual({
      creatorName: null,
      addCount: null,
      sampleVoiceId: null,
    });
  });
});
