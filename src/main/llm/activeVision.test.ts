/**
 * 261010: activeLlmVision (the llm:capability push + the Draw!/backseat start
 * gates) asks a local Ollama for its model's real capabilities instead of
 * trusting the name, which locked qwen2.5vl/gemma3 users out of every image
 * surface with "Your current model does not support vision".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cfg = { current: {} as Record<string, unknown> };
vi.mock('../configStore', () => ({ loadConfig: async () => cfg.current }));
vi.mock('../apiKeyStore', () => ({
  getAiBackendKind: async () => 'local',
  hasApiKey: async () => false,
  loadApiKey: async () => '',
}));

import { activeLlmVision } from './index';
import { clearOllamaVisionCache } from './ollamaCapabilities';

const fetchMock = vi.fn();
beforeEach(() => {
  clearOllamaVisionCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('activeLlmVision on Ollama', () => {
  it("uses /api/show at the configured base URL", async () => {
    cfg.current = { provider: 'ollama', provider_config: { ollama: { model: 'qwen2.5vl:3b', base_url: 'http://box:11434' } } };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ capabilities: ['completion', 'vision'] }) });
    expect(await activeLlmVision()).toBe('yes');
    expect(fetchMock.mock.calls[0][0]).toBe('http://box:11434/api/show');
  });

  it('a model Ollama reports without vision is a confident no', async () => {
    cfg.current = { provider: 'ollama', provider_config: { ollama: { model: 'qwen2.5:0.5b' } } };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ capabilities: ['completion', 'tools'] }) });
    expect(await activeLlmVision()).toBe('no');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/show');
  });

  it('Ollama down: the name heuristic, never a blanket no', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    cfg.current = { provider: 'ollama', provider_config: { ollama: { model: 'gemma3:4b' } } };
    expect(await activeLlmVision()).toBe('yes');
    cfg.current = { provider: 'ollama', provider_config: { ollama: { model: 'some-new-model' } } };
    expect(await activeLlmVision()).toBe('unknown');
  });
});
