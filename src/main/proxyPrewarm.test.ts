import { describe, it, expect, vi, beforeEach } from 'vitest';

const backend = vi.hoisted(() => ({ kind: 'cloud-proxy' as string, provider: 'anthropic' as string }));
const catalog = vi.hoisted(() => ({ cached: [] as unknown[], listModels: vi.fn(async () => [] as unknown[]) }));
vi.mock('./apiKeyStore', () => ({ getAiBackendKind: async () => backend.kind }));
vi.mock('./llm', () => ({ localProviderKind: async () => backend.provider }));
vi.mock('./chatgptPlan', () => ({
  chatgptSession: () => ({ cachedModels: () => catalog.cached, listModels: catalog.listModels }),
}));

import { prewarmProxyConnection, prewarmChatUpstream, _resetProxyPrewarm, PROXY_PREWARM_MIN_INTERVAL_MS } from './proxyPrewarm';

describe('proxy connection prewarm (261125)', () => {
  beforeEach(() => {
    _resetProxyPrewarm();
    backend.kind = 'cloud-proxy';
    backend.provider = 'anthropic';
    catalog.cached = [];
    catalog.listModels.mockReset();
    catalog.listModels.mockResolvedValue([]);
  });

  it('sends GET /health (a HEAD is answered with connection: close) and drains it', async () => {
    const body = vi.fn(async () => new ArrayBuffer(0));
    const fetchImpl = vi.fn(async () => ({ arrayBuffer: body }) as unknown as Response);
    expect(prewarmProxyConnection({ now: 50_000, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(true);
    await vi.waitFor(() => expect(body).toHaveBeenCalled());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/health$/);
    expect(init.method).toBe('GET');
  });

  it('throttles to one request per interval, under fetch keep-alive (4s)', () => {
    const fetchImpl = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response);
    const f = fetchImpl as unknown as typeof fetch;
    expect(PROXY_PREWARM_MIN_INTERVAL_MS).toBeLessThan(4_000);
    expect(prewarmProxyConnection({ now: 100_000, fetchImpl: f })).toBe(true);
    expect(prewarmProxyConnection({ now: 100_000 + PROXY_PREWARM_MIN_INTERVAL_MS - 1, fetchImpl: f })).toBe(false);
    expect(prewarmProxyConnection({ now: 100_000 + PROXY_PREWARM_MIN_INTERVAL_MS, fetchImpl: f })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never throws when the request fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(() => prewarmProxyConnection({ now: 200_000, fetchImpl: fetchImpl as unknown as typeof fetch })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('typed chat warms the proxy only on the cloud backend', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      backend.kind = 'local';
      expect(await prewarmChatUpstream()).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      backend.kind = 'cloud-proxy';
      expect(await prewarmChatUpstream()).toBe(true);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    } finally {
      spy.mockRestore();
    }
  });

  it('ChatGPT plan: prefetches the model catalog only while it is not cached, at most once a minute', async () => {
    backend.kind = 'local';
    backend.provider = 'chatgpt';
    catalog.listModels.mockRejectedValueOnce(new Error('http_403'));
    expect(await prewarmChatUpstream({ now: 1_000_000 })).toBe(true);
    expect(await prewarmChatUpstream({ now: 1_000_000 + 30_000 })).toBe(false); // failed: no retry storm while typing
    expect(await prewarmChatUpstream({ now: 1_000_000 + 60_000 })).toBe(true);
    expect(catalog.listModels).toHaveBeenCalledTimes(2);
    catalog.cached = [{ slug: 'm' }];
    expect(await prewarmChatUpstream({ now: 1_000_000 + 200_000 })).toBe(false);
    expect(catalog.listModels).toHaveBeenCalledTimes(2);
  });

  it('other own-key providers do nothing', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      backend.kind = 'local';
      backend.provider = 'openai';
      expect(await prewarmChatUpstream()).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(catalog.listModels).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
