// World thumbnail refresh (261111): one proxy call per request, a burst for
// the same id coalesced into at most one follow-up, never throws.
import { describe, it, expect, vi } from 'vitest';
import { callThumbRoute, requestPortraitThumb, type ThumbDeps } from './portraitThumb';

function deps(over: Partial<ThumbDeps> = {}): ThumbDeps & { fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ state: 'ready' }), { status: 200 }));
  return { getJwt: async () => 'jwt', fetchImpl, log: () => {}, ...over } as ThumbDeps & { fetchImpl: ReturnType<typeof vi.fn> };
}

describe('callThumbRoute', () => {
  it('POSTs the thumb route with the bearer JWT', async () => {
    const d = deps();
    expect(await callThumbRoute('abc', d)).toBe('ready');
    const [url, init] = d.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/portraits\/v1\/abc\/thumb$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
  });

  it('no session: no request', async () => {
    const d = deps({ getJwt: async () => null });
    expect(await callThumbRoute('abc', d)).toBe('no_session');
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('skipped / HTTP error / network error are outcomes, not throws', async () => {
    expect(await callThumbRoute('abc', deps({ fetchImpl: vi.fn(async () => new Response('{"state":"skipped","reason":"not_shared"}')) as never }))).toBe('skipped');
    expect(await callThumbRoute('abc', deps({ fetchImpl: vi.fn(async () => new Response('nope', { status: 404 })) as never }))).toBe('failed');
    expect(await callThumbRoute('abc', deps({ fetchImpl: vi.fn(async () => { throw new Error('offline'); }) as never }))).toBe('failed');
  });
});

describe('requestPortraitThumb', () => {
  it('coalesces a burst for one id into the running call plus ONE follow-up', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response('{"state":"ready"}');
    });
    const d = deps({ fetchImpl: fetchImpl as never });
    const a = requestPortraitThumb('burst', d);
    await new Promise((r) => setTimeout(r, 0));
    const b = requestPortraitThumb('burst', d);
    const c = requestPortraitThumb('burst', d);
    release();
    await Promise.all([a, b, c]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Finished: a new request runs again.
    await requestPortraitThumb('burst', d);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
