/**
 * Tests for src/main/auth/exportBuilder — Phase 11 extension fills
 * characters[] from supabase.from('characters').select('*').eq('owner', ...).
 *
 * Strategy: vi.mock the supabaseClient singleton with a hand-rolled mock
 * matching the cloudCharacterClient.test.ts pattern. The mock's
 * `.from().select().eq().abortSignal()` chain returns whatever rows /
 * error the per-test state slot is configured with.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock supabase client ------------------------------------------------

interface MockState {
  selectRows: Record<string, unknown>[];
  selectError: { message: string } | null;
  capturedOwner: string | null;
  capturedSignal: AbortSignal | null;
}

const state: MockState = {
  selectRows: [],
  selectError: null,
  capturedOwner: null,
  capturedSignal: null,
};

function resetState(): void {
  state.selectRows = [];
  state.selectError = null;
  state.capturedOwner = null;
  state.capturedSignal = null;
}

function makeFromBuilder() {
  return {
    select() {
      return {
        eq(_col: string, val: string) {
          state.capturedOwner = val;
          return {
            abortSignal(s: AbortSignal) {
              state.capturedSignal = s;
              return Promise.resolve({ data: state.selectRows, error: state.selectError });
            },
          };
        },
      };
    },
  };
}

const mockClient = {
  from: vi.fn(() => makeFromBuilder()),
};

vi.mock('./supabaseClient', () => ({
  getClient: () => mockClient,
}));

// ---- Helpers -------------------------------------------------------------

function makeSession(
  overrides: Partial<{ email: string | null; created_at: string; id: string }> = {},
): any {
  return {
    access_token: 'jwt',
    refresh_token: 'rt',
    user: {
      id: overrides.id ?? 'user-uuid',
      email: overrides.email !== undefined ? overrides.email : 'test@example.com',
      created_at: overrides.created_at ?? '2026-05-19T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  resetState();
});

// ---- Tests ---------------------------------------------------------------

describe('buildExport (Phase 11 — characters[] fill)', () => {
  it('returns characters: [] when the cloud has no rows', async () => {
    const { buildExport } = await import('./exportBuilder');
    state.selectRows = [];
    const out = await buildExport(makeSession());
    expect(out.characters).toEqual([]);
  });

  it('fills characters[] with the raw snake_case rows from Supabase', async () => {
    const { buildExport } = await import('./exportBuilder');
    state.selectRows = [
      {
        id: 'char-1',
        owner: 'user-uuid',
        name: 'Alice',
        persona_source: 'a friend',
        persona_expanded: 'a friend who helps',
        is_default: false,
        shared: true,
        created_at: '2026-01-01T00:00:00.000Z',
        playtime_ms: 0,
      },
      {
        id: 'char-2',
        owner: 'user-uuid',
        name: 'Bob',
        persona_source: 'a teacher',
        persona_expanded: 'a teacher who explains',
        is_default: false,
        shared: false,
        created_at: '2026-01-02T00:00:00.000Z',
        playtime_ms: 1234,
      },
    ];
    const out = await buildExport(makeSession());
    expect(out.characters).toHaveLength(2);
    // Preserves DB row shape (snake_case columns) — not wrapped Character
    expect(out.characters[0]).toMatchObject({
      id: 'char-1',
      persona_source: 'a friend',
      persona_expanded: 'a friend who helps',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(out.characters[1]).toMatchObject({ id: 'char-2', name: 'Bob' });
  });

  it('throws CLOUD_LIST_FAILED:<msg> when supabase returns an error', async () => {
    const { buildExport } = await import('./exportBuilder');
    state.selectError = { message: 'permission denied' };
    await expect(buildExport(makeSession())).rejects.toThrow(/CLOUD_LIST_FAILED: permission denied/);
  });

  it('filters by owner = session.user.id (RLS belt+suspenders)', async () => {
    const { buildExport } = await import('./exportBuilder');
    await buildExport(makeSession({ id: 'specific-owner-uuid' }));
    expect(state.capturedOwner).toBe('specific-owner-uuid');
  });

  it('schemaVersion stays exactly 1 (D-14 contract — no version bump)', async () => {
    const { buildExport } = await import('./exportBuilder');
    state.selectRows = [{ id: 'x', name: 'y' }];
    const out = await buildExport(makeSession());
    expect(out.schemaVersion).toBe(1);
  });

  it('sharing stays as empty array (Phase 12 fills it, not Phase 11)', async () => {
    const { buildExport } = await import('./exportBuilder');
    state.selectRows = [{ id: 'x' }];
    const out = await buildExport(makeSession());
    expect(out.sharing).toEqual([]);
  });

  it('account.email and account.createdAt come from the session', async () => {
    const { buildExport } = await import('./exportBuilder');
    const out = await buildExport(
      makeSession({ email: 'hello@example.com', created_at: '2025-12-31T23:59:59.000Z' }),
    );
    expect(out.account.email).toBe('hello@example.com');
    expect(out.account.createdAt).toBe('2025-12-31T23:59:59.000Z');
  });

  it('coerces a null email to empty string (Phase 10 invariant preserved)', async () => {
    const { buildExport } = await import('./exportBuilder');
    const out = await buildExport(makeSession({ email: null }));
    expect(out.account.email).toBe('');
  });

  it('has exactly the 5 documented top-level keys (no extras, no missing)', async () => {
    const { buildExport } = await import('./exportBuilder');
    state.selectRows = [{ id: 'x' }];
    const out = await buildExport(makeSession());
    expect(Object.keys(out).sort()).toEqual(
      ['account', 'characters', 'exportedAt', 'schemaVersion', 'sharing'].sort(),
    );
  });

  it('exportedAt is a valid ISO timestamp', async () => {
    const { buildExport } = await import('./exportBuilder');
    const out = await buildExport(makeSession());
    expect(Number.isFinite(Date.parse(out.exportedAt))).toBe(true);
  });

  it('passes an AbortSignal to the supabase select (15s timeout pattern)', async () => {
    const { buildExport } = await import('./exportBuilder');
    await buildExport(makeSession());
    expect(state.capturedSignal).toBeInstanceOf(AbortSignal);
  });
});
