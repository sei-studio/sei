/**
 * T283 review: fetchMyProfileName / fetchMyProfile read the AUTH SESSION
 * user's name. With an expected user id, a session for anyone else answers
 * null and never queries, so one account's name cannot land in another's
 * profile.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  sessionUser: null as string | null,
  queried: [] as string[],
  rowName: 'Ana' as string | null,
}));

vi.mock('../auth/supabaseClient', () => ({
  getClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: h.sessionUser ? { user: { id: h.sessionUser }, access_token: 'tok' } : null },
      }),
    },
  }),
  getAuthedClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          abortSignal: () => ({
            maybeSingle: async () => {
              h.queried.push(id);
              return { data: { preferred_name: h.rowName }, error: null };
            },
          }),
        }),
      }),
    }),
  }),
}));

import { fetchMyProfile, fetchMyProfileName } from './cloudCharacterClient';

beforeEach(() => {
  h.sessionUser = null;
  h.queried = [];
  h.rowName = 'Ana';
});

describe('fetchMyProfileName with an expected user', () => {
  it("reads the session user's name when it is the expected account", async () => {
    h.sessionUser = A;
    expect(await fetchMyProfileName(A)).toBe('Ana');
    expect(await fetchMyProfile(A)).toEqual({ userId: A, name: 'Ana' });
    expect(h.queried).toEqual([A, A]);
  });

  it('answers null without querying when the session is another account', async () => {
    h.sessionUser = B;
    expect(await fetchMyProfileName(A)).toBeNull();
    expect(await fetchMyProfile(A)).toBeNull();
    expect(h.queried).toEqual([]);
  });

  it('signed out answers null', async () => {
    expect(await fetchMyProfileName(A)).toBeNull();
  });

  it('with no expected user it keeps the old behaviour (the session user)', async () => {
    h.sessionUser = B;
    expect(await fetchMyProfileName()).toBe('Ana');
    expect(h.queried).toEqual([B]);
  });

  it('a blank name is null but still says whose it is', async () => {
    h.sessionUser = A;
    h.rowName = '  ';
    expect(await fetchMyProfile(A)).toEqual({ userId: A, name: null });
    expect(await fetchMyProfileName(A)).toBeNull();
  });
});
