/**
 * W7 region gate (260816) — detection tests: trace fetch happy path, garbage,
 * network failure, timeout (all -> unknown -> allowed), and the cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectRegionLoc, getRegionStatus, resetRegionCacheForTest } from './regionDetect';

// The default (no injected impl) path lazily imports electron and uses
// net.fetch — Chromium's stack, which honors the OS proxy that undici
// ignores. Electron is not present under vitest, so mock the module the
// dynamic import resolves.
const { electronNetFetch } = vi.hoisted(() => ({ electronNetFetch: vi.fn() }));
vi.mock('electron', () => ({ net: { fetch: electronNetFetch } }));

function traceResponse(loc: string): Response {
  return new Response(`h=api.sei.gg\nip=203.0.113.7\nloc=${loc}\ntls=TLSv1.3\n`, { status: 200 });
}

beforeEach(() => {
  resetRegionCacheForTest();
  electronNetFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('detectRegionLoc', () => {
  it('parses loc from a trace response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(traceResponse('CN'));
    expect(await detectRegionLoc(fetchMock as unknown as typeof fetch)).toBe('CN');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sei.gg/cdn-cgi/trace',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('returns null (unknown) for a garbage body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>portal</html>', { status: 200 }));
    expect(await detectRegionLoc(fetchMock as unknown as typeof fetch)).toBeNull();
  });

  it('returns null (unknown) for a non-2xx status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    expect(await detectRegionLoc(fetchMock as unknown as typeof fetch)).toBeNull();
  });

  it('returns null (unknown) when fetch rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    expect(await detectRegionLoc(fetchMock as unknown as typeof fetch)).toBeNull();
  });

  it('returns null (unknown) on timeout: the 5s abort fires and is swallowed', async () => {
    vi.useFakeTimers();
    // A fetch that never resolves on its own — only the abort signal ends it,
    // which is exactly what a stalled connection looks like.
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const p = detectRegionLoc(fetchMock as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await p).toBeNull();
  });

  it("defaults to electron's net.fetch when no impl is injected", async () => {
    electronNetFetch.mockResolvedValue(traceResponse('JP'));
    expect(await detectRegionLoc()).toBe('JP');
    expect(electronNetFetch).toHaveBeenCalledWith(
      'https://api.sei.gg/cdn-cgi/trace',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('never touches electron when an impl is injected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(traceResponse('US'));
    expect(await detectRegionLoc(fetchMock as unknown as typeof fetch)).toBe('US');
    expect(electronNetFetch).not.toHaveBeenCalled();
  });
});

describe('getRegionStatus', () => {
  it('reports blocked for a blocklisted loc', async () => {
    const fetchMock = vi.fn().mockResolvedValue(traceResponse('CN'));
    expect(await getRegionStatus(fetchMock as unknown as typeof fetch)).toEqual({
      loc: 'CN',
      blocked: true,
    });
  });

  it('reports allowed for a supported loc', async () => {
    const fetchMock = vi.fn().mockResolvedValue(traceResponse('US'));
    expect(await getRegionStatus(fetchMock as unknown as typeof fetch)).toEqual({
      loc: 'US',
      blocked: false,
    });
  });

  it('fails open: detection failure means { loc: null, blocked: false }', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await getRegionStatus(fetchMock as unknown as typeof fetch)).toEqual({
      loc: null,
      blocked: false,
    });
  });

  it('caches a successful verdict: one fetch across repeated calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(traceResponse('HK'));
    await getRegionStatus(fetchMock as unknown as typeof fetch);
    await getRegionStatus(fetchMock as unknown as typeof fetch);
    await getRegionStatus(fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent callers onto one fetch', async () => {
    let release: (() => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(traceResponse('DE'));
        }),
    );
    const a = getRegionStatus(fetchMock as unknown as typeof fetch);
    const b = getRegionStatus(fetchMock as unknown as typeof fetch);
    release!();
    expect(await a).toEqual({ loc: 'DE', blocked: false });
    expect(await b).toEqual({ loc: 'DE', blocked: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
