/**
 * 261010: Ollama's default window is 4096 tokens on GPUs under 24 GiB and it
 * silently drops the FRONT of a longer prompt (the system prompt). Every
 * request now carries a num_ctx sized to the prompt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  chooseOllamaNumCtx,
  clearOllamaContextState,
  estimateOllamaPromptTokens,
  loadedContextLength,
  neededNumCtx,
  OLLAMA_CTX_MAX,
  OLLAMA_CTX_MIN,
  OLLAMA_IMAGE_TOKENS,
} from './ollamaContext';

beforeEach(() => clearOllamaContextState());

function psResponse(models: unknown[]): Response {
  return { ok: true, json: async () => ({ models }) } as unknown as Response;
}

describe('estimateOllamaPromptTokens', () => {
  it('over-counts English JSON a little (measured 4.5 chars/token, counted at 3.5)', () => {
    const text = 'x'.repeat(45_000);
    const est = estimateOllamaPromptTokens({ messages: [{ role: 'system', content: text }] });
    expect(est).toBeGreaterThan(45_000 / 4.5);
    expect(est).toBeLessThan(45_000 / 3);
  });

  it('counts CJK at a token per character', () => {
    const est = estimateOllamaPromptTokens({ messages: [{ role: 'user', content: '你好'.repeat(500) }] });
    expect(est).toBeGreaterThanOrEqual(1000);
  });

  it('charges images a flat cost and never counts their base64 as text', () => {
    const big = 'A'.repeat(400_000);
    const est = estimateOllamaPromptTokens({ messages: [{ role: 'user', content: 'what is this?', images: [big, big] }] });
    expect(est).toBeGreaterThanOrEqual(2 * OLLAMA_IMAGE_TOKENS);
    expect(est).toBeLessThan(2 * OLLAMA_IMAGE_TOKENS + 100);
  });

  it('counts the tools array', () => {
    const tools = [{ type: 'function', function: { name: 'say', description: 'd'.repeat(3500), parameters: {} } }];
    expect(estimateOllamaPromptTokens({ messages: [], tools })).toBeGreaterThanOrEqual(1000);
  });
});

describe('neededNumCtx', () => {
  it('never goes below the floor (a short chat still gets more than 4096)', () => {
    expect(neededNumCtx(500, 200)).toBe(OLLAMA_CTX_MIN);
  });
  it('fits the Minecraft first turn (about 12k prompt tokens + 1024 reply)', () => {
    const n = neededNumCtx(15_000, 1024);
    expect(n).toBeGreaterThanOrEqual(15_000 + 1024);
    expect(n % 4096).toBe(0);
  });
  it('caps at OLLAMA_CTX_MAX', () => {
    expect(neededNumCtx(200_000, 1024)).toBe(OLLAMA_CTX_MAX);
  });
});

describe('chooseOllamaNumCtx', () => {
  const base = 'http://localhost:11434';

  it('sizes to the prompt when the model is not loaded', async () => {
    const fetchImpl = vi.fn(async (_url: string) => psResponse([]));
    const n = await chooseOllamaNumCtx({ baseUrl: base, model: 'qwen3:4b', promptTokens: 14_000, maxTokens: 1024, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(n).toBe(neededNumCtx(14_000, 1024));
    expect(fetchImpl.mock.calls[0][0]).toBe(`${base}/api/ps`);
  });

  it('never shrinks for the same model in this process (a changed num_ctx reloads the model)', async () => {
    const fetchImpl = (async () => psResponse([])) as unknown as typeof fetch;
    const big = await chooseOllamaNumCtx({ baseUrl: base, model: 'qwen3:4b', promptTokens: 20_000, maxTokens: 1024, fetchImpl });
    const small = await chooseOllamaNumCtx({ baseUrl: base, model: 'qwen3:4b', promptTokens: 1_000, maxTokens: 200, fetchImpl });
    expect(small).toBe(big);
    // Other models are independent.
    const other = await chooseOllamaNumCtx({ baseUrl: base, model: 'gemma3:4b', promptTokens: 1_000, maxTokens: 200, fetchImpl });
    expect(other).toBe(OLLAMA_CTX_MIN);
  });

  it('reuses a loaded context that is already big enough (the user set 64k, or another surface loaded it)', async () => {
    const fetchImpl = (async () => psResponse([{ name: 'qwen3:4b', model: 'qwen3:4b', context_length: 65536 }])) as unknown as typeof fetch;
    expect(await chooseOllamaNumCtx({ baseUrl: base, model: 'qwen3:4b', promptTokens: 3_000, maxTokens: 200, fetchImpl })).toBe(65536);
  });

  it('does not reuse a loaded context that is too small (the 4096 default)', async () => {
    const fetchImpl = (async () => psResponse([{ model: 'qwen3:4b', context_length: 4096 }])) as unknown as typeof fetch;
    expect(await chooseOllamaNumCtx({ baseUrl: base, model: 'qwen3:4b', promptTokens: 12_000, maxTokens: 1024, fetchImpl })).toBe(neededNumCtx(12_000, 1024));
  });

  it('still answers when /api/ps fails', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await chooseOllamaNumCtx({ baseUrl: base, model: 'm', promptTokens: 100, maxTokens: 10, fetchImpl })).toBe(OLLAMA_CTX_MIN);
  });
});

describe('loadedContextLength', () => {
  it('matches an untagged name to :latest', async () => {
    const fetchImpl = (async () => psResponse([{ name: 'llama3.1:latest', model: 'llama3.1:latest', context_length: 8192 }])) as unknown as typeof fetch;
    expect(await loadedContextLength('http://h', 'llama3.1', fetchImpl)).toBe(8192);
    expect(await loadedContextLength('http://h', 'llama3.1:8b', fetchImpl)).toBeNull();
  });
  it('null for an Ollama too old to report context_length', async () => {
    const fetchImpl = (async () => psResponse([{ name: 'llama3.1:latest' }])) as unknown as typeof fetch;
    expect(await loadedContextLength('http://h', 'llama3.1', fetchImpl)).toBeNull();
  });
});
