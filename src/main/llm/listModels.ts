/**
 * llm:list-models + llm:test backing (china-compat W1).
 *
 * listProviderModels: live model listing with the user's own key — Anthropic
 * GET /v1/models, the OpenAI-compat set GET {base}/models, Gemini ListModels,
 * Ollama GET /api/tags — merged with the catalog's modelVision verdicts.
 * 10s timeout; typed error strings, never a raw throw.
 *
 * testProvider: a 1-token "hi" completion through the layer itself, so what
 * the test exercises is exactly what every surface will run.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  OPENAI_COMPAT_BASE_URLS,
  modelVision,
  type ProviderKind,
  type VisionVerdict,
} from '../../shared/llmCatalog';
import { hasApiKey, loadApiKey } from '../apiKeyStore';
import { loadConfig } from '../configStore';
import { buildLocalProviderFor, resolveLocalModel } from './index';
import { createAnthropicTestProvider } from './anthropicTest';

const LIST_TIMEOUT_MS = 10_000;

export interface ListedModel {
  id: string;
  vision: VisionVerdict;
}
export interface ListModelsResult {
  models: ListedModel[];
  error?: string;
}
export type TestResult = { ok: true; latencyMs: number } | { ok: false; error: string };

function typedError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  const msg = String(e?.message ?? err ?? '');
  if (e?.name === 'AbortError' || /abort/i.test(msg)) return 'timeout';
  const status = /\b(\d{3})\b/.exec(msg)?.[1];
  if (status === '401' || status === '403') return 'unauthorized';
  if (status) return `http_${status}`;
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(msg)) return 'network';
  return 'unknown';
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) throw new Error(`list ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function providerBaseUrl(provider: ProviderKind): Promise<string | undefined> {
  try {
    const cfg = await loadConfig();
    const entry = (cfg.provider_config as Record<string, unknown> | undefined)?.[provider];
    const override =
      entry && typeof entry === 'object' && typeof (entry as { base_url?: unknown }).base_url === 'string'
        ? ((entry as { base_url: string }).base_url.trim() || undefined)
        : undefined;
    return override ?? OPENAI_COMPAT_BASE_URLS[provider];
  } catch {
    return OPENAI_COMPAT_BASE_URLS[provider];
  }
}

export async function listProviderModels(provider: ProviderKind): Promise<ListModelsResult> {
  try {
    let ids: string[] = [];
    if (provider === 'ollama') {
      const base = (await providerBaseUrl(provider)) ?? 'http://localhost:11434';
      const data = (await fetchJson(`${base}/api/tags`, {})) as { models?: Array<{ name?: string }> };
      ids = (data?.models ?? []).map((m) => m?.name ?? '').filter(Boolean);
    } else if (provider === 'gemini') {
      if (!(await hasApiKey())) return { models: [], error: 'no_api_key' };
      const key = await loadApiKey();
      const data = (await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`,
        {},
      )) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
      ids = (data?.models ?? [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => (m?.name ?? '').replace(/^models\//, ''))
        .filter(Boolean);
    } else if (provider === 'anthropic') {
      if (!(await hasApiKey())) return { models: [], error: 'no_api_key' };
      const key = await loadApiKey();
      const data = (await fetchJson('https://api.anthropic.com/v1/models?limit=100', {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      })) as { data?: Array<{ id?: string }> };
      ids = (data?.data ?? []).map((m) => m?.id ?? '').filter(Boolean);
    } else {
      // The OpenAI-compatible family.
      if (!(await hasApiKey())) return { models: [], error: 'no_api_key' };
      const key = await loadApiKey();
      const base = await providerBaseUrl(provider);
      if (!base) return { models: [], error: 'unknown' };
      const data = (await fetchJson(`${base}/models`, { authorization: `Bearer ${key}` })) as {
        data?: Array<{ id?: string }>;
      };
      ids = (data?.data ?? []).map((m) => m?.id ?? '').filter(Boolean);
    }
    return { models: ids.map((id) => ({ id, vision: modelVision(provider, id) })) };
  } catch (err) {
    return { models: [], error: typedError(err) };
  }
}

export async function testProvider(provider: ProviderKind, model: string): Promise<TestResult> {
  try {
    if (provider === 'anthropic') {
      // Direct 1-token probe with the BYOK key (maxRetries 0 so a bad key
      // answers fast). The chat path proper still rides buildChatSdk.
      if (!(await hasApiKey())) return { ok: false, error: 'no_api_key' };
      const client = new Anthropic({ apiKey: await loadApiKey(), maxRetries: 0 });
      const t0 = Date.now();
      await client.messages.create(
        { model: model || 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
        { timeout: LIST_TIMEOUT_MS },
      );
      return { ok: true, latencyMs: Date.now() - t0 };
    }
    const cfg = await loadConfig();
    const p = await buildLocalProviderFor(provider, model || resolveLocalModel(cfg, provider));
    const t0 = Date.now();
    await p.call({
      maxTokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: LIST_TIMEOUT_MS,
    });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err ?? '');
    if (msg.includes('LOCAL_NO_API_KEY')) return { ok: false, error: 'no_api_key' };
    return { ok: false, error: typedError(err) };
  }
}
