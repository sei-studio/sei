/**
 * Tests for callEdgeFunction — the typed fetch wrapper that Phase 10 uses for
 * delete-me, and Phase 11/12 reuse for admin/moderation Edge Functions
 * (CONTEXT D-13).
 *
 * Covers four cases:
 *   1. 204 No Content → ok:true with undefined json.
 *   2. 401 with JSON error body → ok:false, message extracted from body.error.
 *   3. fetch throws (network error) → ok:false, status:0, message: error message.
 *   4. Timeout via AbortController → ok:false, status:0, message:'timeout'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callEdgeFunction } from './edgeFunctionClient';

vi.mock('../env', () => ({ getSupabaseUrl: () => 'https://stub.example' }));

const realFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  global.fetch = fetchMock as any;
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('callEdgeFunction', () => {
  it('returns ok:true on 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await callEdgeFunction('delete-me', { jwt: 'x' });
    expect(res).toEqual({ ok: true, status: 204, json: undefined });
  });

  it('returns ok:false with error message on 401', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_jwt' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await callEdgeFunction('delete-me', { jwt: 'x' });
    expect(res.ok).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any).status).toBe(401);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any).message).toBe('invalid_jwt');
  });

  it('returns network failure on fetch throw', async () => {
    fetchMock.mockRejectedValue(new Error('econnrefused'));
    const res = await callEdgeFunction('delete-me', { jwt: 'x' });
    expect(res).toEqual({ ok: false, status: 0, message: 'econnrefused' });
  });

  it('returns timeout when timeoutMs elapses', async () => {
    fetchMock.mockImplementation(
      (_url: unknown, init: unknown) =>
        new Promise((_, reject) => {
          const signal = (init as RequestInit).signal as AbortSignal;
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as Error & { name: string }).name = 'AbortError';
            reject(err);
          });
        }),
    );
    const res = await callEdgeFunction('delete-me', { jwt: 'x', timeoutMs: 20 });
    expect(res).toEqual({ ok: false, status: 0, message: 'timeout' });
  });
});
