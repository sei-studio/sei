/**
 * Tests for src/main/auth/tosGate — Phase 11 plan 12.
 *
 * Strategy: vi.mock the supabaseClient singleton with a hand-rolled mock
 * matching the exportBuilder.test.ts pattern. The mock's
 * `.from().select().eq().eq().eq().limit().abortSignal()` chain returns
 * whatever rows / error the per-test state slot is configured with.
 *
 * tosGate has two surfaces:
 *   - isTosAccepted(userId) — read-side, fail-closed
 *   - recordAcceptance(userId) — write-side, throws TOS_RECORD_FAILED
 *
 * Both wrap supabase in an AbortController timeout (CLAUDE.md invariant).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock supabase client ------------------------------------------------

interface MockState {
  selectRows: Record<string, unknown>[];
  selectError: { message: string; code?: string } | null;
  insertError: { message: string; code?: string } | null;
  capturedSelectFilters: Record<string, string>;
  capturedSelectSignal: AbortSignal | null;
  capturedInsertRow: Record<string, unknown> | null;
  capturedInsertSignal: AbortSignal | null;
}

const state: MockState = {
  selectRows: [],
  selectError: null,
  insertError: null,
  capturedSelectFilters: {},
  capturedSelectSignal: null,
  capturedInsertRow: null,
  capturedInsertSignal: null,
};

function resetState(): void {
  state.selectRows = [];
  state.selectError = null;
  state.insertError = null;
  state.capturedSelectFilters = {};
  state.capturedSelectSignal = null;
  state.capturedInsertRow = null;
  state.capturedInsertSignal = null;
}

function makeSelectBuilder() {
  const filters: Record<string, string> = {};
  const builder = {
    eq(col: string, val: string) {
      filters[col] = val;
      state.capturedSelectFilters = filters;
      return builder;
    },
    limit(_n: number) {
      return builder;
    },
    abortSignal(s: AbortSignal) {
      state.capturedSelectSignal = s;
      return Promise.resolve({ data: state.selectRows, error: state.selectError });
    },
  };
  return builder;
}

function makeInsertBuilder() {
  return {
    abortSignal(s: AbortSignal) {
      state.capturedInsertSignal = s;
      return Promise.resolve({ data: null, error: state.insertError });
    },
  };
}

const mockClient = {
  from: vi.fn(() => ({
    select(_cols: string) {
      return makeSelectBuilder();
    },
    insert(row: Record<string, unknown>) {
      state.capturedInsertRow = row;
      return makeInsertBuilder();
    },
  })),
};

vi.mock('./supabaseClient', () => ({
  getClient: () => mockClient,
}));

beforeEach(() => {
  resetState();
});

// ---- Tests ---------------------------------------------------------------

describe('isTosAccepted', () => {
  it('returns true when supabase returns one row matching versions', async () => {
    const { isTosAccepted } = await import('./tosGate');
    state.selectRows = [{ tos_version: '2026-05-21', privacy_version: '2026-05-21' }];
    const result = await isTosAccepted('user-uuid');
    expect(result).toBe(true);
  });

  it('returns false when supabase returns an empty array', async () => {
    const { isTosAccepted } = await import('./tosGate');
    state.selectRows = [];
    const result = await isTosAccepted('user-uuid');
    expect(result).toBe(false);
  });

  it('returns false (fail-closed) when supabase returns an error', async () => {
    const { isTosAccepted } = await import('./tosGate');
    state.selectError = { message: 'permission denied' };
    const result = await isTosAccepted('user-uuid');
    expect(result).toBe(false);
  });

  it('filters by user_id, tos_version, and privacy_version', async () => {
    const { isTosAccepted } = await import('./tosGate');
    const { TOS_VERSION, PRIVACY_VERSION } = await import('../../shared/legalVersions');
    await isTosAccepted('specific-user-uuid');
    expect(state.capturedSelectFilters.user_id).toBe('specific-user-uuid');
    expect(state.capturedSelectFilters.tos_version).toBe(TOS_VERSION);
    expect(state.capturedSelectFilters.privacy_version).toBe(PRIVACY_VERSION);
  });

  it('passes an AbortSignal to the supabase select (15s timeout invariant)', async () => {
    const { isTosAccepted } = await import('./tosGate');
    await isTosAccepted('user-uuid');
    expect(state.capturedSelectSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('getTosAcceptance', () => {
  it("returns 'accepted' when a matching row exists", async () => {
    const { getTosAcceptance } = await import('./tosGate');
    state.selectRows = [{ tos_version: '2026-05-21', privacy_version: '2026-05-21' }];
    await expect(getTosAcceptance('user-uuid')).resolves.toBe('accepted');
  });

  it("returns 'not_accepted' ONLY on a successful empty query", async () => {
    const { getTosAcceptance } = await import('./tosGate');
    state.selectRows = [];
    await expect(getTosAcceptance('user-uuid')).resolves.toBe('not_accepted');
  });

  it("returns 'unknown' (not 'not_accepted') when supabase returns an error — offline launch must not re-show the legal modal", async () => {
    const { getTosAcceptance } = await import('./tosGate');
    state.selectError = { message: 'TypeError: fetch failed' };
    await expect(getTosAcceptance('user-uuid')).resolves.toBe('unknown');
  });
});

describe('recordAcceptance', () => {
  it('inserts a row with user_id, tos_version, privacy_version', async () => {
    const { recordAcceptance } = await import('./tosGate');
    const { TOS_VERSION, PRIVACY_VERSION } = await import('../../shared/legalVersions');
    await recordAcceptance('user-uuid');
    expect(state.capturedInsertRow).toMatchObject({
      user_id: 'user-uuid',
      tos_version: TOS_VERSION,
      privacy_version: PRIVACY_VERSION,
    });
  });

  it('throws TOS_RECORD_FAILED:<msg> when supabase returns an error', async () => {
    const { recordAcceptance } = await import('./tosGate');
    state.insertError = { message: 'constraint violation' };
    await expect(recordAcceptance('user-uuid')).rejects.toThrow(
      /TOS_RECORD_FAILED: constraint violation/,
    );
  });

  it('treats a 23505 duplicate-key error as idempotent success (composite PK — user already accepted)', async () => {
    const { recordAcceptance } = await import('./tosGate');
    state.insertError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "tos_acceptance_pkey"',
    };
    await expect(recordAcceptance('user-uuid')).resolves.toBeUndefined();
  });

  it('treats a duplicate-key error without a code field as success (message fallback)', async () => {
    const { recordAcceptance } = await import('./tosGate');
    state.insertError = {
      message: 'duplicate key value violates unique constraint "tos_acceptance_pkey"',
    };
    await expect(recordAcceptance('user-uuid')).resolves.toBeUndefined();
  });

  it('resolves without throw when insert succeeds', async () => {
    const { recordAcceptance } = await import('./tosGate');
    state.insertError = null;
    await expect(recordAcceptance('user-uuid')).resolves.toBeUndefined();
  });

  it('passes an AbortSignal to the supabase insert (15s timeout invariant)', async () => {
    const { recordAcceptance } = await import('./tosGate');
    await recordAcceptance('user-uuid');
    expect(state.capturedInsertSignal).toBeInstanceOf(AbortSignal);
  });
});
