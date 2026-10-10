/**
 * 261011: Draw! aborted its own calls at a fixed 30s/60s, which bypassed the
 * provider timeout floors; on local Ollama every guess and drawing was cut off
 * before the model answered (verified live on qwen2.5vl:3b). providerTimeoutMs
 * gives a caller-side abort timer the same floor the provider applies.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../configStore', () => ({ loadConfig: async () => ({}) }));
vi.mock('../apiKeyStore', () => ({
  getAiBackendKind: async () => 'local',
  hasApiKey: async () => false,
  loadApiKey: async () => '',
}));

import { providerTimeoutMs } from './index';
import { LOCAL_TIMEOUT_FLOOR_MS } from './ollama';
import { effectiveTimeoutMs as openaiCompatTimeoutMs } from './openaiCompat';

describe('providerTimeoutMs', () => {
  it('raises a short caller deadline to the Ollama local floor', () => {
    expect(providerTimeoutMs({ kind: 'ollama' }, 30_000)).toBe(LOCAL_TIMEOUT_FLOOR_MS);
    expect(providerTimeoutMs({ kind: 'ollama' }, 60_000)).toBe(LOCAL_TIMEOUT_FLOOR_MS);
  });

  it('keeps a deadline already above the floor', () => {
    expect(providerTimeoutMs({ kind: 'ollama' }, LOCAL_TIMEOUT_FLOOR_MS + 5_000)).toBe(LOCAL_TIMEOUT_FLOOR_MS + 5_000);
  });

  it('leaves Anthropic (cloud and BYOK) and Gemini unchanged', () => {
    expect(providerTimeoutMs({ kind: 'anthropic' }, 30_000)).toBe(30_000);
    expect(providerTimeoutMs({ kind: 'gemini' }, 30_000)).toBe(30_000);
  });

  it('applies the OpenAI-compatible first-token floors', () => {
    expect(providerTimeoutMs({ kind: 'deepseek' }, 20_000)).toBe(openaiCompatTimeoutMs('deepseek', 20_000));
    expect(providerTimeoutMs({ kind: 'openai' }, 20_000)).toBe(20_000);
  });
});
